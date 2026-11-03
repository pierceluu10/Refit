import { beforeEach, describe, expect, it } from 'vitest';
import { runPassed } from '../../harness/validators.ts';
import { clearFetchCache } from './fetch.ts';
import { clearSchemaMemory, createGraphqlTools } from './graphql-tools.ts';
import { recordedFetch } from './testing.ts';

const SDL = 'https://docs.github.com/public/fpt/schema.docs.graphql';
const ctx = { repoDir: '.' };

function tools(extra = {}) {
  const [lookup, check] = createGraphqlTools({ fetch: recordedFetch(extra) });
  return { lookup, check };
}

beforeEach(() => {
  clearFetchCache();
  clearSchemaMemory();
});

describe('graphql_lookup on GitHub’s recorded schema', () => {
  it('shows a type with its deprecated fields and the reason', async () => {
    const out = await tools().lookup.run({ schema_url: SDL, type: 'CheckAnnotation' }, ctx);
    expect(out).toContain('OBJECT CheckAnnotation');
    expect(out).toContain(
      '- databaseId: Int [deprecated: `databaseId` will be removed because it does not support 64-bit signed integer identifiers. Use `fullDatabaseId` instead. Removal on 2027-01-01 UTC.]',
    );
    expect(out).toContain('- fullDatabaseId: BigInt');
  });

  it('lists deprecations, finds fields by name and looks up one field', async () => {
    const { lookup } = tools();
    expect(await lookup.run({ schema_url: SDL, deprecated: true }, ctx)).toContain(
      '- CheckAnnotation.databaseId:',
    );
    expect(await lookup.run({ schema_url: SDL, search: 'annotationLevel' }, ctx)).toContain(
      'CheckAnnotation.annotationLevel: CheckAnnotationLevel',
    );
    expect(await lookup.run({ schema_url: SDL, type: 'CheckRun.annotations' }, ctx)).toMatch(
      /- CheckRun\.annotations\(.*first: Int.*\): CheckAnnotationConnection/,
    );
    expect(await lookup.run({ schema_url: SDL, type: 'CheckAnotation' }, ctx)).toContain(
      'Did you mean CheckAnnotation,',
    );
  });
});

describe('graphql_check', () => {
  it('reports unknown and deprecated fields, and the harness grades it failed', async () => {
    const document = `query Annotations($id: ID!) {
  node(id: $id) {
    ... on CheckRun {
      annotations(first: 10) { nodes { databaseId path messag } }
    }
  }
}`;
    const out = await tools().check.run(
      { schema_url: SDL, document, variables: { id: 'CR_1' } },
      ctx,
    );
    expect(out).toContain(`Checked the document against schema file ${SDL}.`);
    expect(out).toMatch(/Result: 1 error\(s\), 1 warning\(s\)/);
    expect(out).toContain('Did you mean "message"?');
    expect(out).toMatch(/warning: .*databaseId is deprecated/);
    expect(runPassed(out)).toBe(false);
  });

  it('passes a document that fits, and the harness grades it passed', async () => {
    const document =
      'query { node(id: "CR_1") { id ... on CheckRun { annotations(first: 5) { totalCount nodes { fullDatabaseId path } } } } }';
    const out = await tools().check.run({ schema_url: SDL, document }, ctx);
    expect(out).toMatch(/Result: 0 error\(s\), 0 warning\(s\)/);
    expect(runPassed(out)).toBe(true);
  });

  it('reports a recorded introspection refusal (a gateway depth limit) as a check that failed to run', async () => {
    const out = await tools().check.run(
      {
        endpoint: 'https://countries.trevorblades.com/graphql',
        document: '{ countries { code } }',
      },
      ctx,
    );
    expect(out).toContain(
      'graphql_check failed to run: introspection of https://countries.trevorblades.com/graphql answered HTTP 413',
    );
    expect(runPassed(out)).toBe(false);
  });

  it('reads an introspection result from an endpoint (hand-written response)', async () => {
    const endpoint = 'https://graphql.example.com/';
    const type = (name: string) => ({ kind: 'SCALAR', name, ofType: null });
    const body = JSON.stringify({
      data: {
        __schema: {
          queryType: { name: 'Query' },
          mutationType: null,
          subscriptionType: null,
          types: [
            {
              kind: 'OBJECT',
              name: 'Query',
              fields: [
                {
                  name: 'ping',
                  args: [],
                  type: type('String'),
                  isDeprecated: true,
                  deprecationReason: 'Use health.',
                },
                {
                  name: 'health',
                  args: [],
                  type: type('String'),
                  isDeprecated: false,
                  deprecationReason: null,
                },
              ],
            },
            { kind: 'SCALAR', name: 'String' },
          ],
        },
      },
    });
    const { check } = tools({
      [`POST ${endpoint}`]: { status: 200, body, contentType: 'application/json' },
    });
    const out = await check.run({ endpoint, document: '{ ping }' }, ctx);
    expect(out).toContain(`Checked the document against introspection of ${endpoint}.`);
    expect(out).toMatch(/warning: .*ping is deprecated: Use health\./);
  });

  it('asks for a document and a schema instead of failing silently', async () => {
    const [, check] = createGraphqlTools({ fetch: null });
    expect(await check.run({}, ctx)).toContain('graphql_check failed to run: pass "document"');
    expect(await check.run({ document: '{ a }' }, ctx)).toContain(
      'graphql_check failed to run: no schema given',
    );
  });
});
