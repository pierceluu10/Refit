import { readFile } from 'node:fs/promises';
import type { RequestProof } from './ai-migrations.ts';
import { proveRequests, redact, type ProofCall, type ProofProvider } from './ai-request-proof.ts';
import { validDate } from './deadline-registry.ts';
import { isObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

// Request-level proof for SDK major upgrades, stored like the model proofs (ai-models'
// data/model-request-proofs.json): each entry is one call shape on one SDK major, sent with the
// newest release of that major and Refit's own key in refit-bench Actions. A draft cites the
// entry for each call it migrates; a call with no proof keeps the draft [Needs review].

export const DEFAULT_SDK_PROOFS = new URL('../data/sdk-request-proofs.json', import.meta.url);
const RUN = /^https:\/\/github\.com\/refit-dev\/refit-bench\/actions\/runs\/\d+$/;
const PACKAGES: Record<string, ProofProvider> = {
  openai: 'openai',
  '@anthropic-ai/sdk': 'anthropic',
  '@google/genai': 'gemini',
};

export interface SdkProofTarget extends ProofCall {
  package: string;
  major: number;
}

export interface SdkProof extends SdkProofTarget {
  status: 'accepted';
  release: string;
  detail: string;
  run: string;
  date: string;
}

export interface SdkPending extends SdkProofTarget {
  reason: string;
}

export interface SdkProofTable {
  formatVersion: 1;
  proofs: SdkProof[];
  pending: SdkPending[];
}

function target(value: Record<string, unknown>, label: string): SdkProofTarget {
  if (
    typeof value.package !== 'string' ||
    !(value.package in PACKAGES) ||
    !Number.isSafeInteger(value.major) ||
    typeof value.call !== 'string' ||
    !/^[a-z][A-Za-z.]*$/.test(value.call) ||
    [value.stream, value.tools, value.json].some(
      (flag) => flag !== undefined && typeof flag !== 'boolean',
    )
  )
    throw new PipelineInputError(`${label} needs package, major, call and boolean features.`);
  return {
    package: value.package,
    major: value.major as number,
    call: value.call,
    ...(value.stream ? { stream: true } : {}),
    ...(value.tools ? { tools: true } : {}),
    ...(value.json ? { json: true } : {}),
  };
}

export function parseSdkProofTable(value: unknown): SdkProofTable {
  if (
    !isObject(value) ||
    value.formatVersion !== 1 ||
    !Array.isArray(value.proofs) ||
    !Array.isArray(value.pending)
  )
    throw new PipelineInputError(
      'data/sdk-request-proofs.json needs formatVersion 1, proofs and pending.',
    );
  const proofs = value.proofs.map((entry, index) => {
    const label = `proofs[${index}]`;
    if (!isObject(entry)) throw new PipelineInputError(`${label} is not an object.`);
    if (
      entry.status !== 'accepted' ||
      typeof entry.release !== 'string' ||
      !/^\d+\.\d+\.\d+$/.test(entry.release) ||
      typeof entry.detail !== 'string' ||
      typeof entry.run !== 'string' ||
      !RUN.test(entry.run) ||
      !validDate(entry.date)
    )
      throw new PipelineInputError(
        `${label} needs an accepted release, detail, refit-bench run and date.`,
      );
    const shape = target(entry, label);
    if (Number(entry.release.split('.')[0]) !== shape.major)
      throw new PipelineInputError(
        `${label}: release ${entry.release} is not major ${shape.major}.`,
      );
    return {
      ...shape,
      status: 'accepted' as const,
      release: entry.release,
      detail: entry.detail,
      run: entry.run,
      date: entry.date,
    };
  });
  const pending = value.pending.map((entry, index) => {
    const label = `pending[${index}]`;
    if (!isObject(entry) || typeof entry.reason !== 'string' || !entry.reason.trim())
      throw new PipelineInputError(`${label} needs a reason.`);
    return { ...target(entry, label), reason: entry.reason };
  });
  return { formatVersion: 1, proofs, pending };
}

export async function loadSdkProofTable(url: URL = DEFAULT_SDK_PROOFS) {
  return parseSdkProofTable(
    parseObject(await readFile(url, 'utf8'), 'data/sdk-request-proofs.json'),
  );
}

// A proof covers a call when it sent the same call on the same major with every feature the call
// uses (a proof with a stream also covers a call without one).
const covers = (proof: SdkProofTarget, call: SdkProofTarget) =>
  proof.package === call.package &&
  proof.major === call.major &&
  proof.call === call.call &&
  (!call.stream || proof.stream) &&
  (!call.tools || proof.tools) &&
  (!call.json || proof.json);

// The request proof a draft cites for the calls it migrates, from the stored table.
export function storedRequestProof(
  table: SdkProofTable,
  packageName: string,
  major: number,
  calls: ProofCall[],
): RequestProof {
  const rows = calls.map((call) => {
    const shape = { ...call, package: packageName, major };
    const proof = table.proofs.find((entry) => covers(entry, shape));
    if (proof)
      return {
        call: call.call,
        status: 'accepted' as const,
        detail: `${proof.detail} (${packageName} ${proof.release}, ${proof.run}, ${proof.date})`,
      };
    const pending = table.pending.find((entry) => covers(entry, shape));
    return {
      call: call.call,
      status: 'pending' as const,
      detail:
        pending?.reason ??
        `No request has been sent for ${call.call}${call.stream ? ' with stream' : ''}${call.tools ? ' with tools' : ''}${call.json ? ' with JSON output' : ''} on ${packageName} ${major}.x.`,
    };
  });
  if (!rows.length)
    return {
      status: 'pending',
      reason: 'The patch migrates no call with a request to prove; only the package moves.',
      calls: [],
    };
  const unproved = rows.filter((row) => row.status !== 'accepted');
  return {
    status: unproved.length ? 'pending' : 'accepted',
    reason: unproved.length
      ? unproved.map((row) => `${row.call}: ${row.detail}`).join('; ')
      : 'Every migrated call shape was accepted.',
    calls: rows,
  };
}

// Runs in refit-bench Actions: proves every target in the table with the SDK installed in
// `sdkDirectory` and returns the new table. Without a provider's key its targets stay pending.
export async function proveSdkTable(options: {
  table: SdkProofTable;
  sdkDirectory: string;
  releases: Record<string, string>;
  run: string;
  date: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SdkProofTable> {
  if (!RUN.test(options.run))
    throw new PipelineInputError('--run must be a refit-bench Actions run URL.');
  const targets = [...options.table.proofs, ...options.table.pending].map((entry) =>
    target(entry as unknown as Record<string, unknown>, entry.call),
  );
  const proofs: SdkProof[] = [];
  const pending: SdkPending[] = [];
  for (const shape of targets) {
    const release = options.releases[shape.package];
    if (!release || Number(release.split('.')[0]) !== shape.major) {
      pending.push({
        ...shape,
        reason: `${shape.package} ${shape.major}.x was not installed for this run.`,
      });
      continue;
    }
    const result = await proveRequests({
      provider: PACKAGES[shape.package],
      packageName: shape.package,
      sdkDirectory: options.sdkDirectory,
      calls: [shape],
      env: options.env,
    });
    const row = result.calls[0];
    if (row?.status === 'accepted')
      proofs.push({
        ...shape,
        status: 'accepted',
        release,
        detail: row.detail,
        run: options.run,
        date: options.date,
      });
    // The table is a public artifact: a provider's IDs never reach it, whatever path set the reason.
    else
      pending.push({
        ...shape,
        reason: redact(row ? `${row.status}: ${row.detail}` : result.reason),
      });
  }
  return { formatVersion: 1, proofs, pending };
}
