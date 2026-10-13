import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { assessmentConfiguration } from './assessment.ts';
import { suggestProviderAdapter } from './adapter-suggestions.ts';
import { validateProviderIdentity } from './providers.ts';
import { PipelineInputError } from './types.ts';

const USAGE =
  'Usage: refit adapter-suggest --repository <directory> --spec <openapi.json-or-yaml> --id <provider-id> --package <npm-package> (--default-import | --export <client-constructor>) --output <new-adapter.json> [--operation-id <id> ...] [--json]';

try {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      spec: { type: 'string' },
      id: { type: 'string' },
      package: { type: 'string' },
      'default-import': { type: 'boolean' },
      export: { type: 'string' },
      'operation-id': { type: 'string', multiple: true },
      output: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(USAGE);
  else {
    if (!values.repository || !values.spec || !values.id || !values.package || !values.output)
      throw new PipelineInputError(`Missing adapter-suggestion inputs.\n${USAGE}`);
    if (Boolean(values['default-import']) === Boolean(values.export))
      throw new PipelineInputError(
        'Choose exactly one of --default-import or --export <client-constructor>.',
      );
    const identity = validateProviderIdentity({
      id: values.id,
      packageName: values.package,
      defaultImport: values['default-import'] ?? false,
      namedExport: values.export ?? null,
    });
    const result = await suggestProviderAdapter({
      repositoryPath: values.repository,
      specificationPath: values.spec,
      identity,
      operationIds: values['operation-id'],
      ai: assessmentConfiguration(true, process.env)!,
    });
    const adapterPath = values.output;
    await writeFile(adapterPath, `${JSON.stringify(result.adapter, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    if (values.json) {
      console.log(JSON.stringify({ adapterPath, ...result }, null, 2));
    } else {
      console.log(`Adapter proposal saved: ${adapterPath}`);
      console.log(
        `Mapped ${result.mappedMethodCount} of ${result.observedMethodCount} observed SDK methods from ${result.candidateOperationCount} contract operations.`,
      );
      console.log(`Model: ${result.model}; human review is required before use.`);
      if (result.budget)
        console.log(
          `AI budget: $${result.budget.spentUsd.toFixed(4)} recorded / $${result.budget.limitUsd.toFixed(2)} limit.`,
        );
      for (const mapping of result.mappedOperations)
        console.log(
          `  ${mapping.sdkMethod} → ${mapping.endpoint} (${mapping.operationId}, ${mapping.responseSchema}; ${mapping.observedCalls} calls)`,
        );
      if (result.unmappedMethods.length)
        console.log(
          `Unmapped SDK methods: ${result.unmappedMethods
            .slice(0, 5)
            .map((method) => `${method.resource}.${method.method} (${method.callCount} calls)`)
            .join(', ')}${result.unmappedMethods.length > 5 ? ', and more' : ''}`,
        );
      if (result.uncertainties.length) {
        const reviewNotes = result.uncertainties.slice(0, 5);
        console.log(`Review notes:\n${reviewNotes.map((note) => `- ${note}`).join('\n')}`);
        if (result.uncertainties.length > reviewNotes.length)
          console.log(
            `  and ${result.uncertainties.length - reviewNotes.length} more in --json output`,
          );
      }
      console.log(
        'The proposal validates identifiers against observed calls and OpenAPI responses; verify SDK semantics yourself.',
      );
    }
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
}
