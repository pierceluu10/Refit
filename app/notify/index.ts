import type { BehindItem, RunRecord, ScanReport } from '../../shared/types.ts';
import { digestMessages, dueItems, finishedMessage, scanMessage } from './messages.ts';
import { PR_REPO } from '../reports.ts';
import { describeFailure, postToSlack } from './slack.ts';
import { readSent, writeSent } from './state.ts';

const DEFAULT_STATE_FILE = '.refit/notified.json';

export type NotifierOptions = {
  webhookUrl?: string;
  stateFile?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export type NotifyRunInput = {
  installationId: number;
  repo: string;
  records: RunRecord[];
  report?: ScanReport;
};

export type Notifier = {
  notifyRun(input: NotifyRunInput): Promise<void>;
  weeklyDigest(reports: ScanReport[]): Promise<void>;
};

const silent = async () => {};

const itemKey = (item: BehindItem) =>
  JSON.stringify([item.repo, item.change.id, item.dependency.name]);

const logFailure = (method: string, error: unknown) =>
  console.error(`notify: ${method} failed: ${describeFailure(error)}`);

// Shared by every notifier: the top-level functions build a new one per call, and calls racing
// on one state file would lose keys.
let turn: Promise<void> = Promise.resolve();
function inTurn(method: string, work: () => Promise<void>): Promise<void> {
  turn = turn.then(() => work().catch((error: unknown) => logFailure(method, error)));
  return turn;
}

export function createNotifier(options: NotifierOptions = {}): Notifier {
  const webhookUrl = options.webhookUrl || process.env.REFIT_SLACK_WEBHOOK_URL;
  if (!webhookUrl) return { notifyRun: silent, weeklyDigest: silent };

  const stateFile = options.stateFile || process.env.REFIT_NOTIFY_STATE_FILE || DEFAULT_STATE_FILE;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const send = (text: string) => postToSlack(webhookUrl, text, fetchImpl);

  async function announcePullRequest({ repo, report }: NotifyRunInput, record: RunRecord) {
    const { pr } = record;
    if (record.outcome !== 'verified' || !pr) return;
    const sent = await readSent(stateFile);
    if (sent.has(pr)) return;
    const title = report?.items.find((item) => item.pr === pr)?.change.title ?? record.taskId;
    await send(finishedMessage(repo, title, pr));
    await writeSent(stateFile, sent.add(pr));
  }

  async function announceDeadlines(report: ScanReport) {
    const due = new Map(dueItems(report, now()).map((item) => [itemKey(item), item]));
    if (due.size === 0) return;
    const sent = await readSent(stateFile);
    const fresh = [...due].filter(([key]) => !sent.has(key));
    if (fresh.length === 0) return;
    const items = fresh.map(([, item]) => item);
    await send(scanMessage(report.repo, items, now()));
    await writeSent(stateFile, [...sent, ...fresh.map(([key]) => key)]);
  }

  return {
    notifyRun: (input) =>
      inTurn('notifyRun', async () => {
        // One failed send must not cost the other PRs or the deadline alert.
        for (const record of input.records) {
          await announcePullRequest(input, record).catch((error: unknown) =>
            logFailure('notifyRun', error),
          );
        }
        if (input.report) await announceDeadlines(input.report);
      }),

    weeklyDigest: (reports) =>
      inTurn('weeklyDigest', async () => {
        for (const message of digestMessages(reports, now())) {
          await send(message).catch((error: unknown) => logFailure('weeklyDigest', error));
        }
      }),
  };
}

// A key is a PR URL or an itemKey, so either names the repo it belongs to.
const keyRepo = (key: string) =>
  key.startsWith('[') ? (JSON.parse(key) as string[])[0] : PR_REPO.exec(key)?.[1];

// Takes its turn like a send, but a failure reaches the caller: the uninstall it serves has to retry.
export function forgetNotified(
  isForgotten: (repo: string) => boolean,
  stateFile = process.env.REFIT_NOTIFY_STATE_FILE || DEFAULT_STATE_FILE,
): Promise<void> {
  const work = turn.then(async () => {
    const sent = await readSent(stateFile);
    const kept = [...sent].filter((key) => {
      const repo = keyRepo(key);
      return repo === undefined || !isForgotten(repo);
    });
    if (kept.length < sent.size) await writeSent(stateFile, kept);
  });
  turn = work.catch(() => undefined);
  return work;
}

export const notifyRun = (input: NotifyRunInput) => createNotifier().notifyRun(input);

export const sendWeeklyDigest = (reports: ScanReport[]) => createNotifier().weeklyDigest(reports);
