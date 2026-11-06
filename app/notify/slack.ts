const SLACK_TIMEOUT_MS = 10_000;
const LINK_PROTOCOLS = new Set(['http:', 'https:']);

export class SlackRejectedError extends Error {
  status: number;

  constructor(status: number) {
    super(`Slack answered ${status}`);
    this.name = 'SlackRejectedError';
    this.status = status;
  }
}

const escapeMrkdwn = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Whitespace collapses too, so an outside title can't add lines that look like our own.
export const plain = (text: string) => escapeMrkdwn(text.replace(/\s+/g, ' ').trim());

function linkTarget(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  if (!LINK_PROTOCOLS.has(parsed.protocol)) return undefined;
  parsed.username = '';
  parsed.password = '';
  // A raw | would end the URL early and turn the rest into a forged label.
  return escapeMrkdwn(parsed.href).replace(/\|/g, '%7C');
}

export function link(url: string, label: string): string {
  const target = linkTarget(url);
  return target ? `<${target}|${plain(label)}>` : `${plain(label)}: ${plain(url)}`;
}

export async function postToSlack(
  webhookUrl: string,
  text: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    // Callers await this after a run, so a hung Slack must not hang them.
    signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
  });
  await response.body?.cancel();
  if (!response.ok) throw new SlackRejectedError(response.status);
}

// Error messages are never logged: a fetch error may embed the webhook URL.
export function describeFailure(error: unknown): string {
  if (error instanceof SlackRejectedError) return error.message;
  return error instanceof Error ? error.name : 'unknown error';
}
