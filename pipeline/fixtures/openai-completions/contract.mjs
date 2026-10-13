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

const retiredModelIds = mode === 'live' ? [] : ['fixture-openai-retired-model'];
const provider = createFakeProviderServer({ retiredModelIds });

try {
  process.env.REFIT_OPENAI_BASE_URL = `${await provider.listen()}/v1`;
  const direct = await import(pathToFileURL(resolve(repository, 'direct.js')).href);
  const wrapped = await import(pathToFileURL(resolve(repository, 'wrapped.js')).href);
  const variable = await import(pathToFileURL(resolve(repository, 'variable.js')).href);

  if (mode !== 'live') {
    await direct.directCompletion();
    if (mode === 'retired') throw new Error('The retired model unexpectedly completed.');
    console.log(JSON.stringify({ results: ['fixture completion'], requests: provider.requests }));
  } else {
    const results = await Promise.all([
      direct.directCompletion(),
      wrapped.wrappedCompletion(),
      variable.variableCompletion(),
    ]);
    console.log(JSON.stringify({ results, requests: provider.requests }));
  }
} catch (error) {
  console.error(
    JSON.stringify({
      name: error?.name,
      status: error?.status,
      code: error?.code,
      message: error?.message,
      requests: provider.requests,
    }),
  );
  process.exitCode = 1;
} finally {
  await provider.close();
}
