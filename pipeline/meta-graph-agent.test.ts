import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { agentWorkspace, requestsBelowTarget, workspaceDiff } from './meta-graph-agent.ts';
import { scanGraphCalls } from './meta-graph-calls.ts';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directory(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-meta-agent-test-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

it('diffs the workspace against the original in a patch git applies to the original', async () => {
  const original = await directory({
    'src/a.js': "fetch('https://graph.facebook.com/v19.0/me');\n",
    'node_modules/x/index.js': 'ignored',
  });
  const workspace = await agentWorkspace(original, null);
  roots.push(workspace);
  await writeFile(join(workspace, 'src/a.js'), "fetch('https://graph.facebook.com/v25.0/me');\n");
  await writeFile(join(workspace, 'src/b.js'), 'export {};\n');
  const diff = await workspaceDiff(workspace);
  expect(diff).toContain('--- "a/src/a.js"');
  expect(diff).toContain('new file mode 100644');
  expect(diff).not.toContain('node_modules');
  await writeFile(join(original, '..', 'agent-test.patch'), diff);
  roots.push(join(original, '..', 'agent-test.patch'));
  await exec('git', ['apply', join(original, '..', 'agent-test.patch')], { cwd: original });
  expect(await readFile(join(original, 'src/a.js'), 'utf8')).toContain('v25.0');
  expect(await readFile(join(original, 'src/b.js'), 'utf8')).toBe('export {};\n');
});

it('starts the workspace from the deterministic patch', async () => {
  const original = await directory({ 'a.js': 'one\n' });
  const workspace = await agentWorkspace(
    original,
    'diff --git "a/a.js" "b/a.js"\n--- "a/a.js"\n+++ "b/a.js"\n@@ -1,1 +1,1 @@\n-one\n+two\n',
  );
  roots.push(workspace);
  expect(await readFile(join(workspace, 'a.js'), 'utf8')).toBe('two\n');
  expect(await workspaceDiff(workspace)).toContain('+two');
});

it('lists live requests below the target or with no readable version', async () => {
  const root = await directory({
    'a.js': `fetch('https://graph.facebook.com/v19.0/me');
fetch('https://graph.facebook.com/v25.0/me');
fetch(\`https://graph.facebook.com/\${process.env.V}/me\`);`,
  });
  const { calls } = await scanGraphCalls(root);
  expect(requestsBelowTarget(calls, 'v25.0')).toEqual([
    expect.stringMatching(/^a\.js:1: .* still sends v19\.0, not v25\.0$/),
    expect.stringMatching(/^a\.js:3: .* sends no Graph API version Refit can read/),
  ]);
});
