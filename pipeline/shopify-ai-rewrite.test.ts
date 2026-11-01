import { buildSchema } from 'graphql';
import { afterEach, expect, it, vi } from 'vitest';

const reply = vi.hoisted(() => ({ content: '' }));
vi.mock('./openai.ts', async (actual) => ({
  ...(await actual<typeof import('./openai.ts')>()),
  requestStructuredOutput: async () => ({
    status: 'completed',
    provider: 'openai',
    model: 'gpt-5.6-luna',
    responseId: 'r',
    evidenceHash: 'h',
    usage: null,
    budget: { costUsd: 0.01, spentUsd: 0.01, limitUsd: 1 },
    content: reply.content,
  }),
}));
const { aiReconstructDocument, reconstructionSources } = await import('./shopify-ai-rewrite.ts');

afterEach(() => {
  reply.content = '';
});

// `Product.media` (a list) becomes a connection; `legacyId` becomes `numericId`.
const before = buildSchema(`
  type Image { url: String! }
  type Product { id: ID! legacyId: String! images: [Image!]! title: String }
  type QueryRoot { product(id: ID!): Product }
  schema { query: QueryRoot }
`);
const after = buildSchema(`
  type Image { url: String! }
  type ImageConnection { nodes: [Image!]! }
  type Product { id: ID! numericId: String! images(first: Int!): ImageConnection! title: String! }
  type QueryRoot { product(id: ID!): Product }
  schema { query: QueryRoot }
`);
const ai = { apiKey: 'k', model: 'gpt-5.6-luna' } as never;

// A call whose document is assembled from a field list at runtime.
const BUILT = {
  path: 'app/products.ts',
  content: `import { FIELDS } from './fields';
export const read = (admin, id) =>
  admin.graphql(\`query Product($id: ID!) { product(id: $id) { \${FIELDS.join(' ')} } }\`, { variables: { id } });`,
};
const FIELD_FILE = { path: 'app/fields.ts', content: "export const FIELDS = ['id', 'title'];" };
const reconstruct = (document: string) => {
  reply.content = JSON.stringify({ document, explanation: 'FIELDS is id and title.' });
  return aiReconstructDocument({
    file: BUILT.path,
    line: 3,
    why: 'The document is built at runtime.',
    sources: reconstructionSources(
      [BUILT, FIELD_FILE, { path: 'app/other.ts', content: '' }],
      BUILT.path,
    ),
    before,
    after,
    versions: { before: '2026-01', after: '2026-10' },
    ai,
  });
};

it('reads the call file and the files it imports for a reconstruction', () => {
  expect(
    reconstructionSources(
      [BUILT, FIELD_FILE, { path: 'app/other.ts', content: '' }],
      BUILT.path,
    ).map((file) => file.path),
  ).toEqual([BUILT.path, FIELD_FILE.path]);
});

it('keeps a reconstruction that names only what the code writes and validates on both versions', async () => {
  expect(
    await reconstruct('query Product($id: ID!) { product(id: $id) { id title } }'),
  ).toMatchObject({ status: 'kept', costUsd: 0.01 });
});

it('refuses a reconstruction that invents a name, breaks on either version or is empty', async () => {
  expect(
    await reconstruct('query Product($id: ID!) { product(id: $id) { id handle } }'),
  ).toMatchObject({ status: 'refused', reason: expect.stringContaining('names handle') });
  // `legacyId` is in the code but gone on the target.
  BUILT.content += ' // legacyId';
  expect(
    await reconstruct('query Product($id: ID!) { product(id: $id) { id legacyId } }'),
  ).toMatchObject({
    status: 'refused',
    reason: expect.stringContaining('does not hold on 2026-10'),
  });
  expect(await reconstruct('query Product { product { id } }')).toMatchObject({
    status: 'refused',
    reason: expect.stringContaining('does not validate on 2026-01'),
  });
  expect(await reconstruct('')).toMatchObject({ status: 'refused' });
});
