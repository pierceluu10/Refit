import { migrationReviewReason, withoutRequestParameters } from './migration-review.ts';
import type { AiOptions } from './ai-budget.ts';
import { analyzeRepository } from './analyzer.ts';
import { annotateReach, currencyCodeEdits } from './operation-reach.ts';
import { measureCoverage } from './sdk-coverage.ts';
import { proposeAiPatch } from './ai-patches.ts';
import { assessMigration, buildAssessmentEvidence } from './assessment.ts';
import {
  applySourceEdits,
  editCovers,
  isFieldMove,
  proposePatch,
  renderFileReplacements,
} from './patches.ts';
import { stripePackageUpgrade } from './stripe-package-upgrade.ts';
import { INVOICE_PREVIEW_RULE, invoicePreviewMove } from './stripe-invoice-preview.ts';
import {
  PRODUCT_MARKETING_FEATURES_RULE,
  PROMOTION_CODE_PROMOTION_RULE,
  REQUEST_MOVE_RULES,
} from './stripe-request-moves.ts';
import { propertyExists, withoutRenamedSchemaRemovals } from './stripe-field-moves.ts';
import { readRepository } from './repository.ts';
import {
  MAX_SDK_RESOURCE_LENGTH,
  readProviderAdapter,
  STRIPE,
  validateProviderMappings,
} from './providers.ts';
import { validatePropertyRenames } from './provider-renames.ts';
import {
  CARD_PAYMENT_METHOD_RULE,
  LISTED_PAYMENT_METHODS_RULE,
  PAYMENT_METHOD_RENAME_RULES,
  removedRequestParameters,
} from './request-removals.ts';
import {
  isShopifySnapshot,
  isShopifySnapshotFile,
  runShopifyPipeline,
} from './shopify-pipeline.ts';
import {
  requestRenameEvidence,
  validateRequestPropertyRenames,
} from './provider-request-renames.ts';
import {
  countBreakingOperationUsages,
  findBreakingOperationImpacts,
  validateProviderOperationMappings,
} from './provider-operations.ts';
import {
  apiVersionSourceBlocked,
  compareApiVersion,
  validateApiVersion,
  validateApiVersionPolicy,
  type ApiVersionPolicy,
} from './api-version.ts';
import { PipelineInputError } from './types.ts';
import { digest, findRemovedProperties, isObject, readSpecification } from './specifications.ts';
import { stripeAdapterFor } from './stripe-operations.ts';
import { addTypeEvidence, stripePackageDirectory } from './stripe-type-evidence.ts';
import {
  SUBSCRIPTION_PERIOD_HELPER_RULE,
  INVOICE_SUBSCRIPTION_HELPER_RULE,
  INVOICE_PRICE_ID_HELPER_RULE,
  CHECKOUT_SHIPPING_HELPER_RULE,
  COUPON_ID_HELPER_RULE,
  PRODUCT_FEATURES_HELPER_RULE,
  HELPER_RULES,
  SUBSCRIPTION_PERIOD_RULE,
  validateStripeSubscriptionPeriodContract,
} from './stripe-subscription-periods.ts';
import {
  adapterContract,
  compareOpenApi,
  switchedEnumAdditions,
  unmappedBreakingChanges,
} from './openapi-diff.ts';
import {
  operationReplacementEvidence,
  replacementAnalysisAdapter,
  validateOperationReplacements,
} from './provider-operation-replacements.ts';

