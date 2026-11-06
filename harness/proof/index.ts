// Proof for platform and rule changes. `runProof(check, input, ctx)` runs one check and returns
// evidence; each check is also an AgentTool the harness agent can call. Checks only gather evidence:
// they never block, never throw, and a check that cannot look says so with passed: 'unknown'.
import type { AgentTool, ProofResult, RunProof } from '../../shared/types.ts';
import { redactSecrets } from '../secrets.ts';
import { accessibilityCheck } from './accessibility.ts';
import { containerImageCheck } from './container.ts';
import { browserExtensionCheck } from './extension.ts';
import { kubernetesCheck } from './kubernetes.ts';
import { androidSdkCheck, iosPrivacyManifestCheck } from './mobile.ts';
import { paymentScriptsCheck } from './payment.ts';
import { serverlessCheck } from './serverless.ts';
import { loginCheck, tlsCheck } from './tls-auth.ts';
import type { ProofCheck, ProofContext, ProofDetail } from './types.ts';
import { proofDetail } from './util.ts';

export const PROOF_CHECKS: ProofCheck[] = [
  kubernetesCheck,
  serverlessCheck,
  androidSdkCheck,
  iosPrivacyManifestCheck,
  browserExtensionCheck,
  tlsCheck,
  loginCheck,
  accessibilityCheck,
  paymentScriptsCheck,
  containerImageCheck,
];

export const PROOF_CHECK_NAMES = PROOF_CHECKS.map((c) => c.name);

export async function runProofDetail(
  check: string,
  input: unknown,
  ctx: ProofContext,
): Promise<ProofDetail> {
  const found = PROOF_CHECKS.find((c) => c.name === check);
  if (!found)
    return proofDetail(check, {
      notes: [`no proof check named "${check}"; available: ${PROOF_CHECK_NAMES.join(', ')}`],
      passed: 'unknown',
    });
  const args =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  try {
    return await found.run(args, ctx);
  } catch (error) {
    return proofDetail(check, {
      notes: [
        `the check itself errored: ${error instanceof Error ? error.message : String(error)}`,
      ],
      passed: 'unknown',
    });
  }
}

// The shared-contract entry point. Extra context fields (sandbox, baselineDir) are optional.
export const runProof: RunProof = (check, input, ctx) =>
  runProofDetail(check, input, ctx).then(toProofResult);

export function toProofResult(detail: ProofDetail): ProofResult {
  return { check: detail.check, passed: detail.passed, evidence: detail.evidence };
}

export function formatProofResult(result: ProofResult): string {
  // An unknown result says outright that it is not proof.
  const verdict =
    result.passed === 'unknown'
      ? 'unknown (not proof: counts as failed until a rerun or a person confirms it)'
      : result.passed
        ? 'passed'
        : 'failed';
  return redactSecrets(
    [`${result.check}: ${verdict}`, ...result.evidence.map((e) => `- ${e}`)].join('\n'),
  );
}

// A proof tool's verdict is its first line; the evidence below can quote logs ("0 failed") that
// harness/validators.ts would misread, so a passing proof is graded from this line alone.
export const proofOutputPassed = (output: string) =>
  /^[\w-]+: passed$/.test(output.split('\n', 1)[0]);

// The checks as agent tools, named proof_<check>. Pass the harness's sandbox (and the untouched
// checkout as baselineDir) so commands reuse it; without them each call makes its own sandbox from
// the repoDir the tool is called with. Tool output is the formatted evidence.
export function buildProofTools(base: Omit<ProofContext, 'repoDir'> = {}): AgentTool[] {
  return PROOF_CHECKS.map((check) => ({
    name: `proof_${check.name.replace(/-/g, '_')}`,
    description: check.description,
    inputSchema: check.inputSchema,
    run: async (input, context) =>
      formatProofResult(
        await runProofDetail(check.name, input, {
          ...base,
          repoDir: base.sandbox?.dir ?? context.repoDir,
        }),
      ),
  }));
}

export const proofTools: AgentTool[] = buildProofTools();

export { clearProofBaselines } from './baseline.ts';
export { LAMBDA_DEPRECATIONS } from './serverless.ts';
export { PLAY_TARGET_SDK, REQUIRED_REASON_APIS } from './mobile.ts';
export { REMOVED_K8S_APIS } from './kubernetes.ts';
export type { ProofCheck, ProofContext, ProofDetail } from './types.ts';
