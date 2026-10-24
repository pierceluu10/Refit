import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { openEnumRepair } from './stripe-open-enums.ts';

const execute = promisify(execFile);
const TSC = resolve('node_modules/typescript-compiler/bin/tsc');
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// The Checkout call of adityayaduvanshi/Full-Stack-Music-Web-App@90e902f4 (and four forks of the
// same course), as Refit's rules patch leaves it, with its free names declared.
const route = (apiVersion: string, subscriptionData: string) => `import Stripe from 'stripe';
const stripe = new Stripe('sk_test_refit', { apiVersion: '${apiVersion}' });
declare const customer: string;
declare const price: { id: string };
declare const quantity: number;
declare const metadata: any;
declare function getURL(): string;
export async function POST() {
    const session = await stripe.checkout.sessions.create({
      billing_address_collection: 'required',
      customer,
      line_items: [{ price: price.id, quantity }],
      mode: 'subscription',
      allow_promotion_codes: true,
      subscription_data: {
${subscriptionData}
      },
      success_url: \`\${getURL()}/account\`,
      cancel_url: \`\${getURL()}\`,
    });
    return session.id;
}
`;
const ORIGINAL = '        trial_from_plan: true,\n        metadata,';

async function project(version: string) {
  const root = await mkdtemp(join(tmpdir(), 'refit-untyped-sdk-'));
  roots.push(root);
  await writeFile(join(root, 'package.json'), '{ "name": "app", "private": true }\n');
  await execute(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `stripe@${version}`,
      '@types/node@22.10.0',
    ],
    { cwd: root, timeout: 300_000 },
  );
  return async (content: string) => {
    await writeFile(join(root, 'route.ts'), content);
    const result = await execute(
      process.execPath,
      [
        TSC,
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'es2022',
        '--module',
        'nodenext',
        '--moduleResolution',
        'nodenext',
        '--esModuleInterop',
        'route.ts',
      ],
      { cwd: root },
    ).catch((error: { stdout: string }) => error);
    return result.stdout.trim();
  };
}

it.skipIf(!process.env.REFIT_STRIPE_SDK)(
  'keeps trial_from_plan compiling on stripe-node 12 and 23, and still checks its neighbours',
  async () => {
    const [old, upgraded] = await Promise.all([project('12.18.0'), project('23.0.0')]);
    expect(await old(route('2022-11-15', ORIGINAL))).toBe('');
    const original = route('2026-09-30.endive', ORIGINAL);
    const reported = await upgraded(original);
    const match = /^route\.ts\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(reported);
    expect(match).not.toBeNull();
    const [, line, column, code, message] = match!;
    const [repaired] = openEnumRepair(
      [{ path: 'route.ts', content: original }],
      [{ file: 'route.ts', line: Number(line), column: Number(column), code, message }],
      true,
    )!;
    expect(repaired.content).toContain('        ...{ trial_from_plan: true },\n        metadata,');
    expect(await upgraded(repaired.content)).toBe('');
    expect(await old(repaired.content.replace('2026-09-30.endive', '2022-11-15'))).toBe('');
    // The spread exempts only trial_from_plan: a misspelled neighbour still fails.
    expect(await upgraded(repaired.content.replace('metadata,', 'metadat: metadata,'))).toContain(
      "'metadat' does not exist in type 'SubscriptionData'",
    );
  },
  600_000,
);
