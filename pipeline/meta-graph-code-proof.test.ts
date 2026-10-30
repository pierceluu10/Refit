import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { afterEach, describe, expect, it } from 'vitest';
import type { EvidenceGrade } from './check-selection.ts';
import { META_SDK } from './deadline-exposure.ts';
import { validatedReport } from './fixtures/publication-report.ts';
import { scanGraphCalls } from './meta-graph-calls.ts';
import { checkJsProof, requestStringProof } from './meta-graph-code-proof.ts';
import { metaGraphGrade } from './meta-graph-proof.ts';
import { publicationWaiver } from './publication.ts';
import { readRepository } from './repository.ts';
import { NO_OP_CHECK } from './review.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-meta-graph-code-proof-'));
  roots.push(root);
  for (const [name, content] of Object.entries({
    'package.json': JSON.stringify({ name: 'app' }),
    ...files,
  })) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return readRepository(root, META_SDK);
}

const diffOf = (path: string, before: string, after: string) =>
  createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after);

async function sides(before: string, after: string, path = 'src/graph.js') {
  const original = await repository({ [path]: before });
  const patched = await repository({ [path]: after });
  const { calls } = await scanGraphCalls(patched.root, { repository: patched });
  return { original, patched, calls, diff: diffOf(path, before, after) };
}

const GRAPH = (version: string, fields = 'id,name', extra = '') =>
  `const GRAPH = 'https://graph.facebook.com/${version}';

export async function profile(token) {
  const response = await fetch(\`\${GRAPH}/me?fields=${fields}&access_token=\${token}\`);
  const data = await response.json();
  ${extra}return data;
}
`;

describe('request-string proof', () => {
  it('proves a patch that changes only the version and fields of traced requests', async () => {
    const { original, patched, calls, diff } = await sides(
      GRAPH('v18.0'),
      GRAPH('v21.0', 'id,email'),
    );
    expect(requestStringProof(original, patched, diff, calls)).toEqual({
      proven: true,
      reasons: [],
    });
  });

  it('refuses a patch that also changes logic or response handling', async () => {
    const { original, patched, calls, diff } = await sides(
      GRAPH('v18.0'),
      GRAPH('v21.0', 'id,name', 'if (!data.id) throw new Error();\n  '),
    );
    const proof = requestStringProof(original, patched, diff, calls);
    expect(proof.proven).toBe(false);
    expect(proof.reasons[0]).toContain('changes code, not only string text');
  });

  it('refuses a changed string that builds no Graph request', async () => {
    const before = `${GRAPH('v18.0')}export const label = 'Profile';\n`;
    const after = `${GRAPH('v21.0')}export const label = 'Account';\n`;
    const { original, patched, calls, diff } = await sides(before, after);
    const proof = requestStringProof(original, patched, diff, calls);
    expect(proof.proven).toBe(false);
    expect(proof.reasons).toEqual([
      'src/graph.js:8: the changed string does not build a changed Graph request',
    ]);
  });

  it('refuses a patch that also changes a manifest', async () => {
    const { original, patched, calls, diff } = await sides(GRAPH('v18.0'), GRAPH('v21.0'));
    const proof = requestStringProof(
      original,
      patched,
      `${diff}${diffOf('package.json', '{}\n', '{"x":1}\n')}`,
      calls,
    );
    expect(proof.reasons).toEqual([
      'package.json: the patch changes this file, not only request strings',
    ]);
  });
});

describe('checkJs proof', () => {
  it('proves changed JavaScript TypeScript can type, with no new error', async () => {
    const { original, patched, diff } = await sides(
      "export const limit = (items) => items.slice(0, 5);\nexport const size = 'abc'.length;\n",
      "export const limit = (items) => items.slice(0, 5);\nexport const size = 'abcd'.length + 1;\n",
    );
    expect(checkJsProof(original, patched, diff)).toEqual({ proven: true, reasons: [] });
  });

  it('proves nothing about names it cannot type, such as a parsed response', async () => {
    const { original, patched, diff } = await sides(
      GRAPH('v18.0'),
      GRAPH('v21.0', 'id,name', 'console.log(data.id);\n  '),
    );
    const proof = checkJsProof(original, patched, diff);
    expect(proof.proven).toBe(false);
    expect(proof.reasons.join(' ')).toMatch(/cannot type .*`data`/);
  });

  it('refuses a patch that adds a type error', async () => {
    const { original, patched, diff } = await sides(
      'export const size = 1;\n',
      'export const size = (1).toUpperCase();\n',
    );
    const proof = checkJsProof(original, patched, diff);
    expect(proof.proven).toBe(false);
    expect(proof.reasons[0]).toContain('checkJs reports a new error: src/graph.js TS2339');
  });

  it('leaves TypeScript files to the repository’s own type check', async () => {
    const { original, patched, diff } = await sides(
      'export const size = 1;\n',
      'export const size = 2;\n',
      'src/graph.ts',
    );
    expect(checkJsProof(original, patched, diff).proven).toBe(false);
  });
});

describe('grade', () => {
  const none: EvidenceGrade = {
    letter: 'D',
    level: 'none',
    reason: 'No check covers src/graph.js.',
  };
  const table = { target: 'v21.0', proven: true, requests: [], reasons: [] };
  const proven = { proven: true, reasons: [] };
  const unproven = { proven: false, reasons: ['why'] };

  it('grades a request-string patch C where the checks prove nothing but did not fail', () => {
    expect(
      metaGraphGrade(none, table, undefined, { usable: true, strings: proven, checkJs: unproven }),
    ).toMatchObject({ letter: 'C', level: 'request-strings' });
    expect(
      metaGraphGrade(none, table, undefined, { usable: true, strings: unproven, checkJs: proven }),
    ).toMatchObject({ letter: 'C', level: 'type-check' });
    expect(metaGraphGrade(none, table, undefined, { usable: false })).toMatchObject({
      letter: 'D',
    });
    expect(
      metaGraphGrade(none, table, undefined, { usable: true, strings: unproven, checkJs: unproven })
        ?.reason,
    ).toContain('No passing check covers the changed files (why; why).');
  });

  it('gives D when a live read-only call refuses a changed request', () => {
    expect(
      metaGraphGrade(
        none,
        table,
        {
          proven: false,
          versionAccepted: true,
          probes: [{ file: 'a.js', line: 1, path: '/app', status: 200, missing: ['name'] }],
          reasons: ['a.js:1: did not return name'],
        },
        { usable: true, strings: proven },
      ),
    ).toMatchObject({ letter: 'D' });
  });

  it('lets Meta proof, not checks that ran, lift the no-checks gate', async () => {
    const report = await validatedReport('e'.repeat(40));
    report.validation.command = NO_OP_CHECK.split(' ');
    Object.assign(report.validation, {
      grade: { letter: 'C', level: 'request-strings', reason: 'test' },
    });
    const gates = () => publicationWaiver(report, true)?.map(({ gate }) => gate);
    expect(gates()).toContain('no-checks');
    Object.assign(report, { provider: 'meta-graph' });
    expect(gates()).not.toContain('no-checks');
    Object.assign(report.validation, { grade: { letter: 'D', level: 'none', reason: 'test' } });
    expect(gates()).toContain('no-checks');
  });
});
