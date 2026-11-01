import { createTwoFilesPatch } from 'diff';
import { PipelineInputError, type Finding, type Repository, type SourceEdit } from './types.ts';
import { STRIPE, type ProviderAdapter } from './providers.ts';
import type { OperationReplacement } from './provider-operation-replacements.ts';
import type { RequestPropertyRename } from './provider-request-renames.ts';

// Source: Stripe changelog, 2026-09-30.endive, read 2026-10-22.
export const PAYMENT_METHOD_TYPES_CHANGELOG =
  'https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions';

// Whether a finding's source position lies inside one of the edits.
export function editCovers(repository: Repository, edits: SourceEdit[], finding: Finding) {
  const content = repository.files.find((file) => file.path === finding.file)?.content;
  if (content === undefined) return false;
  const offset =
    content
      .split('\n')
      .slice(0, finding.line - 1)
      .reduce((size, line) => size + line.length + 1, 0) +
    finding.column -
    1;
  return edits.some(
    (edit) => edit.file === finding.file && edit.start <= offset && offset < edit.end,
  );
}

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

// A patch replacing whole files, such as package.json and its lockfile in an SDK upgrade.
export function renderFileReplacements(
  repository: Repository,
  files: { path: string; before: string; after: string }[],
  changeId: string,
) {
  return renderPatch(
    { ...repository, files: files.map((file) => ({ path: file.path, content: file.before })) },
    files.map((file) => ({
      file: file.path,
      start: 0,
      end: file.before.length,
      replacement: file.after,
      changeId,
    })),
  );
}

export function renderPatch(repository: Repository, edits: SourceEdit[]) {
  const patches: string[] = [];
  for (const file of repository.files) {
    const changes = edits
      .filter((edit) => edit.file === file.path)
      .sort((a, b) => b.start - a.start);
    if (!changes.length) continue;
    if (file.encoding)
      throw new PipelineInputError(
        `${file.path} is UTF-16; Refit only edits UTF-8 source files. Migrate it manually.`,
      );
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
  // Edits to paths the repository does not contain create new files.
  const created = [...new Set(edits.map((edit) => edit.file))].filter(
    (path) => !repository.files.some((file) => file.path === path),
  );
  for (const path of created.sort()) {
    const content = applySourceEdits(
      '',
      edits.filter((edit) => edit.file === path),
    );
    const newPath = JSON.stringify(`b/${path}`);
    patches.push(
      `diff --git ${JSON.stringify(`a/${path}`)} ${newPath}\nnew file mode 100644\n--- /dev/null\n+++ ${newPath}\n` +
        `@@ -0,0 +1,${content.split('\n').length - Number(content.endsWith('\n'))} @@\n` +
        lines(content, '+'),
    );
  }
  return patches.join('');
}

// A renderPatch diff with only changed lines and three lines of context, for AI repair evidence:
// whole-file hunks repeat every edited file twice and overflow the input limit.
export function compactPatch(diff: string) {
  return diff
    .split(/(?=^diff --git )/m)
    .filter(Boolean)
    .map((section) => {
      const header = /^\+\+\+ ("b\/.+")$/m.exec(section);
      if (!header) return section;
      const body = section.slice(header.index + header[0].length + 1).split('\n');
      const text = (prefix: string) => {
        const values: string[] = [];
        let terminated = true;
        for (const [index, line] of body.entries())
          if (line.startsWith(prefix)) values.push(line.slice(1));
          else if (line.startsWith('\\ ') && body[index - 1]?.startsWith(prefix))
            terminated = false;
        return values.length ? `${values.join('\n')}${terminated ? '\n' : ''}` : '';
      };
      const path = JSON.parse(header[1]) as string;
      return createTwoFilesPatch(path.replace(/^b\//, 'a/'), path, text('-'), text('+'), '', '', {
        context: 3,
      });
    })
    .join('');
}

export function proposePatch(
  repository: Repository,
  edits: SourceEdit[],
  unresolvedFindings: number,
  provider: ProviderAdapter = STRIPE,
  operationReplacements: OperationReplacement[] = [],
  requestRenames: RequestPropertyRename[] = [],
) {
  const hasConfiguredRenames = Boolean(provider.propertyRenames?.length);
  const replacementIds = new Set(operationReplacements.map((replacement) => replacement.id));
  const requestIds = new Set(requestRenames.map((rename) => rename.id));
  const usedRequestRename = edits.some((edit) => requestIds.has(edit.changeId));
  const usedConfiguredRename =
    provider.id !== STRIPE.id &&
    hasConfiguredRenames &&
    edits.some((edit) => !replacementIds.has(edit.changeId) && !requestIds.has(edit.changeId));
  const usedEndpointReplacement = edits.some((edit) => replacementIds.has(edit.changeId));
  return {
    generator: 'deterministic' as const,
    summary: usedRequestRename
      ? 'Rename configured SDK request fields while preserving argument values and other call options.'
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
    warnings: usedRequestRename
      ? [
          'Request field mappings are operator-authored. Matching recorded contracts do not prove equivalent business meaning or SDK serialization behavior.',
          'Only direct object-literal body arguments on immutable, unescaped SDK clients are edited. Spreads, computed keys, duplicate properties, aliases and optional SDK calls require review.',
          'SDK dependencies and API-version declarations remain unchanged; verify that the installed SDK accepts the replacement field and coordinate the API rollout.',
          'AI generation and repair are not used for configured request-field migrations. Review all edits and meaningful before/after checks.',
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
              'The field mapping is operator-authored. Matching recorded types or shapes do not prove equivalent meaning; verify API-version applicability and migration semantics.',
              'Only direct property reads are changed. Nested moves use optional chaining with a null fallback where the recorded contract allows a missing parent; expandable moves stop for review when a request expands the old field. Review application checks and behavior such as nullability, formatting, pagination and errors.',
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
    source: null,
  };
}
