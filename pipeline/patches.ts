import type { Finding, Repository, SourceEdit } from './types.ts';
import { STRIPE, type ProviderAdapter } from './providers.ts';
import type { OperationReplacement } from './provider-operation-replacements.ts';
import type { RequestPropertyRename } from './provider-request-renames.ts';
import {
  INVOICE_SUBSCRIPTION_HELPER_RULE,
  SUBSCRIPTION_PERIOD_HELPER_RULE,
  SUBSCRIPTION_PERIOD_RULE,
} from './stripe-subscription-periods.ts';

const FIELD_MOVE_SOURCES: Partial<Record<NonNullable<SourceEdit['rule']>, string>> = {
  [SUBSCRIPTION_PERIOD_HELPER_RULE]:
    'https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end',
  [INVOICE_SUBSCRIPTION_HELPER_RULE]:
    'https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects',
};

export function isFieldMove(edit: SourceEdit) {
  return Boolean(edit.rule && FIELD_MOVE_SOURCES[edit.rule]);
}

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
  const usedSubscriptionPolicy = edits.some((edit) => edit.rule === SUBSCRIPTION_PERIOD_RULE);
  const fieldMoves = edits.filter(isFieldMove);
  if (
    fieldMoves.length &&
    !usedSubscriptionPolicy &&
    !usedRequestRename &&
    !usedEndpointReplacement
  )
    return {
      generator: 'deterministic' as const,
      summary:
        'Move removed Stripe field reads to their documented new locations and update the pinned Stripe API version.',
      status: 'proposed' as const,
      edits: edits.length,
      unresolvedFindings,
      diff: renderPatch(repository, edits),
      validation: 'not-run',
      warnings: [
        ...(fieldMoves.some((edit) => edit.rule === SUBSCRIPTION_PERIOD_HELPER_RULE)
          ? [
              'Subscription periods are read through a generated helper: the old subscription-level field when present (old-version events), otherwise the period every item shares, otherwise the item the application already selects or the configured price policy. Webhook endpoints are not changed.',
            ]
          : []),
        ...(fieldMoves.some((edit) => edit.rule === INVOICE_SUBSCRIPTION_HELPER_RULE)
          ? [
              'Invoice subscriptions are read through a generated helper: the old invoice.subscription field when present (old-version events), otherwise invoice.parent.subscription_details.subscription. Webhook endpoints are not changed.',
            ]
          : []),
        'The stripe package is not upgraded. TypeScript projects may need the stripe package version matching the new API version before they typecheck.',
        'Patch contains source code. Review it for sensitive content before sharing.',
      ],
      source: FIELD_MOVE_SOURCES[fieldMoves[0].rule!]!,
    };
  return {
    generator: 'deterministic' as const,
    summary: usedSubscriptionPolicy
      ? 'Preserve historical subscription periods and select new item periods by the configured price ID, with signed-event version and complete-list checks.'
      : usedRequestRename
        ? 'Rename configured SDK request fields while preserving argument values and other call options.'
        : provider.id === STRIPE.id
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
    warnings: usedSubscriptionPolicy
      ? [
          'The price ID and incoming versions are operator-approved policy. Review the entitlement meaning for subscriptions with several prices.',
          'The proposal checks each signed event api_version, preserves legacy field validation and uses the existing missing-period error for unsupported versions, missing/duplicate prices, incomplete lists and malformed periods.',
          'No additional API calls, SDK upgrade or webhook endpoint configuration changes are made. Other incoming versions require a new reviewed migration.',
          'AI generation and repair are disabled for this configured policy. Passing checks does not establish production behavior.',
          'Patch contains source code. Review it for sensitive content before sharing.',
        ]
      : usedRequestRename
        ? [
            'Request field mappings are operator-authored. Matching recorded contracts do not prove equivalent business meaning or SDK serialization behavior.',
            'Only direct object-literal body arguments on immutable, unescaped SDK clients are edited. Spreads, computed keys, duplicate properties, aliases and optional SDK calls require review.',
            'SDK dependencies and API-version declarations remain unchanged; verify that the installed SDK accepts the replacement field and coordinate the API rollout.',
            'AI generation and repair are not used for configured request-field migrations. Review all edits and meaningful before/after checks.',
            'Patch contains source code. Review it for sensitive content before sharing.',
          ]
        : provider.id === STRIPE.id
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
    source: usedSubscriptionPolicy
      ? 'https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end'
      : provider.id === STRIPE.id
        ? 'https://docs.stripe.com/api/charges/list'
        : null,
  };
}
