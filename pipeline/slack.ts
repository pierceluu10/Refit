import { PipelineInputError } from './types.ts';

const WEBHOOK_PREFIX = 'https://hooks.slack.com/services/';
const SEND_TIMEOUT_MS = 5_000;
const MAXIMUM_DETAIL = 200;

export type SlackSend = (text: string) => Promise<void>;

// Unset means notifications are off. A failed send only warns: a Slack outage never fails a run.
export function slackNotifier(
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void = (message) => console.error(`[refit] ${message}`),
): SlackSend | undefined {
  const url = env.REFIT_SLACK_WEBHOOK_URL?.trim();
  if (!url) return undefined;
  if (!url.startsWith(WEBHOOK_PREFIX) || /\s/.test(url))
    throw new PipelineInputError(
      `REFIT_SLACK_WEBHOOK_URL must be a Slack incoming webhook URL starting with ${WEBHOOK_PREFIX}.`,
    );
  return async (text) => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        redirect: 'error',
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`Slack returned HTTP ${response.status}`);
    } catch (error) {
      // The message never includes the webhook URL, which is a credential.
      warn(
        `Slack notification not sent: ${error instanceof Error ? error.message : 'unknown error'}.`,
      );
    }
  };
}

// Slack reads <, > and & as markup; repository names and error messages are untrusted text.
function plain(value: string) {
  const line = value.replace(/\s+/g, ' ').trim();
  const short = line.length > MAXIMUM_DETAIL ? `${line.slice(0, MAXIMUM_DETAIL - 1)}…` : line;
  return short.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

// One line for a new validated draft PR, an [URGENT] line for a regression or a publication that
// failed partway, and nothing for every other outcome.
export function workflowNotice(result: {
  repository: string;
  status: string;
  stage: string;
  reason: string;
  validation?: string;
  // The draft is titled [Needs review] (owner decision 1).
  needsReview?: boolean;
  error: { message: string } | null;
}) {
  const repository = plain(result.repository);
  if (result.status === 'draft-created' && result.needsReview)
    return `📝 ${repository}: [Needs review] draft PR ready ${result.reason}`;
  if (result.status === 'draft-created')
    return `✅ ${repository}: validated fix, draft PR ready ${result.reason}`;
  if (result.status === 'validation-failed' && result.validation === 'regression')
    return `🚨 [URGENT] ${repository}: the patch breaks the repository's own checks (regression); not published.`;
  if (result.status === 'error' && result.stage === 'publication')
    return `🚨 [URGENT] ${repository}: publication failed partway (${plain(result.error?.message ?? result.reason)}); a remote branch or draft PR may remain, reconcile before retrying.`;
  return null;
}

// The hosted worker rate-limits these per target; the receipt holds the full error and evidence.
export function hostedFailureNotice(job: {
  id: string;
  repository: string;
  outcome: string | null;
  message: string | null;
}) {
  return `🚨 [URGENT] ${plain(job.repository)}: hosted job ${plain(job.id)} failed (${plain(`${job.outcome ?? 'no receipt'}: ${job.message ?? 'no message'}`)}); see refit hosted receipt ${plain(job.id)}.`;
}

export const URGENT_DEADLINE_DAYS = 7;

// Deadline alerts already fire once per lead-time stage; only the last week and after are urgent.
export function deadlineNotice(alert: {
  repository: string;
  title: string;
  stage: number | null;
  timing: string;
  issue: number | null;
}) {
  if (alert.stage === null || alert.stage > URGENT_DEADLINE_DAYS) return null;
  const where = alert.issue
    ? `https://github.com/${alert.repository}/issues/${alert.issue}`
    : 'the GitHub issue could not be updated';
  return `🚨 [URGENT] ${plain(alert.repository)}: ${plain(alert.title)} (${plain(alert.timing)}); ${where}`;
}
