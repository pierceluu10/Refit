import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { CHECKJS_TSCONFIG, gradeEvidence, selectCheck } from './check-selection.ts';
import { changedRanges, checkJsCoverage } from './checkjs-coverage.ts';
import { typescriptDirectory } from './generated-checks.ts';
import { readRepository } from './repository.ts';
import { typeErrors } from './type-errors.ts';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// stripe-node 23's layout: no `types` field, typings under the `default` export condition, and a
// CommonJS entry whose constructor is also callable, so `require('stripe')(key)` is typed.
const STRIPE_TYPES = `declare namespace StripeConstructor {
  interface StripeConfig { apiVersion?: '2026-09-30.endive' }
  interface SessionCreateParams {
    mode?: 'payment' | 'subscription';
    allowed_payment_method_types?: string[];
    success_url?: string;
  }
  interface Session { id: string; url: string | null }
}
declare class StripeClient {
  constructor(key: string, config?: StripeConstructor.StripeConfig);
  checkout: { sessions: { create(params: StripeConstructor.SessionCreateParams): Promise<StripeConstructor.Session> } };
}
declare const StripeConstructor: typeof StripeClient & {
  (key: string, config?: StripeConstructor.StripeConfig): StripeClient;
};
`;
const STRIPE_PACKAGE = {
  'node_modules/stripe/package.json': JSON.stringify({
    name: 'stripe',
    version: '23.0.0',
    exports: {
      default: {
        import: { types: './esm/stripe.esm.node.d.ts', default: './esm/stripe.esm.node.js' },
        require: { types: './cjs/stripe.cjs.node.d.ts', default: './cjs/stripe.cjs.node.js' },
      },
    },
  }),
  'node_modules/stripe/cjs/stripe.cjs.node.d.ts': `${STRIPE_TYPES}export = StripeConstructor;\n`,
  'node_modules/stripe/esm/stripe.esm.node.d.ts': `${STRIPE_TYPES}export default StripeConstructor;\n`,
};

async function write(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-checkjs-test-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

// The candidate's prepared dependencies, as dependency-preparation.ts archives them.
async function dependencies() {
  const root = await write(STRIPE_PACKAGE);
  await execute('tar', ['-cf', 'dependencies.tar', 'node_modules'], { cwd: root });
  return join(root, 'dependencies.tar');
}

const manifest = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ dependencies: { express: '^4.18.2', stripe: '^23.0.0' }, ...extra });

// dalemoncayo/express-stripe at a18c6d3, cut down: the card rule renames the removed parameter.
const ORIGINAL = `const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();
app.post('/checkout', async (req, res) => {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'payment',
  });
  res.json({ id: session.id });
});
`;
const RENAMED = ORIGINAL.replace('payment_method_types', 'allowed_payment_method_types');

async function scenario(files: Record<string, string>, patched: Record<string, string>) {
  const original = await write(files);
  const candidate = await write({ ...files, ...patched });
  const selection = await selectCheck(await readRepository(original));
  return {
    selection,
    original: await readRepository(original),
    candidate: await readRepository(candidate),
    candidateRoot: candidate,
  };
}

