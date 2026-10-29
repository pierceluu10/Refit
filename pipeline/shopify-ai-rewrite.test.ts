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
const { aiRewriteDocument, rewriteProblem } = await import('./shopify-ai-rewrite.ts');

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
const ORIGINAL = 'query Product($id: ID!) { product(id: $id) { id legacyId title } }';
const ai = { apiKey: 'k', model: 'gpt-5.6-luna' } as never;

it('keeps a rewrite that validates and returns every original key with the same type', async () => {
  reply.content = JSON.stringify({
    document: 'query Product($id: ID!) { product(id: $id) { id legacyId: numericId title } }',
    explanation: 'legacyId was renamed numericId.',
  });
  const result = await aiRewriteDocument({
    text: ORIGINAL,
    errors: ['Cannot query field "legacyId" on type "Product".'],
    before,
    after,
    versions: { before: '2026-01', after: '2026-10' },
    ai,
  });
  expect(result).toMatchObject({ status: 'kept', costUsd: 0.01, model: 'gpt-5.6-luna' });
});

it('refuses rewrites that drop a key, change its shape, its variables or its validity', () => {
  const problem = (rewritten: string, original = ORIGINAL) =>
    rewriteProblem(original, rewritten, before, after);
  expect(problem('query Product($id: ID!) { product(id: $id) { id title } }')).toBe(
    'The rewrite no longer returns query:Product.product.legacyId.',
  );
  expect(problem('query Product($id: ID!) { product(id: $id) { id numericId title } }')).toBe(
    'The rewrite no longer returns query:Product.product.legacyId.',
  );
  expect(
    problem('query Product($id: ID) { product(id: $id) { id legacyId: numericId title } }'),
  ).toBe(
    'The rewrite fails the schema proof on the target: Variable "$id" of type "ID" used in position expecting type "ID!".',
  );
  expect(
    problem('query Item($id: ID!) { product(id: $id) { id legacyId: numericId title } }'),
  ).toBe('The rewrite changes an operation, its name or its variables.');
  expect(
    problem(
      'query P($id: ID!) { product(id: $id) { images: images(first: 10) { nodes { url } } } }',
      'query P($id: ID!) { product(id: $id) { images { url } } }',
    ),
  ).toBe(
    'The rewrite fails the schema proof on the target: Product.images changes from [Image!]! to ImageConnection!',
  );
  expect(problem('query {')).toMatch(/^The rewrite does not parse/);
});

it('records a declined rewrite without an edit', async () => {
  reply.content = JSON.stringify({ document: '', explanation: 'The list became a connection.' });
  const result = await aiRewriteDocument({
    text: ORIGINAL,
    errors: [],
    before,
    after,
    versions: { before: '2026-01', after: '2026-10' },
    ai,
  });
  expect(result).toEqual({
    status: 'refused',
    model: 'gpt-5.6-luna',
    costUsd: 0.01,
    reason: 'The model declined: The list became a connection.',
  });
});

it('keeps every key of a document that already fails, under the type the target returns', () => {
  // `legacyId` is already gone from `before` here: the original document fails on it.
  const original = 'query P($id: ID!) { product(id: $id) { id legacyId } }';
  const gone = buildSchema(`
    type Product { id: ID! title: String }
    type QueryRoot { product(id: ID!): Product }
    schema { query: QueryRoot }
  `);
  expect(
    rewriteProblem(original, 'query P($id: ID!) { product(id: $id) { id } }', gone, after),
  ).toBe('The rewrite no longer returns query:P.product.legacyId.');
  expect(
    rewriteProblem(
      original,
      'query P($id: ID!) { product(id: $id) { id legacyId: numericId } }',
      gone,
      after,
    ),
  ).toBeUndefined();
});
