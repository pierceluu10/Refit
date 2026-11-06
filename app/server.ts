import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Route } from './parts.ts';
import { runsFor } from './runs.ts';
import type { RunsDeps } from './runs.ts';
import { handleWebhook, verifySignature } from './webhooks.ts';
import type { WebhookDeps } from './webhooks.ts';

// GitHub caps webhook payloads at 25 MB.
export const MAX_BODY_BYTES = 25 * 1024 * 1024;
const WEBHOOK_PATH = '/webhooks';
const HEALTH_PATH = '/healthz';
const RUNS_PATH = '/api/runs';
const OK = 200;
const ACCEPTED = 202;
const BAD_REQUEST = 400;
const UNAUTHORIZED = 401;
const NOT_FOUND = 404;
const PAYLOAD_TOO_LARGE = 413;
const SERVER_ERROR = 500;

export type WebhookServerDeps = WebhookDeps &
  RunsDeps & {
    webhookSecret: string;
    maxBodyBytes?: number;
    routes?: Route[]; // the report and audit APIs
  };

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
  // GitHub gives a delivery 10 seconds, so answer first; jobs and verdicts can take minutes.
  response.writeHead(ACCEPTED).end();
  try {
    await handleWebhook(event, payload, deps);
  } catch (error) {
    // Already answered, so log the delivery id: it can be redelivered from the App's Advanced page.
    const delivery = header(request, 'x-github-delivery');
    const message = error instanceof Error ? error.message : String(error);
    console.error(`webhook ${event} ${delivery} failed: ${message}`);
  }
}

const sendJson = (response: ServerResponse, status: number, body: unknown) =>
  response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

async function serveRuns(
  request: IncomingMessage,
  response: ServerResponse,
  deps: WebhookServerDeps,
) {
  const query = new URL(request.url ?? '/', 'http://localhost').searchParams;
  const result = await runsFor(query, header(request, 'authorization'), deps);
  if (result.status === UNAUTHORIZED) return response.writeHead(UNAUTHORIZED).end();
  if (result.status === BAD_REQUEST)
    return sendJson(response, BAD_REQUEST, { error: result.error });
  sendJson(response, OK, result.runs);
}

async function serveRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  routes: Route[],
): Promise<void> {
  for (const route of routes) if (await route(request, response)) return;
  response.writeHead(NOT_FOUND).end();
}

export function createWebhookServer(deps: WebhookServerDeps): Server {
  return createServer((request, response) => {
    const answer = (label: string, work: Promise<unknown>) => {
      work.catch((error: Error) => {
        console.error(`${label} request failed: ${error.message}`);
        if (!response.headersSent) response.writeHead(SERVER_ERROR);
        response.end();
      });
    };
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method === 'POST' && path === WEBHOOK_PATH) {
      return answer('webhook', receiveWebhook(request, response, deps));
    }
    if (request.method === 'GET' && path === HEALTH_PATH) return response.writeHead(OK).end();
    // Same-origin only: the dashboard is served beside the app, so no CORS headers.
    if (request.method === 'GET' && path === RUNS_PATH) {
      return answer('runs', serveRuns(request, response, deps));
    }
    answer(`${request.method} ${path}`, serveRoutes(request, response, deps.routes ?? []));
  });
}
