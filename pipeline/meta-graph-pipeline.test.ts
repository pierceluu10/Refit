import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { metaGraphSnapshot } from './meta-graph-pipeline.ts';
import { writeMetaGraphRun } from './meta-graph-workflow.ts';
import { runPipeline } from './run.ts';
import { readFile } from 'node:fs/promises';

const roots: string[] = [];
afterEach(async () => {
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

async function run(files: Record<string, string>) {
  const contracts = await directory({
    'before.json': JSON.stringify(await metaGraphSnapshot('v19.0')),
    'after.json': JSON.stringify(await metaGraphSnapshot('v25.0')),
  });
  return runPipeline({
    repository: await directory({ 'package.json': '{"name":"app"}', ...files }),
    before: join(contracts, 'before.json'),
    after: join(contracts, 'after.json'),
    proposePatch: true,
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
    patch: { status: string; diff?: string; unresolvedFindings?: number; reason?: string };
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
      'send.js': `export const send = (phone, to) =>
  fetch(\`https://graph.facebook.com/v19.0/\${phone}/messages\`, {
    method: 'POST',
    body: JSON.stringify({ messaging_product: 'whatsapp', to }),
  });`,
    });
    expect(report.provider).toBe('meta-graph');
    expect(report.status).toBe('affected');
    expect(report.patch.status).toBe('proposed');
    expect(report.patch.diff).toContain(
      '+  fetch(`https://graph.facebook.com/v25.0/${page}/photos`, {',
    );
    expect(report.patch.diff).not.toContain('v25.0/${phone}/messages');
    expect(report.patch.unresolvedFindings).toBe(1);
    expect(report.findings.map((finding) => [finding.file, finding.confidence])).toEqual([
      ['post.js', 'confirmed'],
      ['send.js', 'review'],
    ]);
    expect(report.findings[1].reason).toContain('WhatsApp Business Platform');
  });

  it('proposes no patch when nothing can move, and says why', async () => {
    const report = await run({
      'send.js': `export const send = (phone, to) =>
  fetch(\`https://graph.facebook.com/v19.0/\${phone}/messages\`, {
    method: 'POST',
    body: JSON.stringify({ messaging_product: 'whatsapp', to }),
  });`,
    });
    expect(report.status).toBe('needs-review');
    expect(report.patch).toMatchObject({ status: 'not-generated' });
    expect(report.patch.reason).toContain('WhatsApp Business Platform');
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
