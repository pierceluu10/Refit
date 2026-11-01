import { REASONING_EFFORTS, type ReasoningEffort } from './openai.ts';
import { ANTHROPIC_DEFAULT_MODEL, ANTHROPIC_ESCALATION_MODEL } from './anthropic.ts';
import { digest } from './specifications.ts';
import { PipelineInputError, type Finding, type Removal, type Repository } from './types.ts';
import { STRIPE, type ProviderAdapter } from './providers.ts';
import { aiBudgetConfiguration } from './ai-budget.ts';
import type { BreakingOperationImpact } from './provider-operations.ts';
import type { OperationReplacementEvidence } from './provider-operation-replacements.ts';

const CONTEXT_LINES = 3;
export function buildAssessmentEvidence(
  repository: Repository,
  changes: Removal[],
  findings: Finding[],
  provider: ProviderAdapter = STRIPE,
  operationImpacts: BreakingOperationImpact[] = [],
  operationChanges: OperationReplacementEvidence[] = [],
) {
  const files = new Map(repository.files.map((file) => [file.path, file.content.split('\n')]));
  return {
    provider: provider.id,
    adapter: provider,
    operationImpacts,
    operationChanges,
    changes: changes.filter((change) => findings.some((finding) => finding.changeId === change.id)),
    findings: findings.map((finding) => {
      const lines = files.get(finding.file);
      if (!lines) throw new PipelineInputError('Finding references a missing source file.');
      const start = Math.max(0, finding.line - 1 - CONTEXT_LINES);
      return {
        ...finding,
        id: digest(JSON.stringify(finding)),
        context: {
          startLine: start + 1,
          text: lines.slice(start, finding.line + CONTEXT_LINES).join('\n'),
        },
      };
    }),
    limitations:
      'Local ESM SDK patterns under the supplied adapter only. Adapter mappings, API version and full OpenAPI compatibility are not independently established.',
  };
}

export function assessmentConfiguration(
  enabled: boolean | undefined,
  environment: Record<string, string | undefined>,
) {
  if (!enabled) return undefined;
  const provider = aiProvider(environment);
  if (provider === 'anthropic') {
    const apiKey = environment.ANTHROPIC_API_KEY?.trim();
    if (!apiKey)
      throw new PipelineInputError('REFIT_AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY.');
    const model = environment.ANTHROPIC_MODEL?.trim() || ANTHROPIC_DEFAULT_MODEL;
    const escalationModel =
      environment.ANTHROPIC_ESCALATION_MODEL?.trim() || ANTHROPIC_ESCALATION_MODEL;
    return {
      provider,
      apiKey,
      model,
      budget: aiBudgetConfiguration(environment),
      ...aiEffort(environment, escalationModel),
    };
  }
  const apiKey = environment.OPENAI_API_KEY?.trim();
  const model = environment.OPENAI_MODEL?.trim();
  if (!apiKey || !model)
    throw new PipelineInputError(
      'AI operations require OPENAI_API_KEY and OPENAI_MODEL, or ANTHROPIC_API_KEY.',
    );
  return { apiKey, model, budget: aiBudgetConfiguration(environment), ...aiEffort(environment) };
}

// REFIT_AI_PROVIDER picks the backend; unset, Anthropic serves only when it is the one key given.
export function aiProvider(
  environment: Record<string, string | undefined>,
): 'openai' | 'anthropic' {
  const configured = environment.REFIT_AI_PROVIDER?.trim();
  if (configured === 'openai' || configured === 'anthropic') return configured;
  if (configured) throw new PipelineInputError('REFIT_AI_PROVIDER must be openai or anthropic.');
  return !environment.OPENAI_API_KEY?.trim() && environment.ANTHROPIC_API_KEY?.trim()
    ? 'anthropic'
    : 'openai';
}

// OPENAI_REASONING_EFFORT sets every request's effort. A patch request that proposes no edit retries
// once with OPENAI_ESCALATION_MODEL (default: the same model; ANTHROPIC_ESCALATION_MODEL, default
// claude-opus-5-5, on Anthropic) at OPENAI_ESCALATION_EFFORT (default: one step above the base
// effort, medium when unset); OPENAI_ESCALATION_EFFORT=none turns it off. Claude takes the same
// effort names (output_config.effort).
export function aiEffort(
  environment: Record<string, string | undefined>,
  escalationDefault?: string,
) {
  const effort = (name: string) => {
    const value = environment[name]?.trim();
    if (!value) return undefined;
    if (name === 'OPENAI_ESCALATION_EFFORT' && value === 'none') return value;
    if (!(REASONING_EFFORTS as readonly string[]).includes(value))
      throw new PipelineInputError(`${name} must be one of ${REASONING_EFFORTS.join(', ')}.`);
    return value;
  };
  const reasoningEffort = effort('OPENAI_REASONING_EFFORT');
  const configured = effort('OPENAI_ESCALATION_EFFORT');
  const base = REASONING_EFFORTS.indexOf((reasoningEffort ?? 'medium') as ReasoningEffort);
  const escalationEffort = configured ?? REASONING_EFFORTS[base + 1];
  const escalationModel =
    escalationDefault ??
    (environment.OPENAI_ESCALATION_MODEL?.trim() || environment.OPENAI_MODEL!.trim());
  return {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(escalationEffort && escalationEffort !== 'none'
      ? { escalation: { model: escalationModel, reasoningEffort: escalationEffort } }
      : {}),
  };
}
