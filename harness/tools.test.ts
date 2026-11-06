import { exec } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentTool, MigrationTask, Recipe } from '../shared/types.ts';
import {
  buildTools,
  findVersionPlaces,
  localRuntimes,
  replaceVersion,
  shellQuote,
  upgradeCommand,
} from './tools.ts';
import type { ExecResult, FinishReport, Sandbox, ToolContext } from './types.ts';

const task = { id: 't1', repo: 'acme/app' } as MigrationTask;
let dir: string;
let outside: string;

function fakeSandbox(root: string): Sandbox {
  return {
    dir: root,
    mode: 'local',
    exec: (command, options) =>
      new Promise<ExecResult>((resolve) => {
        exec(command, { cwd: root, timeout: options?.timeoutMs }, (error, stdout, stderr) => {
          const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
          resolve({ code, stdout, stderr, timedOut: Boolean(error?.killed) });
        });
      }),
    diff: async () => '',
    dispose: async () => {},
  };
}

function setup(overrides: Partial<ToolContext> = {}) {
  const finished: FinishReport[] = [];
  const tools = buildTools({
    sandbox: fakeSandbox(dir),
    task,
    toolPack: { provider: 'stripe', tools: [], playbooks: {} },
    retrieveRecipes: async () => [],
    checks: [],
    onFinish: (report) => finished.push(report),
    ...overrides,
  });
  const call = (name: string, input: unknown = {}) => {
    const found = tools.find((tool) => tool.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found.run(input, { repoDir: dir });
  };
  return { tools, call, finished };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'refit-tools-'));
  outside = await mkdtemp(path.join(tmpdir(), 'refit-outside-'));
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'node_modules/pkg'), { recursive: true });
  await writeFile(
    path.join(dir, 'src/pay.ts'),
    "const a = 1;\nstripe.charges.create();\nconst b = 'x';\n",
  );
  await writeFile(path.join(dir, 'node_modules/pkg/index.js'), 'stripe.charges.create();\n');
  await writeFile(path.join(outside, 'secret.txt'), 'outside');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('file tools', () => {
  it('lists files without node_modules', async () => {
    const { call } = setup();
    expect(await call('list_files')).toBe('src/\n  pay.ts');
  });

  it('reads numbered lines with offset and limit', async () => {
    const { call } = setup();
    expect(await call('read_file', { path: 'src/pay.ts', offset: 2, limit: 1 })).toBe(
      '2\tstripe.charges.create();\n[lines 2-2 of 4]',
    );
  });

  it('writes and edits files', async () => {
    const { call } = setup();
    expect(await call('write_file', { path: 'lib/new.ts', content: 'x x' })).toBe(
      'wrote lib/new.ts (3 bytes)',
    );
    expect(await call('edit_file', { path: 'lib/new.ts', old: 'x', new: 'y' })).toMatch(
      /appears 2 times/,
    );
    expect(await call('edit_file', { path: 'lib/new.ts', old: 'z', new: 'y' })).toMatch(
      /not found/,
    );
    expect(
      await call('edit_file', { path: 'lib/new.ts', old: 'x', new: '$&y', replaceAll: true }),
    ).toBe('edited lib/new.ts (2 replacements)');
    expect(await readFile(path.join(dir, 'lib/new.ts'), 'utf8')).toBe('$&y $&y');
  });

  it('searches with a regex and glob, skipping node_modules', async () => {
    const { call } = setup();
    expect(await call('search', { pattern: 'charges\\.create' })).toBe(
      'src/pay.ts:2: stripe.charges.create();',
    );
    expect(await call('search', { pattern: 'charges', glob: '*.js' })).toBe('no matches');
    expect(await call('search', { pattern: '(' })).toMatch(/^error: Invalid regular expression/);
  });

  it('refuses paths outside the sandbox', async () => {
    const { call } = setup();
    await symlink(outside, path.join(dir, 'escape'));
    await symlink(path.join(outside, 'missing'), path.join(dir, 'dangling'));
    const attempts: [string, unknown][] = [
      ['read_file', { path: '../secret.txt' }],
      ['read_file', { path: path.join(outside, 'secret.txt') }],
      ['read_file', { path: 'escape/secret.txt' }],
      ['write_file', { path: 'escape/new.txt', content: 'x' }],
      ['write_file', { path: 'dangling', content: 'x' }],
      ['list_files', { path: '..' }],
      ['search', { pattern: 'x', path: 'escape' }],
    ];
    for (const [name, input] of attempts) {
      expect(await call(name, input), name).toBe('error: path is outside the sandbox');
    }
    expect(await call('read_file', { path: path.join(dir, 'src/pay.ts') })).toMatch(/^1\t/);
  });

  it('turns bad input and filesystem errors into text', async () => {
    const { call } = setup();
    expect(await call('read_file', {})).toBe('error: "path" must be a string');
    expect(await call('read_file', null)).toBe('error: "path" must be a string');
    expect(await call('read_file', { path: 'nope.ts' })).toMatch(/^error: ENOENT/);
  });
});

