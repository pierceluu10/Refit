import { createTwoFilesPatch } from 'diff';
import { PipelineInputError, type Finding, type Repository, type SourceEdit } from './types.ts';
import { STRIPE, type ProviderAdapter } from './providers.ts';
import type { OperationReplacement } from './provider-operation-replacements.ts';
import type { RequestPropertyRename } from './provider-request-renames.ts';
import {
  CARD_PAYMENT_METHOD_RULE,
  LISTED_PAYMENT_METHODS_RULE,
  PAYMENT_METHOD_RENAME_RULES,
} from './request-removals.ts';
import {
  INVOICE_PRICE_ID_HELPER_RULE,
  CHECKOUT_SHIPPING_HELPER_RULE,
  COUPON_ID_HELPER_RULE,
  INVOICE_SUBSCRIPTION_HELPER_RULE,
  PRODUCT_FEATURES_HELPER_RULE,
  SUBSCRIPTION_PERIOD_HELPER_RULE,
  SUBSCRIPTION_PERIOD_RULE,
} from './stripe-subscription-periods.ts';
import {
  REQUEST_MOVE_RULES,
  REQUEST_MOVE_SOURCES,
  REQUEST_MOVE_WARNINGS,
} from './stripe-request-moves.ts';
import {
  INVOICE_PREVIEW_RULE,
  INVOICE_PREVIEW_SOURCE,
  INVOICE_PREVIEW_WARNING,
} from './stripe-invoice-preview.ts';

const FIELD_MOVE_SOURCES: Partial<Record<NonNullable<SourceEdit['rule']>, string>> = {
  [SUBSCRIPTION_PERIOD_HELPER_RULE]:
    'https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end',
  [INVOICE_SUBSCRIPTION_HELPER_RULE]:
    'https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects',
  [INVOICE_PRICE_ID_HELPER_RULE]:
    'https://docs.stripe.com/changelog/basil/2025-03-31/invoice-pricing-configurations',
  [CHECKOUT_SHIPPING_HELPER_RULE]:
    'https://docs.stripe.com/changelog/basil/2025-03-31/checkout-session-remove-shipping-details',
  [COUPON_ID_HELPER_RULE]:
    'https://docs.stripe.com/changelog/clover/2025-09-30/add-discount-source-property',
  [PRODUCT_FEATURES_HELPER_RULE]:
    'https://docs.stripe.com/changelog/2024-04-10/renames-features-attribute-product-object',
};

// Source: Stripe changelog, 2026-09-30.endive, read 2026-10-22.
export const PAYMENT_METHOD_TYPES_CHANGELOG =
  'https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions';

// The Stripe page behind each rule edit, with the files whose edits it documents.
function ruleSources(edits: SourceEdit[]) {
  const pages = new Map<string, Set<string>>();
  for (const edit of edits) {
    const url =
      FIELD_MOVE_SOURCES[edit.rule!] ??
      REQUEST_MOVE_SOURCES[edit.rule!] ??
      (edit.rule === INVOICE_PREVIEW_RULE
        ? INVOICE_PREVIEW_SOURCE
        : PAYMENT_METHOD_RENAME_RULES.has(edit.rule!)
          ? PAYMENT_METHOD_TYPES_CHANGELOG
          : undefined);
    if (url) pages.set(url, (pages.get(url) ?? new Set()).add(edit.file));
  }
  return [...pages].map(([url, files]) => ({ url, files: [...files] }));
}

export const CARD_PAYMENT_METHOD_WARNING =
  "payment_method_types: ['card'] becomes allowed_payment_method_types: ['card'] under the owner-approved policy. In 2026-09-30.endive it filters the payment methods Stripe finds eligible instead of listing them, so keep cards enabled in the Stripe Dashboard or the payment method configuration this account uses.";