async function runOpenApiPipeline(options: {
  repository: string;
  before: string;
  after: string;
  proposePatch?: boolean;
  assessment?: AiOptions;
  aiPatch?: AiOptions;
  providerConfig?: string;
  apiVersion?: string;
  apiVersionPolicy?: ApiVersionPolicy;
  requireApiVersionMatch?: boolean;
  fullDiff?: boolean;
  documentationSnapshots?: readonly string[];
  // Stripe package directory for type evidence; defaults to the installed package.
  stripePackage?: string;
  // Deterministic only: leave traced calls that send a removed request parameter unresolved.
  leaveRequestParameters?: boolean;
  // The repository's opt-in to keep listed payment methods (`stripePaymentMethodTypes`).
  keepListedPaymentMethods?: boolean;
  // Shopify only: propose the SDK major upgrade a target version needs (docs/SHOPIFY-SDK-UPGRADE.md).
  shopifySdkUpgrade?: boolean;
  onProgress?: (message: string) => void;
}) {
  const applicationApiVersion = validateApiVersion(options.apiVersion);
  const policy = validateApiVersionPolicy(options.apiVersionPolicy);
  const [before, after] = await Promise.all([
    readSpecification(options.before),
    readSpecification(options.after),
  ]);
  const configured = await readProviderAdapter(options.providerConfig);
  const repository = await readRepository(options.repository, configured.packageName);
  // The built-in Stripe adapter grows to cover every Stripe method the application calls.
  const provider =
    configured === STRIPE
      ? stripeAdapterFor(
          STRIPE,
          before.document,
          new Set(
            analyzeRepository(repository, [], STRIPE).sdkCalls.map(
              (call) => `${call.resource}.${call.method}`,
            ),
          ),
        )
      : configured;
  if (
    [before, after].some(
      (snapshot) => snapshot.provenance && snapshot.provenance.provider !== provider.id,
    )
  )
    throw new PipelineInputError('Snapshot provenance does not match the configured provider.');
  const operationMappings = validateProviderOperationMappings(provider, before.document);
  validateProviderMappings(provider, before.schemas);
  validateStripeSubscriptionPeriodContract(
    provider.stripeSubscriptionPeriods,
    before.document,
    after.document,
  );
  const removed = findRemovedProperties(before.schemas, after.schemas, provider.id);
  const changes =
    provider.packageName === STRIPE.packageName
      ? withoutRenamedSchemaRemovals(removed, before.schemas, after.schemas)
      : removed;
  const moves = validatePropertyRenames(provider, changes, before.schemas, after.schemas);
  const replacements = validateOperationReplacements(
    provider,
    before.document,
    after.document,
    before.schemas,
    after.schemas,
  );
  const specificationDiff = options.fullDiff
    ? {
        ...(await compareOpenApi(
          adapterContract(before.document, provider),
          adapterContract(after.document, provider),
          { openResponseEnums: provider.packageName === STRIPE.packageName },
        )),
        coverage:
          'oasdiff compared only adapter-selected operations and their reachable components. Unselected endpoints, request schemas and unrelated components were not compared. Code and incoming-event coverage remain bounded; absence of a reported change is not proof of full API compatibility.',
      }
    : undefined;
  const requestRenames = validateRequestPropertyRenames(provider, before.document, after.document);
  const parameterRemovals = removedRequestParameters(provider, before.document, after.document, {
    keepListedPaymentMethods: options.keepListedPaymentMethods,
  });
  const invoicePreview =
    provider.packageName === STRIPE.packageName
      ? invoicePreviewMove(before.document, after.document)
      : undefined;
  const {
    edits: analyzedEdits,
    apiVersionDeclarations,
    apiVersionLiterals,
    sourceWarnings,
    skippedFiles,
    enumChecks,
    // Only model replacement proposals read direct client-method calls; reports do not list them.
    clientMethodCalls: _clientMethodCalls,
    ...analysis
  } = analyzeRepository(
    repository,
    changes,
    provider,
    before.schemas,
    replacements,
    requestRenames,
    moves,
    parameterRemovals,
    { invoicePreview },
  );
  const stripePackage =
    provider.packageName === STRIPE.packageName
      ? stripePackageDirectory(repository.root, options.stripePackage)
      : undefined;
  if (stripePackage) addTypeEvidence(repository, changes, analysis.findings, stripePackage);
  // Field moves apply only when the target contract has the documented new location.
  const itemPeriods =
    propertyExists(after.schemas, ['subscription', 'items']) &&
    propertyExists(after.schemas, ['subscription_item', 'current_period_start']) &&
    propertyExists(after.schemas, ['subscription_item', 'current_period_end']);
  const movedTo = {
    [SUBSCRIPTION_PERIOD_HELPER_RULE]: itemPeriods,
    [INVOICE_SUBSCRIPTION_HELPER_RULE]: propertyExists(after.schemas, [
      'invoice',
      'parent',
      'subscription_details',
      'subscription',
    ]),
    [INVOICE_PRICE_ID_HELPER_RULE]: ['line_item', 'invoiceitem'].every((schema) =>
      propertyExists(after.schemas, [schema, 'pricing', 'price_details', 'price']),
    ),
    [CHECKOUT_SHIPPING_HELPER_RULE]: propertyExists(after.schemas, [
      'checkout.session',
      'collected_information',
      'shipping_details',
    ]),
    // The mined read helpers read either API version (owner decision, 2026-10-24, overnight
    // sign-off; docs/overnight/F4.md). The request moves and createPreview are set below.
    [COUPON_ID_HELPER_RULE]:
      propertyExists(after.schemas, ['promotion_code', 'promotion', 'coupon']) &&
      propertyExists(after.schemas, ['discount', 'source', 'coupon']),
    [PRODUCT_FEATURES_HELPER_RULE]: propertyExists(after.schemas, [
      'product',
      'marketing_features',
    ]),
  } as Record<string, boolean>;
  const targetVersion = isObject(after.document.info) ? after.document.info.version : undefined;
  const versionEdits =
    provider.packageName === STRIPE.packageName &&
    applicationApiVersion &&
    typeof targetVersion === 'string' &&
    targetVersion !== applicationApiVersion
      ? apiVersionLiterals
          .filter((literal) => literal.value === applicationApiVersion)
          .filter(
            (literal, index, all) =>
              all.findIndex(
                (other) => other.file === literal.file && other.start === literal.start,
              ) === index,
          )
          .map((literal) => ({
            file: literal.file,
            start: literal.start,
            end: literal.end,
            replacement: targetVersion,
            changeId: 'stripe-api-version',
            rule: 'stripe-api-version' as const,
          }))
      : [];
  // Every client omits the version option and no request overrides it, so stripe-node 12+ sends
  // the API version its release pins: upgrading the package is the version bump, in any language.
  // `apiVersion: null` (the account default) is unknown, not absent, and never counts.
  const constructors = apiVersionDeclarations.filter((entry) => entry.kind === 'constructor');
  const sdkPinned =
    provider.packageName === STRIPE.packageName &&
    Boolean(applicationApiVersion) &&
    typeof targetVersion === 'string' &&
    targetVersion !== applicationApiVersion &&
    constructors.length > 0 &&
    constructors.every((entry) => entry.absent) &&
    apiVersionDeclarations.every(
      (entry) => entry.kind === 'constructor' || entry.status === 'inherited',
    ) &&
    !repository.files.some((file) => file.content.includes('setApiVersion'));
  const bumpsVersion = versionEdits.length > 0 || sdkPinned;
  const typescript = repository.files.some((file) => /\.(?:[cm]?ts|tsx)$/.test(file.path));
  // A client without the option follows the package's pin, so any such client needs the upgrade.
  const upgradeRequired = typescript || constructors.some((entry) => entry.absent);
  // The reviewed card-only rename is kept only with the target pin in the same patch and, for
  // TypeScript or an SDK-pinned version, the stripe-node release whose types have
  // allowed_payment_method_types. Without a patch request (validation preflight, scans) only the
  // pin is checked: the registry lookup for the upgrade runs when the patch is generated, and a
  // failed upgrade stops that run.
  // The mined request moves follow the same rule. stripe-node has invoices.createPreview only from
  // 15.6.0, so that rewrite needs the upgrade in JavaScript too.
  const patchRequested = Boolean(options.proposePatch || options.aiPatch);
  const preview = analyzedEdits.some((edit) => edit.rule === INVOICE_PREVIEW_RULE);
  const cardUpgrade =
    patchRequested &&
    analyzedEdits.some(
      (edit) =>
        PAYMENT_METHOD_RENAME_RULES.has(edit.rule ?? '') ||
        REQUEST_MOVE_RULES.has(edit.rule ?? '') ||
        edit.rule === INVOICE_PREVIEW_RULE,
    ) &&
    bumpsVersion &&
    (upgradeRequired || preview) &&
    typeof targetVersion === 'string'
      ? await stripePackageUpgrade(repository.root, targetVersion)
      : undefined;
  const upgraded = Boolean(cardUpgrade && 'upgrade' in cardUpgrade);
  // Every client that may send the renamed field must reach the target version: a dynamic or
  // unresolved pin can keep one on the version that rejects allowed_payment_method_types. A
  // client without the option moves with the stripe-node upgrade.
  const everyPinMoves = apiVersionDeclarations.every(
    (entry) => entry.status !== 'unknown' || (entry.kind === 'constructor' && entry.absent),
  );
  const operationChanges = operationReplacementEvidence(
    replacements,
    analysis.calls,
    analysis.findings,
  );
  const requestChanges = requestRenameEvidence(requestRenames, analysis.calls, analysis.findings);
  // A configured migration's patch carries no version edits or stripe-node upgrade (below).
  const configuredMigrationProposal =
    operationChanges.some((change) => change.usages.length > 0) ||
    requestChanges.some((change) => change.usages.length > 0) ||
    analysis.findings.some(
      (finding) => finding.webhook?.migration?.rule === SUBSCRIPTION_PERIOD_RULE,
    );
  // The card rename, the mined request moves and createPreview need the pin and the upgrade in
  // the same patch, so they never ride a configured migration's patch, which has neither.
  movedTo[CARD_PAYMENT_METHOD_RULE] =
    bumpsVersion &&
    everyPinMoves &&
    (!patchRequested || !upgradeRequired || upgraded) &&
    !configuredMigrationProposal;
  movedTo[LISTED_PAYMENT_METHODS_RULE] = movedTo[CARD_PAYMENT_METHOD_RULE];
  movedTo[PROMOTION_CODE_PROMOTION_RULE] = movedTo[CARD_PAYMENT_METHOD_RULE];
  movedTo[PRODUCT_MARKETING_FEATURES_RULE] = movedTo[PROMOTION_CODE_PROMOTION_RULE];
  movedTo[INVOICE_PREVIEW_RULE] =
    bumpsVersion && everyPinMoves && (!patchRequested || upgraded) && !configuredMigrationProposal;
  // The period helper reads either API version, so it does not depend on the version pin.
  const edits = [
    ...analyzedEdits.filter((edit) => !isFieldMove(edit) || movedTo[edit.rule!]),
    // A lowercase currency code is valid under either API version, so it needs no pin gate.
    ...(specificationDiff && provider.packageName === STRIPE.packageName
      ? currencyCodeEdits(specificationDiff.changes, {
          repository,
          calls: analysis.calls,
          mappings: operationMappings,
        })
      : []),
  ];
  const ruleEdits = edits.filter(isFieldMove);
  // A read counts as migrated only while its helper edit is kept.
  for (const finding of analysis.findings)
    if (
      (finding.subscriptionPeriod || HELPER_RULES.has(finding.webhook?.migration?.rule ?? '')) &&
      !editCovers(repository, edits, finding)
    ) {
      delete finding.subscriptionPeriod;
      if (HELPER_RULES.has(finding.webhook?.migration?.rule ?? ''))
        delete finding.webhook!.migration;
    }
  // A removed request parameter the kept card-only rename covers no longer stops the run.
  for (const finding of analysis.findings)
    if (finding.requestParameter && editCovers(repository, edits, finding))
      delete finding.requestParameter;
  // So does the removed upcoming invoice call a kept createPreview rewrite covers.
  for (const finding of analysis.findings)
    if (finding.changeId === INVOICE_PREVIEW_RULE && editCovers(repository, edits, finding))
      delete finding.contractReview;
  // A dropped payment-method rename tells the customer which gate dropped it (F2).
  const renames = analyzedEdits.filter((edit) => PAYMENT_METHOD_RENAME_RULES.has(edit.rule ?? ''));
  const unresolved = apiVersionDeclarations.find(
    (entry) => entry.status === 'unknown' && !(entry.kind === 'constructor' && entry.absent),
  );
  const gate = movedTo[CARD_PAYMENT_METHOD_RULE]
    ? undefined
    : configuredMigrationProposal
      ? 'this patch applies a configured migration, which does not move the API version'
      : !everyPinMoves && unresolved
        ? `Refit cannot resolve the API version the ${unresolved.kind === 'constructor' ? 'client created' : 'request'} at ${unresolved.file}:${unresolved.line} sends, so it cannot move every client to ${targetVersion}`
        : !bumpsVersion
          ? `no client pins a literal apiVersion that the patch can move to ${targetVersion}`
          : cardUpgrade && 'reason' in cardUpgrade
            ? `the stripe package cannot be upgraded to a release whose types have allowed_payment_method_types: ${cardUpgrade.reason.replace(/\.$/, '')}`
            : undefined;
  if (gate)
    for (const finding of analysis.findings)
      if (finding.requestParameter && editCovers(repository, renames, finding))
        finding.reason = `${finding.reason} The owner-approved rename to allowed_payment_method_types applies to this value, but ${gate}.`;
  if (specificationDiff && provider.packageName === STRIPE.packageName) {
    specificationDiff.changes.push(
      ...switchedEnumAdditions(enumChecks, before.schemas, after.schemas),
    );
    // A contract change blocks only where traced code reaches it (operation-reach.ts).
    let untraced: string[] | undefined;
    annotateReach(specificationDiff.changes, {
      repository,
      before: before.document,
      calls: analysis.calls,
      mappings: operationMappings,
      untracedCalls: () =>
        (untraced ??= measureCoverage(repository, 'stripe')
          .filter((site) => site.likelySdk && !site.traced)
          .map((site) => site.expression)),
      readFindings: (removals) =>
        analyzeRepository(repository, removals, provider, before.schemas).findings,
      removals: changes,
      edited: (file, offset) =>
        edits.some((edit) => edit.file === file && edit.start <= offset && offset < edit.end),
    });
  }
  const apiVersion = compareApiVersion(
    applicationApiVersion,
    before.document,
    after.document,
    { configured: Boolean(provider.apiVersion), declarations: apiVersionDeclarations },
    policy,
  );
  if (
    (options.requireApiVersionMatch && apiVersion.applicability !== 'matches-before') ||
    (apiVersionSourceBlocked(apiVersion) && (options.aiPatch || options.assessment))
  )
    throw new PipelineInputError(`Automated work is blocked. ${apiVersion.reason}`);
  const reviewableBreakingChanges = unmappedBreakingChanges(
    specificationDiff,
    changes,
    analysis.findings,
    operationChanges,
    requestChanges,
    analysis.expandedFields,
  );
  const operationImpacts = findBreakingOperationImpacts(
    specificationDiff,
    analysis.calls,
    operationMappings,
    reviewableBreakingChanges,
    operationChanges,
  );
  const operationUsageCount = countBreakingOperationUsages(operationImpacts);
  const representedOperationLocations = new Set(
    analysis.findings
      .filter((finding) =>
        [...replacements, ...requestRenames].some(
          (replacement) => replacement.id === finding.changeId,
        ),
      )
      .map((finding) => JSON.stringify([finding.file, finding.line, finding.column])),
  );
  const additionalOperationUsageCount = countBreakingOperationUsages(
    operationImpacts.map((impact) => ({
      ...impact,
      usages: impact.usages.filter(
        (usage) =>
          !representedOperationLocations.has(
            JSON.stringify([usage.file, usage.line, usage.column]),
          ),
      ),
    })),
  );
  const status =
    analysis.findings.some((finding) => finding.confidence === 'confirmed') ||
    operationImpacts.length
      ? 'affected'
      : analysis.providerDetected
        ? 'needs-review'
        : provider.id === STRIPE.id
          ? 'no-stripe-signal'
          : 'no-provider-signal';
  // AI receives every confirmed finding no rule covers, webhook payload reads included.
  const aiFindings = analysis.findings.filter(
    (finding) => finding.confidence === 'confirmed' && !editCovers(repository, ruleEdits, finding),
  );
  const useAi =
    Boolean(options.aiPatch) &&
    !configuredMigrationProposal &&
    (aiFindings.length > 0 || operationImpacts.length > 0);
  const deterministicRequested =
    options.proposePatch ||
    (options.aiPatch && !useAi && (configuredMigrationProposal || ruleEdits.length > 0));
  const unresolvedFindingCount = deterministicRequested
    ? analyzeRepository(
        {
          ...repository,
          files: repository.files.map((file) => ({
            ...file,
            content: applySourceEdits(
              file.content,
              edits.filter((edit) => edit.file === file.path),
            ),
          })),
        },
        changes,
        replacementAnalysisAdapter(provider, replacements),
        before.schemas,
        replacements,
        requestRenames,
        moves,
        parameterRemovals,
        { invoicePreview },
        // Untraced reads stay unresolved (owner decision, 2026-10-20): the draft needs review.
      ).findings.length
    : 0;
  const reviewEvidence = { findings: analysis.findings, skippedFiles, adapter: provider };
  const reviewReason = migrationReviewReason(
    options.leaveRequestParameters && !useAi
      ? withoutRequestParameters(reviewEvidence)
      : reviewEvidence,
    true,
    true,
    useAi,
  );
  const advisoryReviewReason = migrationReviewReason({ findings: analysis.findings, skippedFiles });
  if (useAi && !operationImpacts.length && !reviewReason)
    options.onProgress?.('Requesting an AI migration proposal...');
  else if (deterministicRequested && !reviewReason)
    options.onProgress?.('Generating a deterministic migration proposal...');
  const patch = reviewReason
    ? { status: 'not-generated' as const, reason: reviewReason! }
    : useAi
      ? operationImpacts.length
        ? {
            status: 'not-generated' as const,
            reason:
              'AI generation is blocked because the adapter maps code to unresolved breaking API changes without a verified migration rule.',
          }
        : await proposeAiPatch(
            repository,
            changes,
            analysis.findings,
            options.aiPatch!,
            provider,
            before.schemas,
            undefined,
            options.documentationSnapshots,
            after.schemas,
            [...ruleEdits, ...versionEdits],
          )
      : deterministicRequested
        ? {
            ...proposePatch(
              repository,
              ruleEdits.length && !configuredMigrationProposal
                ? [...edits, ...versionEdits]
                : edits,
              unresolvedFindingCount,
              provider,
              replacements,
              requestRenames,
            ),
            // AI repairs start again from the original code and must keep these rule edits.
            ...(ruleEdits.length && !configuredMigrationProposal
              ? { ruleEdits: [...ruleEdits, ...versionEdits] }
              : {}),
          }
        : {
            status: 'not-generated' as const,
            reason:
              'This pipeline produces impact evidence. It does not modify repositories or execute their code.',
          };
  // TypeScript projects need the stripe-node release for the new API version: its apiVersion
  // literal type and the moved fields' types. An SDK-pinned version moves only with the upgrade.
  // The upgrade is added only when the patch bumps the version.
  const bumpedVersion =
    bumpsVersion &&
    'diff' in patch &&
    patch.status === 'proposed' &&
    'generator' in patch &&
    (patch.generator === 'openai' || (ruleEdits.length > 0 && !configuredMigrationProposal));
  const upgrade =
    bumpedVersion &&
    (upgradeRequired || ruleEdits.some((edit) => edit.rule === INVOICE_PREVIEW_RULE)) &&
    typeof targetVersion === 'string'
      ? (cardUpgrade ?? (await stripePackageUpgrade(repository.root, targetVersion)))
      : undefined;
  const upgradedPatch =
    upgrade && 'diff' in patch
      ? 'upgrade' in upgrade
        ? {
            ...patch,
            edits: patch.edits + upgrade.upgrade.files.length,
            diff:
              patch.diff +
              renderFileReplacements(repository, upgrade.upgrade.files, 'stripe-package'),
            sdkUpgrade: { from: upgrade.upgrade.from, to: upgrade.upgrade.to },
            warnings: [
              `Upgrades stripe from ${upgrade.upgrade.from} to ${upgrade.upgrade.to} in ${upgrade.upgrade.files.map((file) => file.path).join(' and ')}, using the npm registry's SHA-512 integrity. A major SDK upgrade can change other types and behavior; review the stripe-node changelog.`,
              ...('warnings' in patch ? patch.warnings : []).filter(
                (warning) => !warning.startsWith('The stripe package is not upgraded.'),
              ),
            ],
          }
        : {
            ...patch,
            sdkUpgrade: { skipped: upgrade.reason },
            warnings: [
              `The stripe package was not upgraded: ${upgrade.reason}`,
              ...('warnings' in patch ? patch.warnings : []),
            ],
          }
      : patch;
  // Webhook reads the AI rewrote for both payload versions count as migrated.
  if ('migratedWebhookFindings' in patch)
    for (const finding of analysis.findings)
      if (
        finding.webhook &&
        patch.migratedWebhookFindings.some(
          (location) =>
            location.file === finding.file &&
            location.line === finding.line &&
            location.column === finding.column,
        )
      )
        finding.webhook.migration = { rule: 'ai-version-tolerant' };
  const completePatch =
    'unresolvedFindings' in upgradedPatch && additionalOperationUsageCount > 0
      ? {
          ...upgradedPatch,
          unresolvedFindings: upgradedPatch.unresolvedFindings + additionalOperationUsageCount,
        }
      : upgradedPatch;
  const repositoryHash = digest(
    JSON.stringify({
      files: repository.files,
      ...(repository.excludedPaths?.length ? { excludedPaths: repository.excludedPaths } : {}),
      ...(repository.configurations?.length ? { configurations: repository.configurations } : {}),
      dependencies: repository.dependencies,
      lockfiles: repository.lockfiles,
    }),
  );
  return {
    formatVersion: 1,
    provider: provider.id,
    adapter: provider,
    runId: digest(
      `${before.hash}:${after.hash}:${repositoryHash}:${digest(JSON.stringify(provider))}:${applicationApiVersion ?? ''}:${policy}`,
    ),
    apiVersion,
    sourceResolution: {
      status: sourceWarnings.length
        ? 'review'
        : repository.configurations?.length
          ? 'configured'
          : 'relative-only',
      warnings: sourceWarnings,
    },
    status,
    snapshots: { before: before.hash, after: after.hash },
    provenance: { before: before.provenance, after: after.provenance },
    repository: {
      hash: repositoryHash,
      scannedFiles: repository.files.length,
      dependencies: repository.dependencies,
      lockfiles: repository.lockfiles,
      ...(repository.configurations?.length
        ? {
            configurations: repository.configurations.map((file) => ({
              path: file.path,
              sha256: digest(file.content),
              bytes: Buffer.byteLength(file.content),
            })),
          }
        : {}),
    },
    changes,
    specificationDiff: specificationDiff ?? {
      engine: 'direct-properties' as const,
      changes,
      coverage: 'Direct removed properties only; use fullDiff for the oasdiff contract report.',
    },
    ...analysis,
    skippedFiles,
    operationImpacts,
    operationChanges,
    ...(requestChanges.length ? { requestChanges } : {}),
    warnings: [
      ...repository.warnings,
      ...sourceWarnings,
      ...(reviewReason ? [reviewReason!] : []),
      ...skippedFiles.map(
        (file) => `Skipped unparseable file; its API usage was not scanned. ${file}`,
      ),
      ...(apiVersion.applicability === 'matches-before' ? [] : [apiVersion.reason]),
      ...(apiVersion.source.status === 'verified' || apiVersionSourceBlocked(apiVersion)
        ? []
        : [apiVersion.source.reason]),
      ...(operationImpacts.length
        ? [
            `${operationUsageCount} SDK call site${operationUsageCount === 1 ? '' : 's'} map to unresolved breaking OpenAPI changes and require a verified migration rule.`,
          ]
        : []),
      ...(operationChanges.length
        ? [
            'Endpoint replacements are operator-authored mappings. Matching recorded contracts do not prove equivalent semantics or that the replacement method exists in the installed SDK; review the mapping and application checks.',
          ]
        : []),
    ],
    assessment: advisoryReviewReason
      ? {
          status: 'blocked' as const,
          reason: advisoryReviewReason,
        }
      : options.assessment
        ? await assessMigration(
            buildAssessmentEvidence(
              repository,
              changes,
              analysis.findings,
              provider,
              operationImpacts,
              operationChanges,
            ),
            options.assessment,
          )
        : { status: 'not-requested' },
    coverage: {
      specification: specificationDiff
        ? specificationDiff.coverage
        : 'Direct properties removed from existing, non-composed OpenAPI 3 component schemas only. Not a complete breaking-change diff.',
      code: `Immutable ESM/CommonJS SDK clients, including named/default imports and static requires of supported exported bindings through relative paths or recorded tsconfig/jsconfig paths and baseUrl, and awaited resource.method calls mapped by the recorded adapter. Resources can be dot-separated identifier paths up to ${MAX_SDK_RESOURCE_LENGTH} characters. Optional SDK invocations and computed resource access remain review cases; unawaited calls are not treated as response objects. Optional adapter operationId mappings correlate unresolved breaking OpenAPI changes to SDK call sites; explicit operationReplacements can edit direct, non-optional calls on unescaped clients after matching the old/new recorded contracts. Configured requestPropertyRenames edit direct object-literal body keys, including quoted and shorthand properties, after comparing the normalized operation contract; spreads, computed keys, duplicates, aliases and optional calls require review. Property reads can follow direct local component-schema $refs through nested objects, supported array items, literal numeric indexes, const for...of bindings, inline one-parameter array callbacks and immutable aliases. Top-level one-parameter functions returning exactly one mapped SDK call are traced locally or through supported named imports. SDK arguments trace into supported named or identifier-bound helpers; only closed private callers with one stable origin qualify for automation. Exported, escaped or uncertain helper clients carry review evidence and block the run. Configured propertyRenames can also move a removed field to a nested path newly declared in the after contract with the same value shape; reads already using that path are not reported. Removed-field indexes and destructuring can be reported but are not auto-edited. Dynamic indexes, mutable loop bindings, named or multi-parameter callbacks, transformed array chains, inline/composed/external schemas, detected writes, alias mutations, and references passed to calls or stored in containers remain review cases. Namespace imports and re-exports invalidate shared-client and wrapper confirmation. Dynamic exports, local ESM/CommonJS interop, shadowed or exposed loaders, unconfigured or unverified aliases, ambiguous resolution, multi-step or transformed wrappers and dynamic code still require review. Supported Stripe snapshot constructors, static payload aliases and exact event-type branches trace incoming payload reads under a curated mapping; webhook version and explicit migration-policy review block automatic patches, AI and publication. Unknown events, thin events, unsigned parsing and cross-function payload flows remain outside confirmation. Confirmed means traced under the supplied mapping, not independently verified SDK semantics or incoming API versions.`,
      decision:
        'No finding is not proof of no impact. Supported root npm, pnpm and yarn lockfiles provide recorded SDK versions, not verified installed versions or API-version applicability.',
    },
    nextAction:
      status === 'affected'
        ? 'Review migration semantics, generate a patch, then validate in an isolated environment.'
        : 'Review unsupported patterns and API version applicability before deciding impact.',
    patch: completePatch,
  };
}

