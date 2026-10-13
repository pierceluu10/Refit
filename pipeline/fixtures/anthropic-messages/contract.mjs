import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFakeProviderServer } from '../provider-api/server.mjs';

const [repository, mode] = process.argv.slice(2);
assert.ok(repository, 'A fixture repository path is required.');
assert.ok(
  mode === 'live' || mode === 'retired' || mode === 'patched',
  'Mode must be live, retired, or patched.',
);

const retiredModelIds = mode === 'live' ? [] : ['fixture-anthropic-retired-model'];
const provider = createFakeProviderServer({ retiredModelIds });

try {
  process.env.REFIT_ANTHROPIC_BASE_URL = await provider.listen();
  const fixture = await import(pathToFileURL(resolve(repository, 'message.js')).href);
  const result = await fixture.createMessage();
  if (mode === 'retired') throw new Error('The retired model unexpectedly completed.');
  console.log(JSON.stringify({ result, requests: provider.requests }));
} catch (error) {
  console.error(
    JSON.stringify({
      name: error?.name,
      status: error?.status,
      errorType: error?.error?.error?.type,
      message: error?.message,
      requests: provider.requests,
    }),
  );
  process.exitCode = 1;
} finally {
  await provider.close();
}
