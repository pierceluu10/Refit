import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { widenedLiteralErrors } from './widened-literals.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// A typed `create` whose `events` property accepts only two literals, as a typed SDK declares an
// enum parameter, called from JavaScript the way a setup script does.
const LIBRARY = `export type Event = 'a.created' | 'a.deleted';\nexport declare function create(params: { events: Event[] }): void;\n`;

async function errorsIn(script: string) {
  const root = await mkdtemp(join(tmpdir(), 'refit-widened-'));
  roots.push(root);
  await mkdir(join(root, 'node_modules/lib'), { recursive: true });
  await writeFile(
    join(root, 'node_modules/lib/package.json'),
    '{"name":"lib","types":"index.d.ts"}',
  );
  await writeFile(join(root, 'node_modules/lib/index.d.ts'), LIBRARY);
  await writeFile(join(root, 'setup.mjs'), script);
  const line = script.split('\n').findIndex((text) => text.includes('events:')) + 1;
  const column = script.split('\n')[line - 1].indexOf('events') + 1;
  const error = { file: 'setup.mjs', line, column, code: 'TS2322' };
  return { error, proven: widenedLiteralErrors(root, [error]) };
}

it('clears a const literal list every member of which the property accepts', async () => {
  const { error, proven } = await errorsIn(
    `import { create } from 'lib';\nconst EVENTS = ['a.created', 'a.deleted'];\nfor (const event of EVENTS) console.log(event, EVENTS.length);\ncreate({\n  events: EVENTS,\n});\n`,
  );
  expect(proven).toEqual([error]);
});

it.each([
  ['a literal the type rejects', `const EVENTS = ['a.created', 'b.created'];\n`],
  ['a mutated list', `const EVENTS = ['a.created'];\nEVENTS.push('a.deleted');\n`],
  ['an element written by index', `const EVENTS = ['a.created'];\nEVENTS[0] = 'x';\n`],
  ['a list passed to another function', `const EVENTS = ['a.created'];\nconsole.log(EVENTS);\n`],
  ['an exported list', `export const EVENTS = ['a.created'];\n`],
  ['a let binding', `let EVENTS = ['a.created'];\n`],
  ['a computed element', `const EVENTS = ['a.created', String(1)];\n`],
])('keeps %s', async (_, declaration) => {
  const { proven } = await errorsIn(
    `import { create } from 'lib';\n${declaration}create({\n  events: EVENTS,\n});\n`,
  );
  expect(proven).toEqual([]);
});

it('ignores other error codes and TypeScript files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-widened-'));
  roots.push(root);
  expect(
    widenedLiteralErrors(root, [
      { file: 'setup.mjs', line: 1, column: 1, code: 'TS2345' },
      { file: 'setup.ts', line: 1, column: 1, code: 'TS2322' },
    ]),
  ).toEqual([]);
});
