import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AiRuleTable } from './ai-rules.ts';
import { proposeOpenAiSdkMajor } from './ai-sdk-majors.ts';
import { parameterChange, type ParameterChangeTable } from './model-parameter-changes.ts';
import { applySourceEdits } from './patches.ts';
import type { RuleFixture } from './rule-proposals-accept.ts';
import { FIXTURES } from './rule-proposals.ts';

// The test every accepted proposal gets (pipeline/rule-proposal-fixtures.test.ts): the rule, read
// from its table by the engine, rewrites the fixture's synthetic program or covers its request.

export async function readFixtures(root: string): Promise<RuleFixture[]> {
  const folder = join(root, FIXTURES);
  const files = (await readdir(folder).catch(() => [] as string[])).filter((name) =>
    name.endsWith('.json'),
  );
  return Promise.all(
    files.sort().map(async (name) => JSON.parse(await readFile(join(folder, name), 'utf8'))),
  );
}

async function syntheticRepository(version: string, files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-rule-fixture-'));
  const all = {
    'package.json': JSON.stringify({ name: 'fixture', dependencies: { openai: `^${version}` } }),
    'package-lock.json': JSON.stringify({
      name: 'fixture',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'fixture', dependencies: { openai: `^${version}` } },
        'node_modules/openai': {
          version,
          resolved: `https://registry.npmjs.org/openai/-/openai-${version}.tgz`,
        },
      },
    }),
    ...files,
  };
  for (const [name, content] of Object.entries(all)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

// Problems with one fixture; none means the rule does what its proposal showed.
export async function checkFixture(
  fixture: RuleFixture,
  context: {
    tables: AiRuleTable[];
    parameters: ParameterChangeTable;
    known: (id: string) => boolean;
  },
): Promise<string[]> {
  if (fixture.engine === 'linked')
    return context.known(fixture.rule) ? [] : [`${fixture.rule} is in no table`];
  if (fixture.engine === 'parameter-change') {
    const synthetic = fixture.synthetic as Extract<RuleFixture['synthetic'], { parameter: string }>;
    const change = parameterChange(
      context.parameters,
      fixture.provider,
      synthetic.model,
      synthetic.api as never,
      synthetic.parameter,
    );
    if (!change) return [`no parameter change covers ${synthetic.parameter} on ${synthetic.api}`];
    const problems: string[] = [];
    if (change.id !== fixture.rule)
      problems.push(`${change.id} covers it instead of ${fixture.rule}`);
    if (change.action !== synthetic.action) problems.push(`action is ${change.action}`);
    if (synthetic.action === 'rename' && change.to !== synthetic.to)
      problems.push(`renames to ${change.to}`);
    return problems;
  }
  const synthetic = fixture.synthetic as Extract<RuleFixture['synthetic'], { before: string }>;
  const directory = await syntheticRepository(synthetic.version, {
    [synthetic.file]: synthetic.before,
  });
  try {
    const proposal = await proposeOpenAiSdkMajor(directory, context.tables);
    if (!proposal) return ['the SDK upgrade proposed nothing'];
    const after = applySourceEdits(
      synthetic.before,
      proposal.edits.filter((edit) => edit.file === synthetic.file),
    );
    return [
      ...synthetic.expect
        .filter((text) => !after.includes(text))
        .map((text) => `the rewrite lacks ${text}`),
      ...synthetic.reject
        .filter((text) => after.includes(text))
        .map((text) => `the rewrite still has ${text}`),
      ...proposal.stops
        .filter((stop) => stop.file === synthetic.file && stop.blocking)
        .map((stop) => `stopped: ${stop.reason}`),
    ];
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
