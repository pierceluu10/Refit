import type { Repository, SourceEdit } from './types.ts';
import { STRIPE, type ProviderAdapter } from './providers.ts';

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
  findingCount: number,
  provider: ProviderAdapter = STRIPE,
) {
  return {
    generator: 'deterministic' as const,
    summary:
      provider === STRIPE
        ? 'Replace direct charge-list returns with a Charges API request filtered by PaymentIntent ID.'
        : 'No deterministic migration rule is registered for this provider.',
    status: edits.length ? 'proposed' : 'unsupported',
    edits: edits.length,
    unresolvedFindings: findingCount - edits.length,
    diff: renderPatch(repository, edits),
    validation: 'not-run',
    warnings:
      provider !== STRIPE
        ? [
            'No deterministic migration rule is registered. Use a reviewed AI proposal or migrate manually.',
          ]
        : [
            'Review required: adds a Charges list request using default pagination; timing, expansion and error behavior can differ.',
            'Only direct returns of charges.data from a local PaymentIntent retrieve with one argument are supported. Request options, aliases and other shapes require review.',
            'Patch contains source code. Review it for sensitive content before sharing.',
          ],
    source: provider === STRIPE ? 'https://docs.stripe.com/api/charges/list' : null,
  };
}
