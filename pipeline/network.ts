import { PipelineInputError } from './types.ts';

const TEMPORARY_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const TEMPORARY_NETWORK_CODES = new Set([
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export class SpecificationUnavailableError extends PipelineInputError {
  override name = 'SpecificationUnavailableError';
}

export async function fetchSpecificationResponse(
  url: string,
  options: RequestInit,
  sourceName = 'specification source',
) {
  let response: Response;
  try {
    response = await fetch(url, options);
  } catch (cause) {
    const underlying = cause instanceof Error ? cause.cause : undefined;
    if (
      (cause instanceof Error && cause.name === 'TimeoutError') ||
      (underlying instanceof Error &&
        'code' in underlying &&
        TEMPORARY_NETWORK_CODES.has(String(underlying.code)))
    )
      throw new SpecificationUnavailableError(`The ${sourceName} is temporarily unavailable.`, {
        cause,
      });
    throw cause;
  }
  if (TEMPORARY_HTTP_STATUSES.has(response.status)) {
    await response.body?.cancel();
    throw new SpecificationUnavailableError(`The ${sourceName} returned HTTP ${response.status}.`);
  }
  return response;
}

export async function readBoundedResponse(response: Response, maximumBytes: number, label: string) {
  if (!response.body) throw new PipelineInputError(`${label} response has no body.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new PipelineInputError(
          `${label} exceeds the download limit (${maximumBytes} bytes).`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}
