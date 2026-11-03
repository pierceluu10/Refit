import { Mark } from '../../components/Brand';
import './directions.css';

// The hard limits enforced in code. Source: AGENTS.md on main, 2026-11-01.
export const LIMITS = [
  'Runs your code only inside a sandbox.',
  'Stops at the spending cap you set for each run.',
  'Opens pull requests only. Never merges, never pushes to your default branch.',
  'Never prints or commits a secret.',
];

// One illustrative migration that every direction shows. The Slack change is real: Slack retired
// files.upload in favour of files.uploadV2, which takes a single channel_id instead of channels.
// The repository, call site and check results are made up.
export const EXAMPLE = {
  provider: 'Slack',
  repository: 'acme/notifier',
  oldMethod: 'files.upload',
  newMethod: 'files.uploadV2',
  file: 'src/reports/send.ts',
  callSites: ['src/reports/send.ts:6'],
  number: 12,
  title: 'Move report uploads to files.uploadV2',
  branch: 'refit/slack-files-upload-v2',
  checks: [
    { name: 'Type check', before: 'pass', after: 'pass' },
    { name: 'Build', before: 'pass', after: 'pass' },
    { name: 'Tests', before: '41 passed', after: '41 passed' },
  ],
  unproven: 'Callers that pass several channels in one string. files.uploadV2 takes one channel.',
};

type DiffLine = [' ' | '-' | '+' | '@', string];

const DIFF: DiffLine[] = [
  ['@', '@@ -5,7 +5,7 @@'],
  [' ', 'export async function sendReport(channel: string, report: Buffer) {'],
  ['-', '  await slack.files.upload({'],
  ['-', '    channels: channel,'],
  ['+', '  await slack.files.uploadV2({'],
  ['+', '    channel_id: channel,'],
  [' ', '    file: report,'],
  [' ', "    filename: 'weekly-report.csv',"],
  [' ', '  });'],
  [' ', '}'],
];

const LINE_CLASS = { ' ': '', '-': 'is-removed', '+': 'is-added', '@': 'is-hunk' };

export function Diff({ lines = DIFF }: { lines?: DiffLine[] }) {
  return (
    <pre className="dir-diff" tabIndex={0}>
      {lines.map(([sign, text], index) => (
        <span key={index} className={LINE_CLASS[sign]}>
          <span className="dir-diff-sign" aria-hidden="true">
            {sign === '@' ? ' ' : sign}
          </span>
          {text}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

export function Wordmark() {
  return (
    <a className="dir-wordmark" href="#top" aria-label="Refit, back to top">
      <Mark />
      <span>Refit</span>
    </a>
  );
}
