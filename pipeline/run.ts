import {
  migrationReviewReason,
  migrationReviewReasons,
  reviewBlocksAi,
  unresolvedSites,
} from './migration-review.ts';
import type { AiOptions } from './ai-budget.ts';
import { analyzeRepository } from './analyzer.ts';
import { annotateReach, currencyCodeEdits, enumValueEdits } from './operation-reach.ts';
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
import { REQUEST_MOVE_RULES } from './request-move-families.ts';
import { STRIPE_PACK } from './rule-pack.ts';
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
  MOVED_PAYMENT_METHODS_RULE,
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
import { PipelineInputError, type SourceEdit } from './types.ts';
import { digest, findRemovedProperties, isObject, readSpecification } from './specifications.ts';
import { stripeAdapterFor } from './stripe-operations.ts';
import { addTypeEvidence, stripePackageDirectory } from './stripe-type-evidence.ts';
import {
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
  // Owner decision 1: write the rules' patch around every finding that needs review, which stays
  // unresolved and unedited, instead of stopping; AI never runs beside such a finding.
  leaveReviewedFindings?: boolean;
  // Owner decision 1 fallback: leave every API-version pin and the stripe package as they are, so
  // the patch keeps only edits that work under either version (the workflow's retry after a
  // regression).
  keepApiVersion?: boolean;
  // The repository's opt-in to keep listed payment methods (`stripePaymentMethodTypes`).
  keepListedPaymentMethods?: boolean;
  // Validation only: the networked lockfile resolver a types-only peer bump uses
  // (lockfile-resolution.ts), with the repository's commit date as its cutoff.
  lockfileResolution?: { image: string; before: string };
  // Validation only: of several committed lockfiles, the one preparation installs; the stripe-node
  // upgrade edits that one alone (dependency-inputs.ts chosenLockfile).
  lockfile?: string;
  // Shopify only: propose the SDK major upgrade a target version needs (docs/SHOPIFY-SDK-UPGRADE.md).
  shopifySdkUpgrade?: boolean;
  // Validation only: subscription-period reads its patched type check rejected (analyzer.ts).
  typeCheckedPeriodReads?: { file: string; position: number }[];
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
    edits: scannedEdits,
    apiVersionDeclarations: declaredVersions,
    apiVersionLiterals,
    sourceWarnings,
    skippedFiles,
    enumChecks,
    // Only model replacement proposals read direct client-method calls; reports do not list them.
    clientMethodCalls: _clientMethodCalls,
    renamePaths,
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
    { invoicePreview, typeCheckedPeriodReads: options.typeCheckedPeriodReads },
  );
  // Documented enum successors are request moves: they ride the pin and the stripe-node upgrade.
  const analyzedEdits = [
    ...scannedEdits,
    ...(specificationDiff && provider.packageName === STRIPE.packageName
      ? enumValueEdits(
          specificationDiff.changes,
          { repository, calls: analysis.calls, mappings: operationMappings },
          STRIPE_PACK.requestMoves,
        )
      : []),
  ];
  const stripePackage =
    provider.packageName === STRIPE.packageName
      ? stripePackageDirectory(repository.root, options.stripePackage)
      : undefined;
  if (stripePackage) addTypeEvidence(repository, changes, analysis.findings, stripePackage);
  // Field moves apply only when the target contract has the documented new location.
  // The mined read helpers read either API version (owner decision, 2026-10-24, overnight
  // sign-off; docs/overnight/F4.md). The request moves and createPreview are set below.
  const movedTo: Record<string, boolean> = Object.fromEntries(
    STRIPE_PACK.fieldMoves.map((move) => [
      move.rule,
      move.targets.every((path) => propertyExists(after.schemas, path)),
    ]),
  );
  const targetVersion = isObject(after.document.info) ? after.document.info.version : undefined;
  // Owner decision 1: every traced pin older than the target moves to it, including one that sends
  // another version than the application's; the draft lists each pin with the version it sent.
  // Stripe versions start with their date, so string order is release order, and a pin newer than
  // the target is never moved back.
  const movesPin = (value: string) =>
    !options.keepApiVersion &&
    (options.leaveReviewedFindings
      ? typeof targetVersion === 'string' && value < targetVersion
      : targetVersion !== applicationApiVersion && value === applicationApiVersion);
  // A pin the application does not send that is also a webhook endpoint's api_version stays, as
  // moving it would move that endpoint; it is listed as unresolved with why.
  const endpointPin = (entry: { value: string | null; endpoint?: true }) =>
    Boolean(
      options.leaveReviewedFindings && entry.endpoint && entry.value && movesPin(entry.value),
    );
  const apiVersionDeclarations = declaredVersions.map((entry) =>
    endpointPin(entry)
      ? { ...entry, status: 'unknown' as const, reason: ENDPOINT_PIN_REASON }
      : entry,
  );
  const versionEdits =
    provider.packageName === STRIPE.packageName &&
    applicationApiVersion &&
    typeof targetVersion === 'string'
      ? apiVersionLiterals
          .filter((literal) => movesPin(literal.value) && !endpointPin(literal))
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
  // The upgrade moves at least one client that omits the option: enough for a payment-method
  // rename whose own path holds only such clients (below).
  const sdkDefault =
    !options.keepApiVersion &&
    provider.packageName === STRIPE.packageName &&
    Boolean(applicationApiVersion) &&
    typeof targetVersion === 'string' &&
    targetVersion !== applicationApiVersion &&
    constructors.some((entry) => entry.absent) &&
    !repository.files.some((file) => file.content.includes('setApiVersion'));
  const sdkPinned =
    sdkDefault &&
    constructors.every((entry) => entry.absent) &&
    apiVersionDeclarations.every(
      (entry) => entry.kind === 'constructor' || entry.status === 'inherited',
    );
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
    (bumpsVersion || sdkDefault) &&
    (upgradeRequired || preview) &&
    typeof targetVersion === 'string'
      ? await stripePackageUpgrade(
          repository.root,
          targetVersion,
          options.lockfileResolution,
          options.lockfile,
        )
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
  // Founders' decision (2026-10-27): a payment-method rename also stands when every declaration on
  // its own path is proven, even if another client or request elsewhere has an untraced version:
  // its calls inherit their client's version, and every constructor of that client either has a
  // literal pin the patch moves (or one already at or past the target) or omits the option and
  // moves with the stripe-node upgrade. An escape hatch makes every constructor unknown.
  const renameMoves =
    (bumpsVersion || sdkDefault) &&
    (!patchRequested || !upgradeRequired || upgraded) &&
    !configuredMigrationProposal;
  // A literal pin reaches the target when the patch moves it or it already sends the target or later.
  const pinReaches = (value: string) =>
    typeof targetVersion === 'string' &&
    (value >= targetVersion ||
      (movesPin(value) &&
        provider.packageName === STRIPE.packageName &&
        Boolean(applicationApiVersion)));
  const reaches = (entry: (typeof apiVersionDeclarations)[number]) =>
    entry.status === 'literal'
      ? pinReaches(entry.value!)
      : entry.kind === 'request'
        ? entry.status === 'inherited'
        : Boolean(entry.absent);
  const pathMoves = (edit: SourceEdit) =>
    renameMoves &&
    Boolean(renamePaths.get(edit)?.every((index) => reaches(apiVersionDeclarations[index])));
  movedTo[LISTED_PAYMENT_METHODS_RULE] = movedTo[CARD_PAYMENT_METHOD_RULE];
  movedTo[MOVED_PAYMENT_METHODS_RULE] = movedTo[CARD_PAYMENT_METHOD_RULE];
  for (const rule of REQUEST_MOVE_RULES) movedTo[rule] = movedTo[CARD_PAYMENT_METHOD_RULE];
  movedTo[INVOICE_PREVIEW_RULE] =
    bumpsVersion && everyPinMoves && (!patchRequested || upgraded) && !configuredMigrationProposal;
  // The period helper reads either API version, so it does not depend on the version pin.
  const kept = [
    ...analyzedEdits.filter(
      (edit) =>
        !isFieldMove(edit) ||
        movedTo[edit.rule!] ||
        (PAYMENT_METHOD_RENAME_RULES.has(edit.rule!) && pathMoves(edit)),
    ),
    // A lowercase currency code is valid under either API version, so it needs no pin gate.
    ...(specificationDiff && provider.packageName === STRIPE.packageName
      ? currencyCodeEdits(specificationDiff.changes, {
          repository,
          calls: analysis.calls,
          mappings: operationMappings,
        })
      : []),
  ];
  // A read counts as migrated only while its helper edit is kept.
  for (const finding of analysis.findings)
    if (
      (finding.subscriptionPeriod || HELPER_RULES.has(finding.webhook?.migration?.rule ?? '')) &&
      !editCovers(repository, kept, finding)
    ) {
      // Only its helper edit made a type-checked read confirmed.
      if (finding.typeChecked) {
        finding.confidence = 'review';
        finding.reason =
          'The upgraded stripe-node types reject this subscription period read, but the period helper could not be applied here; inspect manually.';
        delete finding.typeChecked;
      }
      delete finding.subscriptionPeriod;
      if (HELPER_RULES.has(finding.webhook?.migration?.rule ?? ''))
        delete finding.webhook!.migration;
    }
  // A rename kept on its own path bumps the version through the stripe-node upgrade.
  const versionBumped =
    bumpsVersion ||
    kept.some((edit) => PAYMENT_METHOD_RENAME_RULES.has(edit.rule ?? '') && !movedTo[edit.rule!]);
  // A removed request parameter the kept card-only rename covers no longer stops the run.
  for (const finding of analysis.findings)
    if (finding.requestParameter && editCovers(repository, kept, finding))
      delete finding.requestParameter;
  // So does the removed upcoming invoice call a kept createPreview rewrite covers.
  for (const finding of analysis.findings)
    if (finding.changeId === INVOICE_PREVIEW_RULE && editCovers(repository, kept, finding))
      delete finding.contractReview;
  // Owner decision 1 (2026-10-24): a finding that needs review is never edited. The rules' patch
  // goes around it, and the draft lists it with its reason.
  const reviewed = options.leaveReviewedFindings
    ? migrationReviewReasons(
        { findings: analysis.findings, skippedFiles, adapter: provider },
        true,
      ).flatMap((entry) => entry.findings)
    : [];
  const edits = kept.filter(
    (edit) => !reviewed.some((finding) => editCovers(repository, [edit], finding)),
  );
  const ruleEdits = edits.filter(isFieldMove);
  // The pin and the stripe-node upgrade ride the rules' edits. Under owner decision 1 they also
  // make the patch when a removed request parameter is left for review, as the #88 waiver does:
  // the parameter stays in place and the draft names it.
  const movesVersion =
    !configuredMigrationProposal &&
    (ruleEdits.length > 0 ||
      (Boolean(options.leaveReviewedFindings) &&
        reviewed.some((finding) => finding.requestParameter)));
  // A dropped payment-method rename tells the customer which gate dropped it (F2).
  const renames = analyzedEdits.filter((edit) => PAYMENT_METHOD_RENAME_RULES.has(edit.rule ?? ''));
  const untraced = (entry: (typeof apiVersionDeclarations)[number]) =>
    entry.status === 'unknown' && !(entry.kind === 'constructor' && entry.absent);
  const dropped = renames.filter((edit) => !kept.includes(edit));
  const onPath = dropped
    .flatMap((edit) => renamePaths.get(edit) ?? [])
    .map((index) => apiVersionDeclarations[index]);
  const unmoved = onPath.find((entry) => entry.status === 'literal' && !reaches(entry));
  // Name a declaration on a dropped rename's own path when one is untraced; any untraced one when
  // a dropped rename's path is not known.
  const unresolved =
    onPath.find(untraced) ??
    (dropped.some((edit) => !renamePaths.get(edit)) && !everyPinMoves
      ? apiVersionDeclarations.find(untraced)
      : undefined);
  const gate = !dropped.length
    ? undefined
    : options.keepApiVersion
      ? 'the patch that moved the API version failed the repository checks, so this one leaves every pin unchanged'
      : configuredMigrationProposal
        ? 'this patch applies a configured migration, which does not move the API version'
        : unresolved
          ? `Refit cannot resolve the API version the ${unresolved.kind === 'constructor' ? 'client created' : 'request'} at ${unresolved.file}:${unresolved.line} sends, so it cannot move every client to ${targetVersion}`
          : unmoved
            ? `the ${unmoved.kind === 'constructor' ? 'client created' : 'request'} at ${unmoved.file}:${unmoved.line} pins ${unmoved.value}, which this patch does not move to ${targetVersion}`
            : !bumpsVersion && !sdkDefault
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
    (apiVersionSourceBlocked(apiVersion, options.leaveReviewedFindings) &&
      (options.aiPatch || options.assessment))
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
  const reviewEvidence = { findings: analysis.findings, skippedFiles, adapter: provider };
  const useAi =
    Boolean(options.aiPatch) &&
    !configuredMigrationProposal &&
    (aiFindings.length > 0 || operationImpacts.length > 0) &&
    !(
      options.leaveReviewedFindings &&
      (reviewBlocksAi({ ...reviewEvidence, operationImpacts }) ||
        apiVersion.source.status === 'conflict')
    );
  const deterministicRequested =
    options.proposePatch ||
    (options.aiPatch && !useAi && (configuredMigrationProposal || ruleEdits.length > 0));
  const unresolvedFindings = deterministicRequested
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
      ).findings
    : [];
  const reviews = migrationReviewReasons(reviewEvidence, true, true, useAi).map(
    (entry) => entry.reason,
  );
  // Under decision 1 every reason is recorded and none stops the rules' patch.
  const reviewReason = options.leaveReviewedFindings ? undefined : reviews[0];
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
            undefined,
            parameterRemovals,
          )
      : deterministicRequested
        ? {
            ...proposePatch(
              repository,
              movesVersion ? [...edits, ...versionEdits] : edits,
              unresolvedFindings.length,
              provider,
              replacements,
              requestRenames,
            ),
            ...(unresolvedFindings.length
              ? { unresolvedSites: unresolvedSites(unresolvedFindings) }
              : {}),
            // AI repairs start again from the original code and must keep these rule edits.
            ...(movesVersion ? { ruleEdits: [...ruleEdits, ...versionEdits] } : {}),
            ...(options.keepApiVersion ? { keptApiVersion: true as const } : {}),
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
    versionBumped &&
    'diff' in patch &&
    patch.status === 'proposed' &&
    'generator' in patch &&
    (patch.generator === 'openai' || movesVersion);
  const upgrade =
    bumpedVersion &&
    (upgradeRequired || ruleEdits.some((edit) => edit.rule === INVOICE_PREVIEW_RULE)) &&
    typeof targetVersion === 'string'
      ? (cardUpgrade ??
        (await stripePackageUpgrade(
          repository.root,
          targetVersion,
          options.lockfileResolution,
          options.lockfile,
        )))
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
              upgrade.upgrade.warning ??
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
      ...(options.leaveReviewedFindings ? reviews : reviews.slice(0, 1)),
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
      code: `Immutable ESM/CommonJS SDK clients, including named/default imports and static requires of supported exported bindings through relative paths or recorded tsconfig/jsconfig paths and baseUrl, and awaited resource.method calls mapped by the recorded adapter. Resources can be dot-separated identifier paths up to ${MAX_SDK_RESOURCE_LENGTH} characters. Optional SDK invocations and computed resource access remain review cases; unawaited calls are not treated as response objects. Optional adapter operationId mappings correlate unresolved breaking OpenAPI changes to SDK call sites; explicit operationReplacements can edit direct, non-optional calls on unescaped clients after matching the old/new recorded contracts. Configured requestPropertyRenames edit direct object-literal body keys, including quoted and shorthand properties, after comparing the normalized operation contract; spreads, computed keys, duplicates, aliases and optional calls require review. Property reads can follow direct local component-schema $refs through nested objects, supported array items, literal numeric indexes, const for...of bindings, inline one-parameter array callbacks and immutable aliases. Top-level one-parameter functions returning exactly one mapped SDK call are traced locally or through supported named imports. SDK arguments trace into supported named or identifier-bound helpers; only closed private callers with one stable origin qualify for automation. Exported, escaped or uncertain helper clients carry review evidence and block the run. Configured propertyRenames can also move a removed field to a nested path newly declared in the after contract with the same value shape; reads already using that path are not reported. Removed-field indexes and destructuring can be reported but are not auto-edited. Dynamic indexes, mutable loop bindings, named or multi-parameter callbacks, transformed array chains, inline/composed/external schemas, detected writes, alias mutations, and references passed to calls or stored in containers remain review cases. Namespace imports and re-exports invalidate shared-client and wrapper confirmation. Dynamic exports, local ESM/CommonJS interop, shadowed or exposed loaders, unconfigured or unverified aliases, ambiguous resolution, multi-step or transformed wrappers and dynamic code still require review. Supported Stripe snapshot constructors, static payload aliases and exact event-type branches trace incoming payload reads under a curated mapping; webhook version and explicit migration-policy review block automatic patches, AI and publication. A private function declaration's parameter is a payload when every call passes one narrowed payload schema. Unknown events, thin events, unsigned parsing and other cross-function payload flows remain outside confirmation. Confirmed means traced under the supplied mapping, not independently verified SDK semantics or incoming API versions.`,
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
export const ENDPOINT_PIN_REASON =
  "This version also sets a webhook endpoint's api_version, so moving it would change the version that endpoint receives.";

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