export type PipelineReport = Awaited<ReturnType<typeof runOpenApiPipeline>>;

// Shopify contracts are GraphQL schemas, not OpenAPI documents, so Shopify snapshots run the Shopify
// pipeline. Its report carries every report field, with the OpenAPI-only ones empty.
export async function runPipeline(
  options: Parameters<typeof runOpenApiPipeline>[0],
): Promise<PipelineReport> {
  const kinds = await Promise.all([options.before, options.after].map(isShopifySnapshotFile));
  if (!kinds.some(Boolean)) return runOpenApiPipeline(options);
  const [before, after] = await Promise.all([
    readSpecification(options.before),
    readSpecification(options.after),
  ]);
  if (!isShopifySnapshot(before) || !isShopifySnapshot(after) || options.providerConfig)
    throw new PipelineInputError(
      'Shopify runs need Shopify schema snapshots for both contracts and the built-in adapter.',
    );
  return (await runShopifyPipeline({
    repository: options.repository,
    before,
    after,
    proposePatch: options.proposePatch,
    apiVersion: validateApiVersion(options.apiVersion),
    apiVersionPolicy: validateApiVersionPolicy(options.apiVersionPolicy),
    sdkUpgrade: options.shopifySdkUpgrade,
  })) as unknown as PipelineReport;
}
