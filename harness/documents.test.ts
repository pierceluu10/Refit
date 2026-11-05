import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolPack } from '../shared/types.ts';
import { deadDocuments, graphqlDocuments } from './documents.ts';
import type { Sandbox } from './types.ts';

describe('graphqlDocuments', () => {
  it('reads tagged documents and ones passed straight to graphql()', () => {
    const text = [
      'const A = `#graphql\n  query One { shop { name } }`;',
      'await admin.graphql(`mutation Two { thing }`);',
    ].join('\n');
    expect(graphqlDocuments(text).map((doc) => doc.trim())).toEqual([
      'query One { shop { name } }',
      'mutation Two { thing }',
    ]);
  });

  it('leaves out Storefront queries and strips interpolations', () => {
    const text = [
      'await storefront.graphql(`#graphql\n  query Shop { shop { customerAccountUrl } }`);',
      'await admin.graphql(`query Three { shop { name } } ${FRAGMENT}`);',
    ].join('\n');
    expect(graphqlDocuments(text).map((doc) => doc.trim())).toEqual([
      'query Three { shop { name } }',
    ]);
  });

  it('ignores template literals that are not documents', () => {
    expect(graphqlDocuments('const url = `https://example.com/${id}`;')).toEqual([]);
  });
});

describe('deadDocuments', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const sandboxOver = (root: string, files: string) =>
    ({
      dir: root,
      exec: vi.fn(async () => ({ code: 0, stdout: files, stderr: '', timedOut: false })),
    }) as unknown as Sandbox;
  const packWith = (report: string): ToolPack => ({
    provider: 'shopify',
    playbooks: {},
    tools: [
      {
        name: 'shopify_validate_graphql',
        description: '',
        inputSchema: {},
        run: async () => report,
      },
    ],
  });

  it('names what no longer exists, once, and not what an interpolation broke', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'documents-'));
    mkdirSync(path.join(dir, 'app'));
    writeFileSync(path.join(dir, 'app/a.tsx'), 'admin.graphql(`mutation A { x }`);\n'.repeat(2));
    const report = [
      '- line 1:76 error: Field "productVariantUpdate" does not exist on type Mutation.',
      '- line 1:44 error: Unknown type "ProductVariantInput".',
      '- line 1:9 error: Unknown fragment "Parts".',
      '- line 1:9 warning: Argument "input" is deprecated.',
    ].join('\n');
    expect(await deadDocuments(sandboxOver(dir, './app/a.tsx\n'), packWith(report))).toEqual([
      'app/a.tsx: Field "productVariantUpdate" does not exist on type Mutation.',
      'app/a.tsx: Unknown type "ProductVariantInput".',
    ]);
  });

  it('does nothing when the pack has no validator', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'documents-'));
    const sandbox = sandboxOver(dir, '');
    const pack: ToolPack = { provider: 'openai', playbooks: {}, tools: [] };
    expect(await deadDocuments(sandbox, pack)).toEqual([]);
    expect(sandbox.exec).not.toHaveBeenCalled();
  });
});
