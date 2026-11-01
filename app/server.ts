import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { handleWebhook, verifySignature } from './webhooks.ts';
import type { WebhookDeps } from './webhooks.ts';

// GitHub caps webhook payloads at 25 MB.
export const MAX_BODY_BYTES = 25 * 1024 * 1024;
const WEBHOOK_PATH = '/webhooks';
const HEALTH_PATH = '/healthz';
const OK = 200;
const ACCEPTED = 202;
const BAD_REQUEST = 400;
const UNAUTHORIZED = 401;
const NOT_FOUND = 404;
const PAYLOAD_TOO_LARGE = 413;
const SERVER_ERROR = 500;

export type WebhookServerDeps = WebhookDeps & { webhookSecret: string; maxBodyBytes?: number };

// Returns undefined when the body exceeds the cap; it keeps draining so the 413 can still be sent.
async function readBody(request: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= limit) chunks.push(chunk);
  }
  return size <= limit ? Buffer.concat(chunks) : undefined;
}

const header = (request: IncomingMessage, name: string) => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

async function receiveWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  deps: WebhookServerDeps,
) {
  const body = await readBody(request, deps.maxBodyBytes ?? MAX_BODY_BYTES);
  if (!body) return response.writeHead(PAYLOAD_TOO_LARGE).end();
  if (!verifySignature(deps.webhookSecret, body, header(request, 'x-hub-signature-256'))) {
    return response.writeHead(UNAUTHORIZED).end();
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return response.writeHead(BAD_REQUEST).end();
  }
  const event = header(request, 'x-github-event') ?? '';
  try {
    await handleWebhook(event, payload, deps);
    response.writeHead(ACCEPTED).end();
  } catch (error) {
    // GitHub can redeliver, so report the failure rather than swallow it.
    const delivery = header(request, 'x-github-delivery');
    const message = error instanceof Error ? error.message : String(error);
    console.error(`webhook ${event} ${delivery} failed: ${message}`);
    response.writeHead(SERVER_ERROR).end();
  }
}

export function createWebhookServer(deps: WebhookServerDeps): Server {
  return createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method === 'POST' && path === WEBHOOK_PATH) {
      receiveWebhook(request, response, deps).catch((error: Error) => {
        console.error(`webhook request failed: ${error.message}`);
        if (!response.headersSent) response.writeHead(SERVER_ERROR);
        response.end();
      });
      return;
    }
    if (request.method === 'GET' && path === HEALTH_PATH) return response.writeHead(OK).end();
    response.writeHead(NOT_FOUND).end();
  });
}