describe('shell, install and checks', () => {
  it('runs shell commands in the sandbox and redacts secrets', async () => {
    const { call } = setup();
    const out = await call('shell', { command: 'pwd; echo sk_live_abcdefghijklmnop1234; exit 3' });
    expect(out).toMatch(/^exit code: 3\n/);
    expect(out).toContain('refit-tools-');
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('sk_live_');
  });

  it('truncates long output and says how much was cut', async () => {
    const { call } = setup();
    const out = await call('shell', {
      command: 'node -e "process.stdout.write(\'a\'.repeat(50000))"',
    });
    expect(out).toMatch(/\[\.\.\. \d+ characters cut \.\.\.\]/);
    expect(out.length).toBeLessThan(20_100);
  });

  it('diff summarises the change per file and shows one file in full', async () => {
    const lockfile = [
      'diff --git a/package-lock.json b/package-lock.json',
      '--- a/package-lock.json',
      '+++ b/package-lock.json',
      '@@ -1,2 +1,3 @@',
      ' {',
      '-  "a": 1',
      '+  "a": 2,',
      '+  "b": 3',
      '',
    ].join('\n');
    const source =
      'diff --git a/src/pay.ts b/src/pay.ts\n--- a/src/pay.ts\n+++ b/src/pay.ts\n@@ -1 +1 @@\n-old\n+new\n';
    const { call } = setup({
      sandbox: { ...fakeSandbox(dir), diff: async () => lockfile + source },
    });
    expect(await call('diff')).toBe('package-lock.json: +2 -1\nsrc/pay.ts: +1 -1');
    expect(await call('diff', { path: 'src/pay.ts' })).toBe(source);
    expect(await call('diff', { path: 'README.md' })).toBe('no change to README.md');
    expect(await setup().call('diff')).toBe('no changes yet');
  });

  it('install reports when there is no package manager', async () => {
    const { call } = setup();
    expect(await call('install')).toMatch(/no lockfile or manifest/);
  });

  it('run_checks explains when nothing was detected, and reports failures', async () => {
    expect(await setup().call('run_checks')).toMatch(/no checks were detected/);
    const { call } = setup({
      checks: [
        { name: 'build', command: 'true' },
        { name: 'test', command: "echo 'FAIL src/a.test.ts > adds'; exit 1" },
      ],
    });
    const out = await call('run_checks');
    expect(out).toContain('## build: pass');
    expect(out).toContain('## test: fail');
    expect(out).toContain('- FAIL src/a.test.ts > adds');
    expect(await call('run_checks', { names: ['lint'] })).toMatch(/Available: build, test/);
  });
});

