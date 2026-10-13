import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runDeprecationPipeline } from './deprecated-models.ts';
import { PipelineInputError } from './types.ts';

export const openAiReplayFixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

export async function runAiReplay(options: { proposePatch?: boolean } = {}) {
  const packageMetadata = JSON.parse(
    await readFile(openAiReplayFixture('openai-completions/repository/package.json'), 'utf8'),
  ) as { dependencies?: { openai?: unknown } };
  const sdkVersion = packageMetadata.dependencies?.openai;
  if (typeof sdkVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(sdkVersion))
    throw new PipelineInputError(
      'The bundled OpenAI replay fixture must pin an exact SDK version.',
    );

  const report = await runDeprecationPipeline({
    repository: openAiReplayFixture('openai-completions/repository'),
    providerConfig: openAiReplayFixture('openai/provider.json'),
    snapshot: openAiReplayFixture('openai/deprecation-snapshot.json'),
    proposePatch: options.proposePatch,
  });
  return { ...report, sdkVersion };
}
