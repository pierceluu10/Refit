import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixWithAgent, type AgentFixInput } from './agent-fix.ts';
import { metaGraphSnapshot } from './meta-graph-pipeline.ts';
import { writeMetaGraphRun } from './meta-graph-workflow.ts';
import { runPipeline } from './run.ts';
import { readFile } from 'node:fs/promises';

vi.mock('./agent-fix.ts', () => ({ fixWithAgent: vi.fn() }));
const agent = vi.mocked(fixWithAgent);

// A stand-in agent: rewrites one file, then grades itself with the judge it was given.
function agentEdits(file: string, from: string, to: string) {
  agent.mockImplementationOnce(async (input: AgentFixInput) => {
    const path = join(input.repoDir, file);
    await writeFile(path, (await readFile(path, 'utf8')).replace(from, to));
    const { passed, errors } = await input.check(input.repoDir);
    return {
      outcome: passed ? 'passed' : 'unproven',
      diff: '',
      errors,
      summary: `Changed ${file}.`,
      costUsd: 0.5,
    };
  });
}

const roots: string[] = [];
afterEach(async () => {
  agent.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directory(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-meta-graph-pipeline-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

async function run(files: Record<string, string>, ai = false) {
  const contracts = await directory({
    'before.json': JSON.stringify(await metaGraphSnapshot('v19.0')),
    'after.json': JSON.stringify(await metaGraphSnapshot('v25.0')),
  });
  return runPipeline({
    repository: await directory({ 'package.json': '{"name":"app"}', ...files }),
    before: join(contracts, 'before.json'),
    after: join(contracts, 'after.json'),
    proposePatch: true,
    ...(ai
      ? { aiPatch: { apiKey: 'key', model: 'claude-sonnet-5-5' }, metaGraphReconstructions: [] }
      : {}),
  }) as unknown as Promise<{
    provider: string;
    status: string;
    findings: {
      file: string;
      line: number;
      confidence: string;
      changeId: string;
      reason: string;
    }[];
    patch: {
      status: string;
      generator?: string;
      diff?: string;
      unresolvedFindings?: number;
      reason?: string;
      warnings?: string[];
      agent?: { outcome: string; errors: string[]; costUsd: number };
    };
  }>;
}

describe('the Meta Graph pipeline', () => {
  it('runs from Meta snapshots and proposes the safe moves, listing the rest for review', async () => {
    const report = await run({
      'post.js': `export const post = (page, token) =>
  fetch(\`https://graph.facebook.com/v19.0/\${page}/photos\`, {
    method: 'POST',
    body: JSON.stringify({ url: 'https://example.com/a.png', access_token: token }),
  });`,
      'send.js': `export const register = (phone, pin) =>
  fetch(\`https://graph.facebook.com/v19.0/\${phone}/register\`, {
    method: 'POST',
    body: JSON.stringify({ messaging_product: 'whatsapp', pin, data_localization_region: 'DE' }),
  });`,
    });
    expect(report.provider).toBe('meta-graph');
    expect(report.status).toBe('affected');
    expect(report.patch.status).toBe('proposed');
    expect(report.patch.diff).toContain(
      '+  fetch(`https://graph.facebook.com/v25.0/${page}/photos`, {',
    );
    expect(report.patch.diff).not.toContain('v25.0/${phone}/register');
    expect(report.patch.unresolvedFindings).toBe(1);
    expect(report.findings.map((finding) => [finding.file, finding.confidence])).toEqual([
      ['post.js', 'confirmed'],
      ['send.js', 'review'],
    ]);
    expect(report.findings[1].reason).toContain('data_localization_region');
  });

  it('counts only real problems as unresolved, and lists caution-only stops as notes', async () => {
    const report = (await run({
      'post.js': `export const post = (page, token) =>
  fetch(\`https://graph.facebook.com/v23.0/\${page}/photos\`, {
    method: 'POST',
    body: JSON.stringify({ url: 'https://example.com/a.png', access_token: token }),
  });`,
      'send.js': `export const send = (phone, to) =>
  fetch(\`https://graph.facebook.com/v23.0/\${phone}/messages\`, {
    method: 'POST',
    body: JSON.stringify({ messaging_product: 'whatsapp', to }),
  });
export const me = () => fetch('https://graph.facebook.com/me?fields=id');`,
    })) as unknown as {
      findings: { file: string; confidence: string }[];
      patch: { status: string; unresolvedFindings: number; warnings: string[] };
    };
    expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 0 });
    expect(report.findings.filter((finding) => finding.confidence === 'review')).toEqual([]);
    expect(
      report.patch.warnings.filter((warning) => warning.startsWith('Left on its version')),
    ).toEqual([expect.stringContaining('send.js:6 GET /me stays on its version')]);
  });

  it('without AI, proposes no patch when nothing can move, and says why', async () => {
    const report = await run({
      'send.js': `export const register = (phone, pin) =>
  fetch(\`https://graph.facebook.com/v19.0/\${phone}/register\`, {
    method: 'POST',
    body: JSON.stringify({ messaging_product: 'whatsapp', pin, data_localization_region: 'DE' }),
  });`,
    });
    expect(report.status).toBe('needs-review');
    expect(report.patch).toMatchObject({ status: 'not-generated' });
    expect(report.patch.reason).toContain('data_localization_region');
  });

  it('with AI, hands what the moves leave to the agent and publishes its judged patch', async () => {
    agentEdits('me.js', '${version}', 'v25.0');
    const report = await run(
      {
        'me.js': `const version = process.env.GRAPH_VERSION;
export const me = () => fetch(\`https://graph.facebook.com/\${version}/me?fields=id\`);`,
      },
      true,
    );
    const input = agent.mock.calls[0][0];
    expect(input).toMatchObject({ provider: 'meta-graph', target: 'v25.0' });
    expect(input.context).toContain('the version is built at runtime');
    expect(input.change).toContain('Move every Meta Graph API request to v25.0.');
    expect(report.status).toBe('affected');
    expect(report.patch).toMatchObject({
      status: 'proposed',
      generator: 'openai',
      unresolvedFindings: 0,
      agent: { outcome: 'passed', errors: [], costUsd: 0.5 },
    });
    expect(report.patch.diff).toContain(
      '+export const me = () => fetch(`https://graph.facebook.com/v25.0/me?fields=id`);',
    );
    expect(report.patch.warnings?.[0]).toContain('An AI agent wrote this patch');
  });

  it('with AI, publishes an unproven agent patch for review with the judge errors left', async () => {
    agentEdits('send.js', 'v19.0', 'v25.0');
    const report = await run(
      {
        'post.js': `export const post = (page, token) =>
  fetch(\`https://graph.facebook.com/v19.0/\${page}/photos\`, {
    method: 'POST',
    body: JSON.stringify({ url: 'https://example.com/a.png', access_token: token }),
  });`,
        'send.js': `export const register = (phone, pin) =>
  fetch(\`https://graph.facebook.com/v19.0/\${phone}/register\`, {
    method: 'POST',
    body: JSON.stringify({ messaging_product: 'whatsapp', pin, data_localization_region: 'DE' }),
  });`,
      },
      true,
    );
    // The agent starts from the moves' patch: post.js is already on the target.
    expect(agent.mock.calls[0][0].context).toContain('v19.0 moved to v25.0');
    expect(report.patch).toMatchObject({ status: 'proposed', generator: 'openai' });
    expect(report.patch.diff).toContain('v25.0/${page}/photos');
    expect(report.patch.diff).toContain('v25.0/${phone}/register');
    expect(report.patch.agent?.outcome).toBe('unproven');
    expect(report.patch.unresolvedFindings).toBeGreaterThan(0);
    expect(report.patch.agent?.errors.join(' ')).toContain('data_localization_region');
    expect(report.patch.warnings?.join(' ')).toContain("Refit's Meta judges still report");
  });

  it('with AI, keeps the moves when the agent produces nothing', async () => {
    agent.mockResolvedValueOnce({
      outcome: 'failed',
      diff: '',
      errors: ['timed out'],
      summary: '',
      costUsd: 0,
    });
    const report = await run(
      {
        'post.js': `export const post = (page, token) =>
  fetch(\`https://graph.facebook.com/v19.0/\${page}/photos\`, {
    method: 'POST',
    body: JSON.stringify({ url: 'https://example.com/a.png', access_token: token }),
  });`,
        'send.js': `// The agent runs once per commit and target.
export const register = (phone, pin) =>
  fetch(\`https://graph.facebook.com/v19.0/\${phone}/register\`, {
    method: 'POST',
    body: JSON.stringify({ messaging_product: 'whatsapp', pin, data_localization_region: 'DE' }),
  });`,
      },
      true,
    );
    expect(report.patch).toMatchObject({
      status: 'proposed',
      generator: 'deterministic',
      unresolvedFindings: 1,
      agent: { outcome: 'failed' },
    });
  });

  it('rejects a snapshot whose change table was edited after it was taken', async () => {
    const snapshot = await metaGraphSnapshot('v25.0');
    const contracts = await directory({
      'before.json': JSON.stringify(await metaGraphSnapshot('v19.0')),
      'after.json': JSON.stringify({ ...snapshot, content: `${snapshot.content} ` }),
    });
    await expect(
      runPipeline({
        repository: await directory({ 'package.json': '{}' }),
        before: join(contracts, 'before.json'),
        after: join(contracts, 'after.json'),
      }),
    ).rejects.toThrow('invalid Meta Graph snapshot provenance or hash');
  });

  it('writes a run configuration whose check covers the Graph request files', async () => {
    const repository = await directory({
      'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run' } }),
      'src/graph.ts': `export const me = () => fetch('https://graph.facebook.com/v19.0/me?fields=id');`,
      'src/graph.test.ts': `import { me } from './graph';\nit('reads', () => me());`,
      'src/other.ts': 'export const other = 1;',
    });
    const work = await directory({});
    const { config, selection } = await writeMetaGraphRun({
      repository,
      directory: work,
      before: 'v19.0',
      target: 'v25.0',
    });
    expect(selection.stripeFiles).toEqual(['src/graph.ts']);
    expect(selection.testedStripeFiles).toEqual(['src/graph.ts']);
    expect(selection.reason).toContain('The tests import Meta Graph code in src/graph.ts');
    expect(JSON.parse(await readFile(config, 'utf8'))).toMatchObject({
      repository,
      before: join(work, 'before.json'),
      after: join(work, 'after.json'),
      prepareDependencies: true,
    });
  });
});
