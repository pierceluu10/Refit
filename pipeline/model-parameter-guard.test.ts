import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ts from 'typescript-compiler';
import { afterEach, describe, expect, it } from 'vitest';
import type { DeadlineEntry, DeadlineRegistry } from './deadline-registry.ts';
import { loadParameterChanges } from './model-parameter-changes.ts';
import { DEFAULT_MODEL_PARAMETERS, loadModelParameters } from './model-parameters.ts';
import { proposeModelReplacements, rejectedParametersLeft } from './model-retirements.ts';

const NOW = new Date('2026-10-29T00:00:00Z');

function object(text: string) {
  const file = ts.createSourceFile('x.ts', `const x = ${text};`, ts.ScriptTarget.Latest, true);
  const statement = file.statements[0] as ts.VariableStatement;
  return statement.declarationList.declarations[0].initializer as ts.ObjectLiteralExpression;
}

describe('rejectedParametersLeft', () => {
  it('flags a sampling parameter left in a Claude 4.7+ request', () => {
    expect(
      rejectedParametersLeft({
        object: object("{ model: 'claude-sonnet-5-5', max_tokens: 1, temperature: 0.7 }"),
        provider: 'anthropic',
        to: 'claude-sonnet-5-5',
        call: 'fetch /v1/messages',
        edits: [],
      }),
    ).toContain('would still set temperature');
  });

  it('passes once the planned edit removes it', async () => {
    const changes = await loadParameterChanges();
    const literal = object("{ model: 'claude-sonnet-5-5', temperature: 0.7, top_k: 3 }");
    const change = changes.changes.find((item) => item.id === 'anthropic-sampling-4-7')!;
    const [, temperature, topK] = literal.properties;
    expect(
      rejectedParametersLeft({
        object: literal,
        provider: 'anthropic',
        to: 'claude-sonnet-5-5',
        call: 'messages.create',
        edits: [
          { item: temperature, change },
          { item: topK, change },
        ],
        changes,
      }),
    ).toBeUndefined();
    // One removal planned, one left: still a stop.
    expect(
      rejectedParametersLeft({
        object: literal,
        provider: 'anthropic',
        to: 'claude-sonnet-5-5',
        call: 'messages.create',
        edits: [{ item: temperature, change }],
        changes,
      }),
    ).toContain('would still set top_k');
  });

  it('accepts what the sourced table accepts, and nothing on an earlier Claude', async () => {
    const parameters = await loadModelParameters(DEFAULT_MODEL_PARAMETERS, NOW);
    expect(
      rejectedParametersLeft({
        object: object("{ model: 'claude-sonnet-5-5', temperature: 1 }"),
        provider: 'anthropic',
        to: 'claude-sonnet-5-5',
        call: 'messages.create',
        edits: [],
        parameters,
      }),
    ).toBeUndefined();
    expect(
      rejectedParametersLeft({
        object: object("{ model: 'claude-haiku-4-5-20251001', temperature: 0.7 }"),
        provider: 'anthropic',
        to: 'claude-haiku-4-5-20251001',
        call: 'messages.create',
        edits: [],
      }),
    ).toBeUndefined();
  });

  it('flags Chat Completions tools moving to GPT-6 and sampling on any OpenAI target', () => {
    expect(
      rejectedParametersLeft({
        object: object("{ model: 'gpt-6-luna', tools: [] }"),
        provider: 'openai',
        to: 'gpt-6-luna',
        call: 'chat.completions.create',
        edits: [],
      }),
    ).toContain('tools');
    expect(
      rejectedParametersLeft({
        object: object("{ model: 'gpt-5.6-sol', top_p: 0.5 }"),
        provider: 'openai',
        to: 'gpt-5.6-sol',
        call: 'post /v1/chat/completions',
        edits: [],
      }),
    ).toContain('top_p');
  });
});

// End to end: whatever the request shape and whichever tables are passed, no proposed swap leaves a
// parameter the replacement rejects in the request body.
describe('no swap keeps a rejected parameter', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });
  const entry = (id: string, versions: string[], replacement: string): DeadlineEntry => ({
    id,
    provider: 'anthropic',
    kind: 'model',
    versions,
    date: '2026-12-11',
    summary: `${id} retires.`,
    replacement,
    source: 'https://provider.example/deprecations',
    checkedAt: '2026-10-29',
  });
  const registry: DeadlineRegistry = {
    formatVersion: 1,
    deadlines: [entry('sonnet', ['claude-3-5-sonnet-20241022'], 'claude-sonnet-5-5')],
  };
  const url = "'https://api.anthropic.com/v1/messages'";
  const body =
    "{ model: 'claude-3-5-sonnet-20241022', max_tokens: 300, temperature: 0.7, messages: [] }";
  const shapes: Record<string, string> = {
    'fetch inline': `export const a = () => fetch(${url}, { method: 'POST', body: JSON.stringify(${body}) });`,
    'fetch const': `const payload = ${body};\nexport const a = () => fetch(${url}, { method: 'POST', body: JSON.stringify(payload) });`,
    'axios post': `import axios from 'axios';\nexport const a = () => axios.post(${url}, ${body});`,
    'axios config': `import axios from 'axios';\nexport const a = () => axios({ method: 'post', url: ${url}, data: ${body} });`,
    'fetch with comment': `export const a = () => fetch(${url}, { method: 'POST', body: JSON.stringify({\n  model: 'claude-3-5-sonnet-20241022',\n  temperature: 0.7, // tuned\n  max_tokens: 300,\n  messages: [],\n}) });`,
  };

  for (const [name, source] of Object.entries(shapes))
    for (const tables of ['none', 'changes', 'parameters', 'both'] as const)
      it(`${name}, ${tables}`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'refit-parameter-guard-'));
        roots.push(root);
        for (const [path, content] of Object.entries({
          'package.json': JSON.stringify({ name: 'app', dependencies: { axios: '1.7.0' } }),
          'src/ai.ts': source,
        })) {
          await mkdir(dirname(join(root, path)), { recursive: true });
          await writeFile(join(root, path), content);
        }
        const proposal = await proposeModelReplacements(root, registry, NOW, {
          indirect: true,
          parameterChanges:
            tables === 'changes' || tables === 'both' ? await loadParameterChanges() : undefined,
          parameters:
            tables === 'parameters' || tables === 'both'
              ? await loadModelParameters(DEFAULT_MODEL_PARAMETERS, NOW)
              : undefined,
        });
        const swapped = proposal.patch ?? '';
        const after = swapped
          .split('\n')
          .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
          .join('\n');
        if (after.includes('claude-sonnet-5-5')) expect(after).not.toMatch(/temperature/);
        // Every site either swapped cleanly or stopped; none is silently left.
        expect(proposal.replacements.length + proposal.stops.length).toBeGreaterThan(0);
      });
});
