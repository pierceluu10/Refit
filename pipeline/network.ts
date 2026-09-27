import { PipelineInputError } from './types.ts';

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