// The methods a listed rename keeps: the literal array after the renamed property name.
export function listedPaymentMethods(content: string, edit: SourceEdit) {
  const list = /^\s*['"]?\s*:\s*\[([^\]]*)\]/.exec(content.slice(edit.end))?.[1] ?? '';
  return [...list.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

export function listedPaymentMethodWarning(methods: string[]) {
  const others = methods.filter((method) => method !== 'card');
  return `payment_method_types: [${methods.map((method) => `'${method}'`).join(', ')}] becomes allowed_payment_method_types with the same methods, because this repository set stripePaymentMethodTypes: "keep-listed" in .refit.json. In 2026-09-30.endive the list filters the payment methods Stripe finds eligible for each buyer instead of listing them, so ${others.join(', ')} may no longer be offered to some customers (by country, currency, amount or device). Check that ${others.length === 1 ? 'it is' : 'they are'} still offered where you rely on ${others.length === 1 ? 'it' : 'them'}, and keep every listed method enabled in the Stripe Dashboard or payment method configuration.`;
}

// Rule edits that ride with the API version bump: field moves, the reviewed payment method
// renames and the reviewed request parameter moves.
export function isFieldMove(edit: SourceEdit) {
  return Boolean(
    edit.rule &&
    (FIELD_MOVE_SOURCES[edit.rule] ||
      PAYMENT_METHOD_RENAME_RULES.has(edit.rule) ||
      REQUEST_MOVE_RULES.has(edit.rule) ||
      edit.rule === INVOICE_PREVIEW_RULE),
  );
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
  const usedSubscriptionPolicy = edits.some((edit) => edit.rule === SUBSCRIPTION_PERIOD_RULE);
  const fieldMoves = edits.filter(isFieldMove);
  const reads = fieldMoves.filter((edit) => FIELD_MOVE_SOURCES[edit.rule!]);
  const cardRename = fieldMoves.some((edit) => PAYMENT_METHOD_RENAME_RULES.has(edit.rule!));
  const requestMoves = [
    ...new Set(
      fieldMoves.filter((edit) => REQUEST_MOVE_RULES.has(edit.rule!)).map((edit) => edit.rule!),
    ),
  ];
  const preview = fieldMoves.some((edit) => edit.rule === INVOICE_PREVIEW_RULE);
  // Request-side rules, with the reads and renames that share their patch.
  const requestSummary = [
    preview ? 'replace the removed upcoming invoice call with invoices.createPreview' : '',
    requestMoves.length
      ? 'move removed Stripe request parameters to their documented replacements'
      : '',
    reads.length ? 'move removed field reads to their documented new locations' : '',
    cardRename ? 'replace payment_method_types with allowed_payment_method_types' : '',
  ]
    .filter(Boolean)
    .join(', ');
  const listedWarnings = [
    ...new Set(
      fieldMoves
        .filter((edit) => edit.rule === LISTED_PAYMENT_METHODS_RULE)
        .map((edit) =>
          listedPaymentMethodWarning(
            listedPaymentMethods(
              repository.files.find((file) => file.path === edit.file)!.content,
              edit,
            ),
          ),
        ),
    ),
  ];
  if (
    fieldMoves.length &&
    !usedSubscriptionPolicy &&
    !usedRequestRename &&
    !usedEndpointReplacement
  )
    return {
      generator: 'deterministic' as const,
      summary:
        requestMoves.length || preview
          ? `${requestSummary[0].toUpperCase()}${requestSummary.slice(1)} and update the pinned Stripe API version.`
          : !cardRename
            ? 'Move removed Stripe field reads to their documented new locations and update the pinned Stripe API version.'
            : reads.length
              ? `Move removed Stripe field reads to their documented new locations, replace ${listedWarnings.length ? 'payment_method_types' : "payment_method_types: ['card']"} with allowed_payment_method_types, and update the pinned Stripe API version.`
              : `Replace ${listedWarnings.length ? 'payment_method_types' : "payment_method_types: ['card']"} with allowed_payment_method_types and update the pinned Stripe API version.`,
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
        ...(fieldMoves.some((edit) => edit.rule === INVOICE_PRICE_ID_HELPER_RULE)
          ? [
              'Invoice line item and invoice item price IDs are read through a generated helper: the old price.id when present (old-version events), otherwise pricing.price_details.price when pricing.type is price_details. A missing price reads as undefined. Webhook endpoints are not changed.',
            ]
          : []),
        ...(fieldMoves.some((edit) => edit.rule === CHECKOUT_SHIPPING_HELPER_RULE)
          ? [
              'Checkout Session shipping details are read through a generated helper: the old shipping_details field when present (old-version events), otherwise collected_information.shipping_details. The new object holds only address and name; reads of carrier, phone or tracking_number are left for review. Webhook endpoints are not changed.',
            ]
          : []),
        ...(fieldMoves.some((edit) => edit.rule === PRODUCT_FEATURES_HELPER_RULE)
          ? [
              'Product features are read through a generated helper: the old features list when present (old-version events), otherwise marketing_features, the same list under its new name. Webhook endpoints are not changed.',
            ]
          : []),
        ...(fieldMoves.some((edit) => edit.rule === COUPON_ID_HELPER_RULE)
          ? [
              'Coupon IDs of promotion codes and discounts are read through a generated helper: the old coupon.id when present (old-version events), otherwise promotion.coupon or source.coupon when its type is coupon, an ID unless expanded. A missing coupon reads as undefined. Webhook endpoints are not changed.',
            ]
          : []),
        ...(fieldMoves.some((edit) => edit.rule === CARD_PAYMENT_METHOD_RULE)
          ? [CARD_PAYMENT_METHOD_WARNING]
          : []),
        ...listedWarnings,
        ...requestMoves.map((rule) => REQUEST_MOVE_WARNINGS[rule]),
        ...(preview ? [INVOICE_PREVIEW_WARNING] : []),
        'The stripe package is not upgraded. TypeScript projects may need the stripe package version matching the new API version before they typecheck.',
        'Patch contains source code. Review it for sensitive content before sharing.',
      ],
      sources: ruleSources(fieldMoves),
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