describe('web, memory, tool pack and finish', () => {
  it('fetches a URL and strips HTML', async () => {
    const fakeFetch = (async () =>
      new Response(
        '<html><head><style>p{}</style><script>alert(1)</script></head><body><h1>Changelog</h1><p>Use &lt;v2&gt;</p></body></html>',
        { headers: { 'content-type': 'text/html' } },
      )) as typeof fetch;
    const { call } = setup({ fetch: fakeFetch });
    expect(await call('fetch_url', { url: 'https://docs.example.com/x' })).toBe(
      'status 200 https://docs.example.com/x\n\nChangelog\nUse <v2>',
    );
    expect(await call('fetch_url', { url: 'file:///etc/passwd' })).toMatch(/only http and https/);
  });

  it('formats recipes', async () => {
    expect(await setup().call('retrieve_recipes')).toBe('no recipes yet');
    const recipe: Recipe = {
      id: 'r1',
      provider: 'stripe',
      kind: 'sdk-major',
      preconditions: 'stripe-node 12',
      steps: '1. bump',
      pitfalls: 'none',
      sourceRuns: [],
      verifiedRepos: 2,
    };
    const out = await setup({ retrieveRecipes: async () => [recipe] }).call('retrieve_recipes');
    expect(out).toContain('#### r1 (stripe / sdk-major, verified on 2 repos)');
    expect(out).toContain('Steps: 1. bump');
  });

  it('exposes tool pack tools with safe names and catches their errors', async () => {
    const packTools: AgentTool[] = [
      {
        name: 'lookup version!',
        description: 'Look up an API version',
        inputSchema: { type: 'object', properties: {} },
        run: async (_input, context) => `repo at ${context.repoDir}`,
      },
      {
        name: 'broken',
        description: 'Always throws',
        inputSchema: { type: 'object', properties: {} },
        run: async () => {
          throw new Error('boom');
        },
      },
    ];
    const { tools, call } = setup({
      toolPack: { provider: 'stripe', tools: packTools, playbooks: {} },
    });
    expect(tools.map((tool) => tool.name)).toContain('stripe__lookup_version_');
    expect(await call('stripe__lookup_version_')).toBe(`repo at ${dir}`);
    expect(await call('stripe__broken')).toBe('error: boom');
  });

  it('finish records a leniently parsed report', async () => {
    const { call, finished } = setup();
    const out = await call('finish', {
      verdict: 'migrated',
      summary: 'Moved to PaymentIntents',
      why: 'Charges API removed',
      validators: [{ name: 'tsc', passed: true, detail: 'clean' }, 'junk'],
    });
    expect(out).toMatch(/re-run the checks/);
    expect(finished).toEqual([
      {
        verdict: 'migrated',
        summary: 'Moved to PaymentIntents',
        why: 'Charges API removed',
        validators: [
          { name: 'tsc', passed: true, detail: 'clean' },
          { name: '', passed: false, detail: '' },
        ],
        unproven: [],
        behaviourChanges: [],
      },
    ]);
  });

  it('every tool has an object input schema and never throws', async () => {
    const { tools } = setup();
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
      if (tool.name === 'finish' || tool.name === 'install' || tool.name === 'shell') continue;
      await expect(tool.run(undefined, { repoDir: dir })).resolves.toBeTypeOf('string');
    }
  });
});