// Runs the selected check's generated configuration with Refit's TypeScript, as the sandbox does
// once the prepared dependencies are unpacked.
async function runCheck(root: string, command: string[]) {
  for (const [path, content] of Object.entries(STRIPE_PACKAGE)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await writeFile(join(root, CHECKJS_TSCONFIG), command.at(-1)!);
  const tsc = join(typescriptDirectory(), 'lib', 'tsc.js');
  const result = await execute(
    process.execPath,
    [tsc, '--noEmit', '--pretty', 'false', '-p', CHECKJS_TSCONFIG],
    { cwd: root },
  ).catch((error: { stdout: string; stderr: string; code: number }) => error);
  return typeErrors({ stdout: result.stdout, stderr: result.stderr });
}

it('selects a checkJs type check for JavaScript that loads stripe only with require()', async () => {
  const { selection } = await scenario(
    { 'package.json': manifest(), 'package-lock.json': '{}', 'app.js': ORIGINAL },
    {},
  );
  expect(selection).toMatchObject({
    kind: 'typecheck',
    compareTypeErrors: true,
    typeCheck: 'checkjs',
    stripeFiles: ['app.js'],
    typeCheckedStripeFiles: ['app.js'],
  });
  expect(selection.command?.[2]).toContain(CHECKJS_TSCONFIG);
  expect(JSON.parse(selection.command!.at(-1)!)).toMatchObject({
    compilerOptions: {
      allowJs: true,
      checkJs: true,
      skipLibCheck: true,
      module: 'node16',
      moduleResolution: 'node16',
    },
    files: ['app.js'],
  });
  expect(selection.reason).toContain(
    'it counts only where TypeScript types the changed Stripe calls',
  );
});

it('proves a typed require() client and catches a removed parameter the patch left', async () => {
  const files = { 'package.json': manifest(), 'package-lock.json': '{}', 'app.js': ORIGINAL };
  const fixed = await scenario(files, { 'app.js': RENAMED });
  const coverage = await checkJsCoverage({
    original: fixed.original,
    patched: fixed.candidate,
    command: fixed.selection.command!,
    changedFiles: ['app.js'],
    dependencies: await dependencies(),
    sdk: '23.0.0',
  });
  expect(coverage).toMatchObject({
    proven: true,
    sdk: '23.0.0',
    typed: [{ file: 'app.js', line: 6, expression: 'allowed_payment_method_types' }],
    untyped: [],
  });
  // Only the fixture's missing express and Node typings, on both sides.
  const stripeErrors = (errors: Awaited<ReturnType<typeof runCheck>>) =>
    errors.filter((error) => !['TS2307', 'TS2580'].includes(error.code));
  expect(stripeErrors(await runCheck(fixed.candidateRoot, fixed.selection.command!))).toEqual([]);
  // The removed parameter, still sent, is a type error against the target stripe-node.
  const broken = await scenario(files, {
    'app.js': ORIGINAL.replace("mode: 'payment'", "mode: 'payment', success_url: '/done'"),
  });
  const errors = stripeErrors(await runCheck(broken.candidateRoot, broken.selection.command!));
  expect(errors).toMatchObject([
    { file: 'app.js', line: 6, code: expect.stringMatching(/^TS(2353|2561)$/) },
  ]);
  expect(errors[0].message).toContain(
    "'payment_method_types' does not exist in type 'SessionCreateParams'",
  );
});

it('does not count a check whose changed Stripe code a wrapper leaves untyped', async () => {
  // The client lives on a holder initialised to null, which JavaScript types as `any`, so the
  // call through it is untyped and tsc could never report the removed parameter.
  const holder = `const Stripe = require('stripe');
const holder = { client: null };
function init(key) {
  holder.client = Stripe(key);
}
module.exports = { holder, init };
`;
  const wrapped = ORIGINAL.replace(
    "const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);",
    "const { holder } = require('./stripe');",
  ).replace('stripe.checkout', 'holder.client.checkout');
  const files = {
    'package.json': manifest(),
    'package-lock.json': '{}',
    'stripe.js': holder,
    'app.js': wrapped,
  };
  const { selection, original, candidate } = await scenario(files, {
    'app.js': wrapped.replace('payment_method_types', 'allowed_payment_method_types'),
  });
  expect(selection).toMatchObject({ typeCheck: 'checkjs', stripeFiles: ['stripe.js'] });
  const coverage = await checkJsCoverage({
    original,
    patched: candidate,
    command: selection.command!,
    changedFiles: ['app.js'],
    dependencies: await dependencies(),
    sdk: '23.0.0',
  });
  expect(coverage).toMatchObject({
    proven: false,
    typed: [],
    untyped: [{ file: 'app.js', line: 6, expression: 'allowed_payment_method_types' }],
  });
  expect(coverage.reason).toContain('so the checkJs check proves nothing about them');
  // Graded, the check then covers nothing and the patch stays at D.
  const grade = await gradeEvidence({
    repository: candidate,
    command: selection.command!,
    changedFiles: ['app.js'],
    checkJs: { counts: false, reason: coverage.reason },
  });
  expect(grade).toMatchObject({ letter: 'D', level: 'none' });
  expect(grade.reason).toContain('The checkJs type check counts for nothing');
});

it('follows each file module kind: CommonJS require in .cjs, untyped createRequire in an ES module', async () => {
  const esm = `import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
export async function pay() {
  return stripe.checkout.sessions.create({
    payment_method_types: ['card'],
  });
}
`;
  const files = {
    'package.json': manifest({ type: 'module' }),
    'package-lock.json': '{}',
    'lib/pay.js': esm,
    'lib/legacy.cjs': ORIGINAL,
  };
  const { selection, original, candidate } = await scenario(files, {
    'lib/pay.js': esm.replace('payment_method_types', 'allowed_payment_method_types'),
    'lib/legacy.cjs': RENAMED,
  });
  expect(selection).toMatchObject({ typeCheck: 'checkjs' });
  const archive = await dependencies();
  const prove = (changedFiles: string[]) =>
    checkJsCoverage({
      original,
      patched: candidate,
      command: selection.command!,
      changedFiles,
      dependencies: archive,
      sdk: '23.0.0',
    });
  // A .cjs file is CommonJS under node16 even in a `type: module` package, so require() is typed.
  expect(await prove(['lib/legacy.cjs'])).toMatchObject({ proven: true });
  // createRequire returns NodeRequire's untyped require, so the ES module's call stays unproven.
  expect(await prove(['lib/pay.js', 'lib/legacy.cjs'])).toMatchObject({
    proven: false,
    untyped: [{ file: 'lib/pay.js', expression: 'allowed_payment_method_types' }],
  });
});

it('grades a proven checkJs check C, labelled as validated by type check', async () => {
  const { selection, candidate } = await scenario(
    { 'package.json': manifest(), 'package-lock.json': '{}', 'app.js': ORIGINAL },
    { 'app.js': RENAMED },
  );
  const grade = await gradeEvidence({
    repository: candidate,
    command: selection.command!,
    changedFiles: ['app.js', 'package.json'],
    checkJs: { counts: true, reason: 'TypeScript types every changed Stripe expression' },
  });
  expect(grade).toEqual({
    letter: 'C',
    level: 'type-check',
    reason:
      'Validated by type check (checkJs), no tests: tsc with checkJs type-checks app.js against the target stripe-node and finds no new error; TypeScript types every changed Stripe expression.',
  });
});

it('refuses the proof without the target stripe-node or with another installed', async () => {
  const { selection, original, candidate } = await scenario(
    { 'package.json': manifest(), 'package-lock.json': '{}', 'app.js': ORIGINAL },
    { 'app.js': RENAMED },
  );
  const options = {
    original,
    patched: candidate,
    command: selection.command!,
    changedFiles: ['app.js'],
  };
  expect(await checkJsCoverage({ ...options, sdk: '23.0.0' })).toMatchObject({ proven: false });
  expect(
    await checkJsCoverage({ ...options, dependencies: await dependencies(), sdk: '24.0.0' }),
  ).toMatchObject({
    proven: false,
    reason: 'the prepared dependencies install stripe-node 23.0.0, not the target 24.0.0',
  });
});

it('reads changed words, never whitespace or line endings', () => {
  expect(changedRanges('a\r\nb\r\nc\r\n', 'a\nB\nc\n')).toEqual([{ start: 2, end: 3 }]);
  // Only the pin's value changed, never the property name or the braces around it.
  const pin = "{ apiVersion: '2026-09-30.endive' }";
  const ranges = changedRanges("{ apiVersion: '2024-06-20' }", pin);
  expect(ranges.length).toBeGreaterThan(0);
  expect(
    ranges.every((range) => range.start >= pin.indexOf("'") && range.end <= pin.lastIndexOf("'")),
  ).toBe(true);
});
