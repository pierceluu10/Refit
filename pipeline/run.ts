import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrationReviewReasons, unresolvedSites } from './migration-review.ts';
import type { AiOptions } from './ai-budget.ts';
import { analyzeRepository } from './analyzer.ts';
import type { proposeAiPatch } from './ai-patches.ts';
import {
  annotateReach,
  currencyCodeEdits,
  enumValueEdits,
  REQUEST_OPTIONS_RULE,
  SDK_SIGNATURE_RULES,
  ACCOUNT_RETRIEVE_CURRENT_RULE,
  accountRetrieveCurrentEdits,
  REQUEST_OPTIONS_SINCE,
  requestOptionEdits,
} from './operation-reach.ts';
import { measureCoverage } from './sdk-coverage.ts';
import { stripeHandOff } from './stripe-agent.ts';
import {
  applySourceEdits,
  editCovers,
  isFieldMove,
  proposePatch,
  renderFileReplacements,
  renderPatch,
  REQUEST_OPTIONS_WARNING,
  ACCOUNT_RETRIEVE_CURRENT_WARNING,
} from './patches.ts';
import {
  PACKAGE_FILES,
  STRIPE_SDK_RELEASES,
  stripePackageUpgrade,
} from './stripe-package-upgrade.ts';
import { REQUEST_MOVE_RULES } from './request-move-families.ts';
import { STRIPE_PACK, STRIPE_RULE_TABLES } from './rule-pack.ts';
import { propertyExists, withoutRenamedSchemaRemovals } from './stripe-field-moves.ts';
import { readRepository } from './repository.ts';
import {
  MAX_SDK_RESOURCE_LENGTH,
  readProviderAdapter,
  STRIPE,
  validateProviderMappings,
} from './providers.ts';
import { validatePropertyRenames } from './provider-renames.ts';
import { removedRequestParameters } from './request-removals.ts';
import {
  isShopifySnapshot,
  isShopifySnapshotFile,
  runShopifyPipeline,
} from './shopify-pipeline.ts';
import type { GraphReconstruction } from './meta-graph-ai.ts';
import {
  isMetaGraphSnapshot,
  isMetaGraphSnapshotFile,
  runMetaGraphPipeline,
} from './meta-graph-pipeline.ts';
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
import { PipelineInputError, type Finding, type Removal, type Repository } from './types.ts';
import { digest, findRemovedProperties, isObject, readSpecification } from './specifications.ts';
import { shopifySnapshotPath } from './shopify-schemas.ts';
import { stripeAdapterFor } from './stripe-operations.ts';
import {
  addTypeEvidence,
  stripePackageDirectory,
  typeProvenReads,
} from './stripe-type-evidence.ts';
import { typedStripeClients } from './type-clients.ts';
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
  // AI for a Meta Graph run's scan only: it reads the requests the scan cannot (meta-graph-ai.ts).
  // Other providers ignore it, so the workflow's scan gives it without starting AI patches.
  metaGraphAi?: AiOptions;
  // Reconstructions the workflow's scan made, reused by validation's scans so one run asks once
  // and validates the patch the scan proposed.
  metaGraphReconstructions?: GraphReconstruction[];
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
  // Why stripe-node could not be upgraded with the pin, when that kept every pin (set by runPipeline).
  pinBlocked?: string;
  // docs/VERSION-BUMP-PRS.md: the workflow found every Stripe call traced and none reaching what the
  // target changes, so the patch only moves every pin and upgrades stripe-node, together or not at all.
  versionBump?: boolean;
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
  // Stripe calls whose client the checker types as stripe-node's (docs/CLIENT-TRACING.md).
  const typed =
    configured.packageName === STRIPE.packageName
      ? typedStripeClients(repository, options.stripePackage)
      : undefined;
  const typedClients = typed?.clients;
  // The built-in Stripe adapter grows to cover every Stripe method the application calls.
  const provider =
    configured === STRIPE
      ? stripeAdapterFor(
          STRIPE,
          before.document,
          new Set(
            analyzeRepository(repository, [], STRIPE, {}, [], [], [], [], {
              typedClients,
            }).sdkCalls.map((call) => `${call.resource}.${call.method}`),
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
  // Founder decision (2026-10-28): reads TypeScript's checker proves read the change's Stripe type
  // are analyzed again as confirmed, so the rules migrate them as they would a traced read.
  const withTypeProof = <T extends { findings: Finding[] }>(
    snapshot: Repository,
    analyze: (proven?: ReturnType<typeof typeProvenReads>) => T,
  ) => {
    const analyzed = analyze();
    if (provider.packageName !== STRIPE.packageName) return analyzed;
    const proven = typeProvenReads(snapshot, changes, analyzed.findings, options.stripePackage);
    return proven.length ? analyze(proven) : analyzed;
  };
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
  const upcoming = (document: Record<string, unknown>) =>
    isObject(document.paths) && '/v1/invoices/upcoming' in document.paths;
  const invoicePreview =
    provider.packageName === STRIPE.packageName &&
    upcoming(before.document) &&
    !upcoming(after.document);
  const {
    edits: scannedEdits,
    apiVersionDeclarations: declaredVersions,
    apiVersionLiterals,
    sourceWarnings,
    skippedFiles,
    enumChecks,
    // Only model replacement proposals read direct client-method calls; reports do not list them.
    clientMethodCalls: _clientMethodCalls,
    ...analysis
  } = withTypeProof(repository, (typeProvenReads) =>
    analyzeRepository(
      repository,
      changes,
      provider,
      before.schemas,
      replacements,
      requestRenames,
      moves,
      parameterRemovals,
      {
        invoicePreview,
        typeCheckedPeriodReads: options.typeCheckedPeriodReads,
        typedClients,
        typeProvenReads,
      },
    ),
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
    // Only where the target's stripe-node release reads arguments by position.
    ...(provider.packageName === STRIPE.packageName &&
    isObject(after.document.info) &&
    Number(STRIPE_SDK_RELEASES[String(after.document.info.version)]?.split('.')[0]) >=
      REQUEST_OPTIONS_SINCE
      ? [
          ...requestOptionEdits({ repository, calls: analysis.calls, mappings: operationMappings }),
          ...accountRetrieveCurrentEdits({ repository, calls: analysis.calls }),
        ]
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
  // moving it would move that endpoint; it is listed as unresolved with why. One that sends the
  // application's version moves (founder decision, 2026-10-28): Refit compared exactly that
  // contract with the target, so the endpoint it creates gets the payloads the handlers were
  // checked against, and the patch says so.
  const endpointPin = (entry: { value: string | null; endpoint?: true }) =>
    Boolean(
      options.leaveReviewedFindings &&
      entry.endpoint &&
      entry.value &&
      entry.value !== applicationApiVersion &&
      movesPin(entry.value),
    );
  const movedEndpointPins = apiVersionLiterals.filter(
    (literal: { value: string; endpoint?: true }) =>
      literal.endpoint && movesPin(literal.value) && !endpointPin(literal),
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
  // `apiVersion: null` is absent too: stripe-node sends `apiVersion || DEFAULT_API_VERSION`.
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
  // The mined request moves follow the same rule.
  const patchRequested = Boolean(options.proposePatch || options.aiPatch);
  const cardUpgrade =
    patchRequested &&
    analyzedEdits.some(
      (edit) => REQUEST_MOVE_RULES.has(edit.rule ?? '') || SDK_SIGNATURE_RULES.has(edit.rule ?? ''),
    ) &&
    (bumpsVersion || sdkDefault) &&
    upgradeRequired &&
    typeof targetVersion === 'string'
      ? await stripePackageUpgrade(
          repository.root,
          targetVersion,
          options.lockfileResolution,
          options.lockfile,
        )
      : undefined;
  const upgraded = Boolean(cardUpgrade && 'upgrade' in cardUpgrade);
  // Every client must reach the target version for request edits that need it.
  // An untraced client's own literal pin moves with versionEdits too (declared-api-versions.ts).
  const movedUntraced = (entry: (typeof apiVersionDeclarations)[number]) =>
    Boolean(entry.untracedPin) &&
    apiVersionLiterals.some(
      (literal) =>
        apiVersionDeclarations[literal.declaration ?? -1] === entry &&
        versionEdits.some((edit) => edit.file === literal.file && edit.start === literal.start),
    );
  const everyPinMoves = apiVersionDeclarations.every(
    (entry) =>
      entry.status !== 'unknown' ||
      (entry.kind === 'constructor' && entry.absent) ||
      movedUntraced(entry),
  );
  // A deployment environment variable can override a moved default, so request edits that need
  // the target version do not ride on it; the version move itself does.
  const everyPinReaches =
    everyPinMoves && apiVersionDeclarations.every((entry) => !entry.environment);
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
  // The mined request moves need the pin and the upgrade in the same patch, so they never ride a
  // configured migration's patch, which has neither.
  for (const rule of REQUEST_MOVE_RULES)
    movedTo[rule] =
      bumpsVersion &&
      everyPinReaches &&
      (!patchRequested || !upgradeRequired || upgraded) &&
      !configuredMigrationProposal;
  // Request options move only together with the stripe-node release that needs them last.
  for (const rule of SDK_SIGNATURE_RULES)
    movedTo[rule] =
      bumpsVersion &&
      everyPinReaches &&
      (!patchRequested || upgraded) &&
      !configuredMigrationProposal;
  // The period helper reads either API version, so it does not depend on the version pin.
  const kept = [
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
  // A removed request parameter a kept request move covers no longer needs review.
  for (const finding of analysis.findings)
    if (finding.requestParameter && editCovers(repository, kept, finding))
      delete finding.requestParameter;
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
  // Request options moved last ride the other rule edits or the version bump, never alone.
  const optionEdits = edits.filter((edit) => SDK_SIGNATURE_RULES.has(edit.rule ?? ''));
  const ruleEdits = edits.filter(isFieldMove);
  // The pin and the stripe-node upgrade ride the rules' edits. Under owner decision 1 they also
  // make the patch when a removed request parameter is left for review, as the #88 waiver does:
  // the parameter stays in place and the draft names it.
  const movesVersion =
    !configuredMigrationProposal &&
    (ruleEdits.length > optionEdits.length ||
      (Boolean(options.leaveReviewedFindings) &&
        reviewed.some((finding) => finding.requestParameter)));
  if (specificationDiff && provider.packageName === STRIPE.packageName) {
    specificationDiff.changes.push(
      ...switchedEnumAdditions(enumChecks, before.schemas, after.schemas),
    );
    // A contract change blocks only where traced code reaches it (operation-reach.ts).
    let untraced: string[] | undefined;
    annotateReach(specificationDiff.changes, {
      repository,
      before: before.document,
      after: after.document,
      calls: analysis.calls,
      mappings: operationMappings,
      untracedCalls: () =>
        (untraced ??= measureCoverage(repository, 'stripe', {
          typeTracing: true,
          stripePackage: options.stripePackage,
        })
          .filter((site) => site.likelySdk && !site.traced)
          .map((site) => site.expression)),
      readFindings: (removals) =>
        analyzeRepository(repository, removals, provider, before.schemas, [], [], [], [], {
          typedClients,
        }).findings,
      removals: changes,
      edited: (file, offset) =>
        edits.some((edit) => edit.file === file && edit.start <= offset && offset < edit.end),
    });
  }
  // An untraced client's literal pin that the patch moves is listed as moved, not as left alone.
  if (movesVersion || options.aiPatch)
    for (const literal of apiVersionLiterals)
      if (
        literal.declaration !== undefined &&
        versionEdits.some((edit) => edit.file === literal.file && edit.start === literal.start)
      )
        apiVersionDeclarations[literal.declaration] = {
          ...apiVersionDeclarations[literal.declaration],
          moved: literal.value,
        };
  const apiVersion = compareApiVersion(
    applicationApiVersion,
    before.document,
    after.document,
    { configured: Boolean(provider.apiVersion), declarations: apiVersionDeclarations },
    policy,
  );
  if (options.requireApiVersionMatch && apiVersion.applicability !== 'matches-before')
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
  const reviewEvidence = { findings: analysis.findings, skippedFiles, adapter: provider };
  const deterministicRequested = options.proposePatch || options.aiPatch;
  const patchedRepository = deterministicRequested && {
    ...repository,
    files: repository.files.map((file) => ({
      ...file,
      content: applySourceEdits(
        file.content,
        edits.filter((edit) => edit.file === file.path),
      ),
    })),
  };
  const unresolvedFindings = patchedRepository
    ? withTypeProof(patchedRepository, (typeProvenReads) =>
        analyzeRepository(
          patchedRepository,
          changes,
          replacementAnalysisAdapter(provider, replacements),
          before.schemas,
          replacements,
          requestRenames,
          moves,
          parameterRemovals,
          {
            invoicePreview,
            typedClients:
              typed && typedStripeClients(patchedRepository, options.stripePackage).clients,
            typeProvenReads,
          },
          // Untraced reads stay unresolved (owner decision, 2026-10-20): the draft needs review.
        ),
      ).findings
    : [];
  const reviews = migrationReviewReasons(reviewEvidence, true, true).map((entry) => entry.reason);
  if (deterministicRequested)
    options.onProgress?.('Generating a deterministic migration proposal...');
  const versionBump =
    options.versionBump &&
    options.proposePatch &&
    !options.keepApiVersion &&
    provider.packageName === STRIPE.packageName &&
    typeof targetVersion === 'string' &&
    !analysis.findings.length &&
    analyzedEdits.every((edit) => SDK_SIGNATURE_RULES.has(edit.rule ?? '')) &&
    kept.every((edit) => SDK_SIGNATURE_RULES.has(edit.rule ?? '')) &&
    everyPinMoves &&
    (versionEdits.length > 0 || sdkDefault)
      ? await stripePackageUpgrade(
          repository.root,
          targetVersion,
          options.lockfileResolution,
          options.lockfile,
        )
      : undefined;
  // Its own expression, so its fields do not widen the other patches' types.
  const versionBumpStop =
    options.versionBump && options.proposePatch && (!versionBump || 'reason' in versionBump)
      ? {
          status: 'not-generated' as const,
          reason: versionBump
            ? `The version bump moves the pin only together with stripe-node, which cannot be upgraded: ${versionBump.reason}`
            : 'A version bump needs no finding or rule edit and every Stripe client version traced.',
        }
      : undefined;
  const versionBumpPatch =
    versionBump && 'upgrade' in versionBump
      ? {
          generator: 'deterministic' as const,
          versionBump: true as const,
          summary: `Update the pinned Stripe API version to ${String(targetVersion)} and upgrade stripe from ${versionBump.upgrade.from} to ${versionBump.upgrade.to}.`,
          status: 'proposed' as const,
          edits: versionEdits.length + optionEdits.length + versionBump.upgrade.files.length,
          unresolvedFindings: 0,
          unresolvedSites: [] as ReturnType<typeof unresolvedSites>,
          diff:
            renderPatch(repository, [...versionEdits, ...optionEdits]) +
            renderFileReplacements(repository, versionBump.upgrade.files, 'stripe-package'),
          validation: 'not-run',
          warnings: [
            versionBump.upgrade.warning ??
              `Upgrades stripe from ${versionBump.upgrade.from} to ${versionBump.upgrade.to} in ${versionBump.upgrade.files.map((file) => file.path).join(' and ')}, using the npm registry's SHA-512 integrity. A major SDK upgrade can change other types and behavior; review the stripe-node changelog.`,
            'Webhook endpoints keep the API version set in the Stripe Dashboard; this patch does not change them.',
            ...(optionEdits.some((edit) => edit.rule === REQUEST_OPTIONS_RULE)
              ? [REQUEST_OPTIONS_WARNING]
              : []),
            ...(optionEdits.some((edit) => edit.rule === ACCOUNT_RETRIEVE_CURRENT_RULE)
              ? [ACCOUNT_RETRIEVE_CURRENT_WARNING]
              : []),
          ],
          sdkUpgrade: {
            from: versionBump.upgrade.from,
            to: versionBump.upgrade.to,
            ...(versionBump.upgrade.raised ? { raised: versionBump.upgrade.raised } : {}),
          },
          // AI repairs start again from the original code and must keep these edits.
          ruleEdits: [...versionEdits, ...optionEdits],
        }
      : undefined;
  const patch = versionBumpStop
    ? versionBumpStop
    : versionBumpPatch
      ? versionBumpPatch
      : deterministicRequested
        ? {
            ...proposePatch(
              repository,
              movesVersion
                ? [...edits, ...versionEdits]
                : edits.filter((edit) => !SDK_SIGNATURE_RULES.has(edit.rule ?? '')),
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
            ...(options.pinBlocked ? { pinBlocked: options.pinBlocked } : {}),
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
    bumpsVersion && 'diff' in patch && patch.status === 'proposed' && movesVersion;
  const upgrade =
    bumpedVersion && upgradeRequired && typeof targetVersion === 'string'
      ? (cardUpgrade ??
        (await stripePackageUpgrade(
          repository.root,
          targetVersion,
          options.lockfileResolution,
          options.lockfile,
        )))
      : undefined;
  // Founder decision (Otabek, 2026-10-28): TypeScript checks a pin against the installed
  // stripe-node's apiVersion type, so a rules' pin moves only with the upgrade. When the upgrade is
  // refused, runPipeline scans again with every pin kept and the draft names the blocker
  // (api-version-kept). An AI proposal is not asked again.
  const pinWithoutUpgrade =
    upgrade &&
    'reason' in upgrade &&
    typescript &&
    movesVersion &&
    versionEdits.length > 0 &&
    'generator' in patch &&
    !/ is already (?:locked|declared)\.$/.test(upgrade.reason) &&
    // With several root lockfiles, validation chooses one (chosenLockfile) and upgrades that one
    // alone; until it has, a refusal of them all together does not hold the pin.
    (options.lockfile !== undefined ||
      repository.lockfiles.filter((entry) => PACKAGE_FILES.includes(entry.file)).length < 2);
  const upgradedPatch =
    upgrade && 'diff' in patch
      ? 'upgrade' in upgrade
        ? {
            ...patch,
            edits: patch.edits + upgrade.upgrade.files.length,
            diff:
              patch.diff +
              renderFileReplacements(repository, upgrade.upgrade.files, 'stripe-package'),
            sdkUpgrade: {
              from: upgrade.upgrade.from,
              to: upgrade.upgrade.to,
              ...(upgrade.upgrade.raised ? { raised: upgrade.upgrade.raised } : {}),
            },
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
            sdkUpgrade: {
              skipped: upgrade.reason,
              ...(pinWithoutUpgrade ? { pinMoved: true as const } : {}),
            },
            warnings: [
              `The stripe package was not upgraded: ${upgrade.reason}`,
              ...('warnings' in patch ? patch.warnings : []),
            ],
          }
      : patch;
  const endpointPatch =
    movedEndpointPins.length &&
    'diff' in upgradedPatch &&
    upgradedPatch.diff.includes(String(targetVersion))
      ? {
          ...upgradedPatch,
          warnings: [
            ...('warnings' in upgradedPatch ? upgradedPatch.warnings : []),
            `${movedEndpointPins
              .map((literal) => literal.file)
              .filter((file, index, all) => all.indexOf(file) === index)
              .join(
                ', ',
              )} also ${movedEndpointPins.length === 1 ? 'sets' : 'set'} a webhook endpoint's api_version: endpoints this code creates after the patch receive ${String(targetVersion)} payloads. Existing endpoints keep their version until you change it in the Dashboard.`,
          ],
        }
      : upgradedPatch;
  const completePatch =
    'unresolvedFindings' in endpointPatch && additionalOperationUsageCount > 0
      ? {
          ...endpointPatch,
          unresolvedFindings: endpointPatch.unresolvedFindings + additionalOperationUsageCount,
        }
      : endpointPatch;
  const repositoryHash = digest(
    JSON.stringify({
      files: repository.files,
      ...(repository.excludedPaths?.length ? { excludedPaths: repository.excludedPaths } : {}),
      ...(repository.configurations?.length ? { configurations: repository.configurations } : {}),
      dependencies: repository.dependencies,
      lockfiles: repository.lockfiles,
    }),
  );
  // The gut plan (docs/GUT-PLAN.md): no Stripe stop ends the run. With AI on, every stop and
  // finding the rules leave goes to the agent fixer, starting from the rules' patch.
  const leftOver = [
    ...reviews,
    ...(versionBumpStop ? [versionBumpStop.reason] : []),
    ...(options.pinBlocked ? [`stripe-node could not be upgraded: ${options.pinBlocked}`] : []),
    ...(apiVersion.applicability === 'matches-before' ? [] : [apiVersion.reason]),
    ...[...analysis.findings, ...unresolvedFindings]
      .filter(
        (finding) => finding.confidence === 'review' || !editCovers(repository, edits, finding),
      )
      .map(
        (finding) => `${finding.file}:${finding.line}: ${finding.expression}: ${finding.reason}`,
      ),
    ...operationImpacts.flatMap((impact) =>
      impact.usages.map(
        (usage) => `${usage.file}:${usage.line}: ${JSON.stringify(impact).slice(0, 300)}`,
      ),
    ),
  ];
  const agent =
    options.aiPatch &&
    provider.packageName === STRIPE.packageName &&
    typeof targetVersion === 'string' &&
    leftOver.length
      ? await cachedAgent(
          `${repositoryHash}:${targetVersion}:${'diff' in completePatch ? digest(completePatch.diff) : ''}`,
          () =>
            stripeHandOff({
              repository: repository.root,
              patch: 'diff' in completePatch ? completePatch.diff : null,
              target: targetVersion,
              change: stripeChangeText(changes, before.document, targetVersion),
              context: [...new Set(leftOver)].join('\n').slice(0, 40_000),
              judge: async (directory) => {
                const findings = await rescanFindings({
                  ...options,
                  repository: directory,
                  proposePatch: false,
                  aiPatch: undefined,
                  assessment: undefined,
                  requireApiVersionMatch: false,
                  versionBump: false,
                  typeCheckedPeriodReads: undefined,
                });
                const errors = [
                  ...findings.map(
                    (finding) => `${finding.file}:${finding.line}: ${finding.reason}`,
                  ),
                  ...droppedPaymentMethodTypes(repository, directory),
                ];
                return { passed: errors.length === 0, errors };
              },
            }),
        )
      : undefined;
  const agentPatch =
    agent?.patch && (agent.outcome === 'passed' || agent.outcome === 'unproven')
      ? {
          // The codebase's label for an AI-written patch; the agent is Claude (agent-fix.ts).
          generator: 'openai' as const,
          summary: `Migrate the Stripe integration to ${String(targetVersion)}. ${agent.outcome === 'passed' ? "Refit's Stripe judges pass on the result." : "Refit's Stripe judges still report problems, listed below."}`,
          status: 'proposed' as const,
          edits: (agent.patch.match(/^diff --git /gm) ?? []).length,
          unresolvedFindings: agent.outcome === 'passed' ? 0 : agent.errors.length,
          diff: agent.patch,
          validation: 'not-run',
          ruleEdits: [...edits, ...versionEdits],
          agent: {
            outcome: agent.outcome,
            summary: agent.summary,
            errors: agent.errors,
            costUsd: agent.costUsd,
          },
          warnings: [
            `An AI agent wrote this patch on top of Refit's rules. What it says it changed: ${agent.summary || 'no summary.'}`,
            ...(agent.outcome === 'unproven'
              ? [`Refit's Stripe judges still report: ${agent.errors.join(' ')}`]
              : []),
          ],
          unresolvedSites: [] as ReturnType<typeof unresolvedSites>,
        }
      : undefined;
  // validation.ts (GUT5) still writes single-shot AI repairs into this report's patch.
  const finalPatch = (agentPatch ?? completePatch) as
    | typeof completePatch
    | NonNullable<typeof agentPatch>
    | Awaited<ReturnType<typeof proposeAiPatch>>;
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
      ...(typed?.skipped === 'too-large'
        ? [
            'The repository has too many source files to type-check, so Stripe calls were traced only through the analyzer, not by their client type.',
          ]
        : []),
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
    // The agent's summary replaces the advisory AI assessment (docs/GUT-PLAN.md).
    assessment: { status: 'not-requested' as const },
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
    patch: finalPatch,
  };
}

// The judge's rescan of the agent's tree, typed apart so the pipeline's own type is not circular.
async function rescanFindings(
  options: Parameters<typeof runOpenApiPipeline>[0],
): Promise<Finding[]> {
  return (await runOpenApiPipeline(options)).findings;
}

// `refit run` proposes the patch in its scan and again in validation, on a copy of the same commit;
// both get the one agent run, so it is paid for once.
const agentRuns = new Map<string, ReturnType<typeof stripeHandOff>>();
function cachedAgent(key: string, run: () => ReturnType<typeof stripeHandOff>) {
  if (!agentRuns.has(key))
    agentRuns.set(
      key,
      run().catch((error: unknown) => ({
        outcome: 'failed' as const,
        diff: '',
        errors: [
          `The agent fixer could not run: ${error instanceof Error ? error.message : String(error)}`,
        ],
        summary: '',
        costUsd: 0,
        patch: '',
      })),
    );
  return agentRuns.get(key)!;
}

// The removed fields and the quoted Stripe rules between the two versions, for the agent's `change`.
function stripeChangeText(changes: Removal[], before: Record<string, unknown>, target: string) {
  const from = isObject(before.info) ? String(before.info.version) : '';
  const rules = STRIPE_RULE_TABLES.filter(
    (table) => table.version > from && table.version <= target,
  ).flatMap((table) =>
    table.rules.map((rule) => `- ${table.version} ${rule.rule}: "${rule.quote}" (${rule.source})`),
  );
  return [
    `Move the Stripe integration from API version ${from} to ${target}, upgrading stripe-node with it.`,
    ...(changes.length
      ? [
          'Fields the target removes:',
          ...changes.map((change) => `- ${change.schema}.${change.property}`),
        ]
      : []),
    ...(rules.length ? ["Stripe's changelog entries Refit has quoted:", ...rules] : []),
    'Never drop payment_method_types: move it to allowed_payment_method_types or leave it.',
  ].join('\n');
}

// The payment-method guard: every payment_method_types the original sends is still sent (moving it
// to allowed_payment_method_types keeps the name inside it).
function droppedPaymentMethodTypes(original: Repository, directory: string) {
  const count = (text: string) => text.match(/payment_method_types/g)?.length ?? 0;
  return original.files.flatMap((file) => {
    const before = count(file.content);
    const path = join(directory, file.path);
    const after = before && existsSync(path) ? count(readFileSync(path, 'utf8')) : 0;
    return after < before
      ? [`${file.path}: the patch drops payment_method_types; Refit never drops it.`]
      : [];
  });
}

export type PipelineReport = Awaited<ReturnType<typeof runOpenApiPipeline>>;

// Shopify contracts are GraphQL schemas, not OpenAPI documents, so Shopify snapshots run the Shopify
// pipeline, and Meta Graph snapshots (a version and the reviewed change table) the Meta pipeline.
// Their reports carry every report field, with the OpenAPI-only ones empty.
export const ENDPOINT_PIN_REASON =
  "This version also sets a webhook endpoint's api_version, so moving it would change the version that endpoint receives.";

export async function runPipeline(
  options: Parameters<typeof runOpenApiPipeline>[0],
): Promise<PipelineReport> {
  const meta = await Promise.all([options.before, options.after].map(isMetaGraphSnapshotFile));
  if (meta.some(Boolean)) {
    const [before, after] = await Promise.all([
      readSpecification(options.before),
      readSpecification(options.after),
    ]);
    if (!isMetaGraphSnapshot(before) || !isMetaGraphSnapshot(after) || options.providerConfig)
      throw new PipelineInputError(
        'Meta Graph runs need Meta Graph snapshots for both contracts and the built-in adapter.',
      );
    return (await runMetaGraphPipeline({
      repository: options.repository,
      before: before as never,
      after: after as never,
      proposePatch: options.proposePatch,
      apiVersionPolicy: validateApiVersionPolicy(options.apiVersionPolicy),
      aiPatch: options.metaGraphAi ?? options.aiPatch,
      reconstructions: options.metaGraphReconstructions,
    })) as unknown as PipelineReport;
  }
  const kinds = await Promise.all([options.before, options.after].map(isShopifySnapshotFile));
  if (!kinds.some(Boolean)) {
    const report = await runOpenApiPipeline(options);
    const upgrade =
      'sdkUpgrade' in report.patch
        ? (report.patch.sdkUpgrade as { skipped?: string; pinMoved?: true } | undefined)
        : undefined;
    return upgrade?.pinMoved
      ? runOpenApiPipeline({ ...options, keepApiVersion: true, pinBlocked: upgrade.skipped })
      : report;
  }
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
    aiPatch: options.aiPatch,
    lockfileResolution: options.lockfileResolution,
    snapshot: async (version) =>
      readSpecification(await shopifySnapshotPath(version, options.after)),
  })) as unknown as PipelineReport;
}