describe('upgrade tools', () => {
  it('replaceVersion keeps operators and suffixes and moves upper bounds', () => {
    expect(replaceVersion('^18.2.0', '22.11.0')).toBe('^22.11.0');
    expect(replaceVersion('>=18', '22.11.0')).toBe('>=22');
    expect(replaceVersion('nodejs16.x', '22')).toBe('nodejs22.x');
    expect(replaceVersion('v2', 'v4')).toBe('v4');
    expect(replaceVersion('18-bookworm', '22')).toBe('22-bookworm');
    expect(replaceVersion('>=2,<3', '11.1.0')).toBe('>=11,<12');
    expect(replaceVersion('3.9', '3.12')).toBe('3.12');
    expect(replaceVersion('[16, 18]', '22')).toBeUndefined();
    expect(replaceVersion('${{ matrix.node }}', '22')).toBeUndefined();
    expect(replaceVersion('^16 || ^18', '22')).toBeUndefined();
    expect(replaceVersion('a'.repeat(40), '4')).toBeUndefined();
  });

  it('finds every place a runtime is declared, outside lockfiles and node_modules', async () => {
    await mkdir(path.join(dir, '.github/workflows'), { recursive: true });
    await writeFile(
      path.join(dir, 'package.json'),
      '{\n  "engines": { "node": ">=18" },\n  "dependencies": { "stripe": "^14.0.0" }\n}\n',
    );
    await writeFile(path.join(dir, 'package-lock.json'), '{ "node": "18" }\n');
    await writeFile(path.join(dir, '.nvmrc'), '18\n');
    await writeFile(path.join(dir, 'Dockerfile'), 'FROM --platform=linux/amd64 node:18-alpine\n');
    await writeFile(path.join(dir, 'serverless.yml'), 'provider:\n  runtime: nodejs16.x\n');
    await writeFile(
      path.join(dir, '.github/workflows/ci.yml'),
      "steps:\n  - uses: actions/checkout@v2\n  - uses: actions/setup-node@v3\n    with:\n      node-version: '18.x'\n",
    );
    await writeFile(path.join(dir, 'node_modules/pkg/.nvmrc'), '16\n');
    const places = await findVersionPlaces(dir, 'node');
    expect(places.map((p) => `${p.file}:${p.line} ${p.spec}`).sort()).toEqual([
      '.github/workflows/ci.yml:5 18.x',
      '.nvmrc:1 18',
      'Dockerfile:1 18-alpine',
      'package.json:2 >=18',
      'serverless.yml:2 nodejs16.x',
    ]);
    const checkout = await findVersionPlaces(dir, 'actions/checkout');
    expect(checkout.map((p) => p.spec)).toEqual(['v2']);
  });

  it('finds Python declarations and requirement pins', async () => {
    await writeFile(path.join(dir, '.python-version'), '3.9\n');
    await writeFile(
      path.join(dir, 'pyproject.toml'),
      '[project]\nrequires-python = ">=3.9"\ndependencies = ["stripe>=2,<3", "flask"]\n',
    );
    await writeFile(path.join(dir, 'requirements-dev.txt'), 'Stripe==2.60.0  # pinned\n');
    const python = await findVersionPlaces(dir, 'python');
    expect(python.map((p) => `${p.file} ${p.spec}`).sort()).toEqual([
      '.python-version 3.9',
      'pyproject.toml >=3.9',
    ]);
    const stripe = await findVersionPlaces(dir, 'stripe');
    expect(stripe.map((p) => `${p.file} ${p.spec}`).sort()).toEqual([
      'pyproject.toml >=2,<3',
      'requirements-dev.txt ==2.60.0',
    ]);
  });

  it('bump_version lists without apply, then rewrites only the chosen places', async () => {
    await writeFile(path.join(dir, '.nvmrc'), '18\n');
    await writeFile(path.join(dir, 'Dockerfile'), 'FROM node:18-bookworm\n');
    const { call } = setup();
    const listed = await call('bump_version', { dependency: 'node', to: '22' });
    expect(listed).toContain('.nvmrc:1: `18` (version 18 → 22)');
    expect(listed).toContain('apply: true');
    expect(await readFile(path.join(dir, '.nvmrc'), 'utf8')).toBe('18\n');
    const applied = await call('bump_version', {
      dependency: 'node',
      to: '22',
      apply: true,
      places: ['Dockerfile:1'],
    });
    expect(applied).toContain('Dockerfile:1: 18-bookworm → 22-bookworm');
    expect(applied).toContain('Lockfiles were not touched');
    expect(await readFile(path.join(dir, 'Dockerfile'), 'utf8')).toBe('FROM node:22-bookworm\n');
    expect(await readFile(path.join(dir, '.nvmrc'), 'utf8')).toBe('18\n');
    expect(await call('bump_version', { dependency: 'left-pad' })).toContain('Search the repo');
  });

  it('upgradeCommand uses the repo package manager with scripts off, and quotes the package', () => {
    expect(upgradeCommand('npm', undefined, 'next@15.0.3')).toBe(
      "npm install 'next@15.0.3' --ignore-scripts --no-audit --no-fund",
    );
    expect(upgradeCommand('npm', '8', 'x@1', true)).toBe(
      "npx -y npm@8 install 'x@1' --save-dev --ignore-scripts --no-audit --no-fund",
    );
    expect(upgradeCommand('pnpm', '9', 'x@1')).toBe("corepack pnpm@9 add 'x@1' --ignore-scripts");
    expect(upgradeCommand('yarn', '4', 'x@1')).toContain('YARN_ENABLE_SCRIPTS=false');
    expect(upgradeCommand('pip', undefined, 'stripe==11.1.0')).toBe(
      "python3 -m pip install --only-binary=:all: 'stripe==11.1.0'",
    );
    expect(upgradeCommand('npm', undefined, "x'; rm -rf / #")).toContain(
      shellQuote("x'; rm -rf / #"),
    );
    expect(upgradeCommand('none', undefined, 'x')).toBeUndefined();
  });

  it('run_checks on a runtime probes it first and says plainly when it is missing', async () => {
    const seen: string[] = [];
    const runtimes = {
      wrap: (runtime: { name: string; version: string }, command: string) =>
        `RT=${runtime.version} ${command}`,
      probe: async (_s: Sandbox, runtime: { name: string; version: string }) =>
        runtime.version === '22'
          ? { ok: true, detail: 'node 22 available: v22.0.0' }
          : { ok: false, detail: `node ${runtime.version} not available: none` },
    };
    const { call } = setup({
      checks: [
        { name: 'env', command: 'node -e "process.exit(process.env.RT === \'22\' ? 0 : 1)"' },
      ],
      runtimes,
      onRuntime: (runtime) => seen.push(runtime.version),
    });
    expect(await call('run_checks', { runtime: { name: 'node', version: '22' } })).toContain(
      '## env: pass',
    );
    expect(await call('run_checks', { runtime: { name: 'node', version: '99' } })).toContain(
      'node 99 not available',
    );
    expect(seen).toEqual(['22']);
    expect(await call('run_checks')).toContain('## env: fail');
  });

  it('the local runtime stub wraps commands so they run inside the sandbox', () => {
    const node = localRuntimes.wrap({ name: 'node', version: '22' }, "echo 'hi'");
    expect(node).toContain('https://nodejs.org/dist/latest-v22.x');
    expect(node).toContain(`PATH="$refit_node/bin:$PATH" sh -c 'echo '\\''hi'\\'''`);
    expect(localRuntimes.wrap({ name: 'node', version: '22.11.0' }, 'x')).toContain(
      'https://nodejs.org/dist/v22.11.0/',
    );
    expect(localRuntimes.wrap({ name: 'node', version: '22; rm -rf /' }, 'x')).toBe('x');
    expect(localRuntimes.wrap({ name: 'python', version: '3.12' }, 'pytest')).toContain(
      'command -v python3.12',
    );
    expect(localRuntimes.wrap({ name: 'ruby', version: '3' }, 'rake')).toBe('rake');
  });

  it('run_proof says so when the proof tools have not landed, and records results when they have', async () => {
    expect(await setup().call('run_proof', { check: 'axe' })).toContain('not available');
    const runs: { tool: string; passed: boolean }[] = [];
    const { call } = setup({
      runProof: async (check) => ({ check, passed: 'unknown', evidence: ['no browser'] }),
      onToolPackCall: (run) => runs.push(run),
    });
    expect(await call('run_proof', { check: 'axe scan' })).toContain('proof axe scan: unknown');
    expect(runs).toEqual([
      { tool: 'proof_check__axe_scan', passed: false, output: expect.any(String) },
    ]);
  });

  it('exposes upgrade tools under an upgrades__ prefix and records their calls', async () => {
    const runs: string[] = [];
    const upgradeTool: AgentTool = {
      name: 'actionVersions',
      description: 'Illustrative stand-in for F2',
      inputSchema: { type: 'object', properties: {} },
      run: async () => 'actions/checkout: latest v4',
    };
    const { call, tools } = setup({
      upgradeTools: [upgradeTool],
      onToolPackCall: (run) => runs.push(run.tool),
    });
    expect(tools.map((t) => t.name)).toContain('upgrades__actionVersions');
    expect(await call('upgrades__actionVersions')).toBe('actions/checkout: latest v4');
    expect(runs).toEqual(['upgrades__actionVersions']);
  });
});
