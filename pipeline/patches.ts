import type { Repository, SourceEdit } from './types.ts';
import { STRIPE, type ProviderAdapter } from './providers.ts';
import type { OperationReplacement } from './provider-operation-replacements.ts';

function lines(content: string, prefix: string) {
  const terminated = content.endsWith('\n');
  const values = content.split('\n');
  if (terminated) values.pop();
  const output = values.map((line) => `${prefix}${line}\n`).join('');
  return output + (terminated ? '' : '\\ No newline at end of file\n');
}

export function applySourceEdits(content: string, edits: SourceEdit[]) {
  let updated = content;
  for (const edit of [...edits].sort((a, b) => b.start - a.start))
    updated = updated.slice(0, edit.start) + edit.replacement + updated.slice(edit.end);
  return updated;
}

export function renderPatch(repository: Repository, edits: SourceEdit[]) {
  const patches: string[] = [];
  for (const file of repository.files) {
    const changes = edits
      .filter((edit) => edit.file === file.path)
      .sort((a, b) => b.start - a.start);
    if (!changes.length) continue;
    const updated = applySourceEdits(file.content, changes);
    const count = (content: string) => content.split('\n').length - Number(content.endsWith('\n'));
    const oldPath = JSON.stringify(`a/${file.path}`);
    const newPath = JSON.stringify(`b/${file.path}`);
    patches.push(
      `diff --git ${oldPath} ${newPath}\n--- ${oldPath}\n+++ ${newPath}\n` +
        `@@ -1,${count(file.content)} +1,${count(updated)} @@\n` +
        lines(file.content, '-') +
        lines(updated, '+'),
    );
  }
  return patches.join('');
}

export function proposePatch(
  repository: Repository,
  edits: SourceEdit[],
  unresolvedFindings: number,
  provider: ProviderAdapter = STRIPE,
  operationReplacements: OperationReplacement[] = [],
) {
  const hasConfiguredRenames = Boolean(provider.propertyRenames?.length);
  const replacementIds = new Set(operationReplacements.map((replacement) => replacement.id));
  const usedConfiguredRename =
    provider !== STRIPE &&
    hasConfiguredRenames &&
    edits.some((edit) => !replacementIds.has(edit.changeId));
  const usedEndpointReplacement = edits.some((edit) => replacementIds.has(edit.changeId));
  return {
    generator: 'deterministic' as const,
    summary:
      provider === STRIPE
        ? 'Replace supported charge-history reads with Charges API requests filtered by PaymentIntent ID.'
        : usedEndpointReplacement
          ? usedConfiguredRename
            ? 'Replace retired SDK methods and removed API fields using configured mappings.'
            : 'Replace retired SDK methods using configured endpoint mappings while preserving call arguments.'
          : usedConfiguredRename
            ? 'Replace removed API fields using the configured response-property mappings.'
            : hasConfiguredRenames
              ? 'No configured property rename matched a supported source read.'
              : 'No deterministic migration rule is registered for this provider.',
    status: edits.length ? 'proposed' : 'unsupported',
    edits: edits.length,
    unresolvedFindings,
    diff: renderPatch(repository, edits),
    validation: 'not-run',
    warnings:
      provider === STRIPE
        ? [
            'Review required: adds Charges API requests; timing, expansion and error behavior can differ. Direct-return migrations retain default-page behavior; guarded-history migrations iterate all pages.',
            'Supports direct local charges.data returns and narrow missing-history guards after a local or transparent wrapped retrieve. Guarded migrations remove the missing-field error branch and retain the initial retrieval. Request options, transformed wrappers, aliases and other shapes require review.',
            'Patch contains source code. Review it for sensitive content before sharing.',
          ]
        : usedEndpointReplacement
          ? [
              'Endpoint mappings are operator-authored. Equal recorded request/response, server and security contracts do not prove equivalent meaning or SDK argument behavior.',
              'Only direct calls on immutable, unescaped SDK clients are changed. The replacement SDK method must already be available; dependencies and call arguments are unchanged.',
              'Coordinate the API-version rollout with this call-site migration; it does not update client version configuration.',
              'AI patch generation and repair are not used for configured endpoint replacements. Review all mappings and run meaningful old/new application checks.',
              'Patch contains source code. Review it for sensitive content before sharing.',
            ]
          : usedConfiguredRename
            ? [
                'The field mapping is operator-authored. Matching scalar types do not prove equivalent meaning; verify API-version applicability and migration semantics.',
                'Only direct property reads are changed. Review application checks and behavior such as nullability, formatting, pagination and errors.',
                'Patch contains source code. Review it for sensitive content before sharing.',
              ]
            : hasConfiguredRenames
              ? [
                  'Configured renames only change direct property reads on statically traced responses. String indexes, destructuring and unsupported source shapes require review.',
                  'Patch contains source code. Review it for sensitive content before sharing.',
                ]
              : [
                  'No deterministic migration rule is registered. Use a reviewed AI proposal or migrate manually.',
                  'Patch contains source code. Review it for sensitive content before sharing.',
                ],
    source: provider === STRIPE ? 'https://docs.stripe.com/api/charges/list' : null,
  };
}
