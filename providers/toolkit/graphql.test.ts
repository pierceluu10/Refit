import { describe, expect, it } from 'vitest';
import {
  expandCompactSchema,
  formatIssues,
  GraphQLSyntaxError,
  lex,
  namedType,
  parseDocument,
  parseSdl,
  reduceIntrospection,
  schemaFromText,
  validateDocument,
  type ReducedSchema,
} from './graphql.ts';

const SDL = `
"""The root"""
type Query {
  product(id: ID!): Product
  products(first: Int, after: String, query: String = "", sortKey: SortKey): ProductConnection!
  node(id: ID!): Node
  search: SearchResult
}
type Mutation {
  productUpdate(product: ProductUpdateInput!): ProductUpdatePayload
}
interface Node { id: ID! }
type Product implements Node {
  id: ID!
  title: String!
  "old"
  bodyHtml: String @deprecated(reason: "Use \`descriptionHtml\` instead.")
  descriptionHtml: String!
  variants(first: Int!, legacy: Boolean @deprecated(reason: "gone soon")): VariantConnection!
}
type Variant implements Node { id: ID! sku: String }
type ProductConnection { nodes: [Product!]! pageInfo: PageInfo! }
type VariantConnection { nodes: [Variant!]! }
type PageInfo { hasNextPage: Boolean! endCursor: String }
type ProductUpdatePayload { product: Product userErrors: [UserError!]! }
type UserError { field: [String!] message: String! }
union SearchResult = Product | Variant
enum SortKey { TITLE ID }
input ProductUpdateInput { id: ID! title: String descriptionHtml: String handle: String @deprecated }
scalar URL
directive @cached(ttl: Int) on FIELD | QUERY
extend type Product { handle: String! }
`;

const schema = parseSdl(SDL);

describe('lexer and parser', () => {
  it('tokenizes punctuation, strings, numbers and block strings', () => {
    const tokens = lex(
      'query Q($a: Int = -1.5e3) { f(s: "x\\n\\u0041", b: """ hi """) ... on T { x } }',
    );
    expect(tokens.map((t) => t.value)).toContain('...');
    expect(tokens.find((t) => t.kind === 'float')?.value).toBe('-1.5e3');
    expect(tokens.filter((t) => t.kind === 'string').map((t) => t.value)).toEqual(['x\nA', ' hi ']);
  });

  it('parses operations, variables, aliases, fragments and directives', () => {
    const doc = parseDocument(`
      query Get($id: ID!, $n: [Int!]! = [1, 2]) @cached(ttl: 1) {
        p: product(id: $id) { ...F ... on Product { title } ... @include(if: true) { id } }
      }
      fragment F on Product { id }
      { __typename }
    `);
    expect(doc.definitions).toHaveLength(3);
    const op = doc.definitions[0];
    expect(op.kind).toBe('Operation');
    if (op.kind !== 'Operation') return;
    expect(op.variables.map((v) => `${v.name}:${v.type}`)).toEqual(['id:ID!', 'n:[Int!]!']);
    const field = op.selections[0];
    expect(field.kind === 'Field' && field.alias).toBe('p');
  });

  it('reports syntax errors with line and column', () => {
    expect(() => parseDocument('query {\n  product(id: 1 {\n id }\n}')).toThrow(GraphQLSyntaxError);
    try {
      parseDocument('{\n  a\n  b(\n}');
    } catch (error) {
      expect(error).toBeInstanceOf(GraphQLSyntaxError);
      expect((error as GraphQLSyntaxError).line).toBe(4);
    }
    expect(() => parseDocument('')).toThrow(/empty/);
    expect(() => parseDocument('{ a: }')).toThrow(/Expected a name/);
    expect(() => lex('"unterminated')).toThrow(/Unterminated string/);
    expect(() => lex('{ a ^ }')).toThrow(/Unexpected character/);
  });

  it('parses SDL into a reduced schema', () => {
    expect(schema.queryType).toBe('Query');
    expect(schema.types.Product.fields?.bodyHtml.isDeprecated).toBe(true);
    expect(schema.types.Product.fields?.handle.type).toBe('String!');
    expect(schema.types.Query.fields?.products.args).toMatchObject({
      query: 'String',
      first: 'Int',
    });
    expect(schema.types.Node.possibleTypes).toEqual(['Product', 'Variant']);
    expect(schema.types.SearchResult.possibleTypes).toEqual(['Product', 'Variant']);
    expect(schema.types.SortKey.enumValues).toEqual(['TITLE', 'ID']);
    expect(namedType('[Product!]!')).toBe('Product');
  });
});

describe('introspection and compact schemas', () => {
  const introspection = {
    data: {
      __schema: {
        queryType: { name: 'QueryRoot' },
        mutationType: null,
        types: [
          {
            kind: 'OBJECT',
            name: 'QueryRoot',
            fields: [
              {
                name: 'shop',
                type: { kind: 'NON_NULL', ofType: { kind: 'OBJECT', name: 'Shop' } },
                args: [
                  {
                    name: 'first',
                    type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'Int' } },
                    defaultValue: '10',
                  },
                ],
              },
            ],
          },
          {
            kind: 'OBJECT',
            name: 'Shop',
            fields: [
              {
                name: 'name',
                type: { kind: 'SCALAR', name: 'String' },
                isDeprecated: true,
                deprecationReason: 'x',
              },
            ],
          },
          { kind: 'OBJECT', name: '__Type', fields: [] },
        ],
      },
    },
  };

  it('reduces introspection and drops the "!" from args with defaults', () => {
    const reduced = reduceIntrospection(introspection);
    expect(reduced.complete).toBe(true);
    expect(reduced.types.QueryRoot.fields?.shop.type).toBe('Shop!');
    expect(reduced.types.QueryRoot.fields?.shop.args?.first).toBe('Int');
    expect(reduced.types.Shop.fields?.name.deprecationReason).toBe('x');
    expect(reduced.types.__Type).toBeUndefined();
    expect(() => reduceIntrospection({})).toThrow(/introspection/);
  });

  it('expands the compact encoding and detects formats from text', () => {
    const compact = {
      queryType: 'Q',
      complete: false,
      types: {
        Q: {
          kind: 'OBJECT',
          fields: { a: '(id: ID!, n: Int): A', old: { sig: 'String', deprecated: 'gone' } },
          stubFields: { other: 'Other' },
        },
      },
    };
    const expanded = expandCompactSchema(compact);
    expect(expanded.types.Q.fields?.a).toEqual({ type: 'A', args: { id: 'ID!', n: 'Int' } });
    expect(expanded.types.Q.fields?.old).toMatchObject({
      isDeprecated: true,
      deprecationReason: 'gone',
    });
    expect(expanded.types.Q.fields?.other).toEqual({ type: 'Other', stub: true });
    expect(schemaFromText(JSON.stringify(compact)).types.Q.fields?.a.type).toBe('A');
    expect(schemaFromText(JSON.stringify(introspection)).types.Shop).toBeDefined();
    expect(schemaFromText('type Query { a: Int }').queryType).toBe('Query');
  });
});

describe('validateDocument', () => {
  const messages = (source: string, s: ReducedSchema = schema, opts = {}) =>
    validateDocument(source, s, opts).issues.map((i) => `${i.severity}: ${i.message}`);

  it('accepts a valid document', () => {
    const result = validateDocument(
      'query($id: ID!) { product(id: $id) { id title ...V } } fragment V on Product { variants(first: 5) { nodes { sku } } }',
      schema,
    );
    expect(result.issues).toEqual([]);
    expect(result.checkedFields).toBeGreaterThan(3);
  });

  it('flags unknown fields with suggestions and history', () => {
    const old = parseSdl('type Query { a: Int } type Product { images: [String] }');
    const out = messages('{ product(id: "1") { titel images } }', schema, {
      history: [{ label: '2024-01', schema: old }],
    });
    expect(out.some((m) => m.includes('"titel"') && m.includes('Did you mean "title"'))).toBe(true);
    expect(out.some((m) => m.includes('"images"') && m.includes('exists in 2024-01'))).toBe(true);
  });

  it('flags deprecated fields and arguments', () => {
    const out = messages(
      '{ product(id: "1") { bodyHtml variants(first: 1, legacy: true) { nodes { id } } } }',
    );
    expect(out).toContain(
      'warning: Product.bodyHtml is deprecated: Use `descriptionHtml` instead.',
    );
    expect(out.some((m) => m.includes('"legacy"') && m.includes('gone soon'))).toBe(true);
  });

  it('flags unknown and missing required arguments', () => {
    const out = messages('{ product(idd: "1") { variants { nodes { id } } } }');
    expect(out.some((m) => m.includes('Unknown argument "idd"') && m.includes('"id"'))).toBe(true);
    expect(out.some((m) => m.includes('Missing required argument "id: ID!"'))).toBe(true);
    expect(out.some((m) => m.includes('Missing required argument "first: Int!"'))).toBe(true);
  });

  it('checks selection sets, unions and fragment types', () => {
    const out = messages(
      '{ product(id: "1") { title { x } variants(first: 1) } search { id } ...X } fragment F on Nope { id } fragment X on Query { search { ... on Product { id } } }',
    );
    expect(out.some((m) => m.includes('remove its selection set'))).toBe(true);
    expect(out.some((m) => m.includes('needs a selection set'))).toBe(true);
    expect(out.some((m) => m.includes('directly on union SearchResult'))).toBe(true);
    expect(out.some((m) => m.includes('Unknown type "Nope"'))).toBe(true);
    expect(out.some((m) => m.includes('Fragment "F" is never used'))).toBe(true);
  });

  it('checks variables and input objects', () => {
    const out = messages(
      'mutation M($p: ProductUpdateInput!, $unused: Int, $bad: Product) { productUpdate(product: { titel: "x", handle: "h" }) { product { id } userErrors { message } } a: productUpdate(product: $p) { product { id } } b: productUpdate(product: $missing) { userErrors { field } } }',
      schema,
      { variables: { other: 1 } },
    );
    expect(
      out.some(
        (m) => m.includes('"titel" does not exist on ProductUpdateInput') && m.includes('"title"'),
      ),
    ).toBe(true);
    expect(out.some((m) => m.includes('Missing required input field "id: ID!"'))).toBe(true);
    expect(out.some((m) => m.includes('ProductUpdateInput.handle is deprecated'))).toBe(true);
    expect(out.some((m) => m.includes('"$unused" is declared but never used'))).toBe(true);
    expect(out.some((m) => m.includes('"$missing" is used but not declared'))).toBe(true);
    expect(out.some((m) => m.includes('$bad') && m.includes('output type'))).toBe(true);
    expect(out.some((m) => m.includes('Required variable "$p"'))).toBe(true);
    expect(out.some((m) => m.includes('"other" was passed'))).toBe(true);
  });

  it('checks enum literals when enum values are known', () => {
    const out = messages('{ products(sortKey: TITEL) { nodes { id } } }');
    expect(
      out.some(
        (m) => m.includes('"TITEL" is not a value of enum SortKey') && m.includes('"TITLE"'),
      ),
    ).toBe(true);
  });

  it('treats excerpts as "not checked" instead of errors', () => {
    const excerpt: ReducedSchema = {
      queryType: 'Query',
      complete: false,
      types: {
        Query: {
          kind: 'OBJECT',
          fields: { shop: { type: 'Shop!' }, other: { type: 'Other', stub: true } },
          partial: false,
        },
        Shop: { kind: 'OBJECT', partial: true, fields: { name: { type: 'String!' } } },
      },
    };
    const out = messages(
      '{ shop { name plan { x } } other(a: 1) { z } } fragment G on Missing { id }',
      excerpt,
    );
    expect(out.some((m) => m.startsWith('info: Shop.plan is not in the offline excerpt'))).toBe(
      true,
    );
    expect(out.some((m) => m.startsWith('info: Type Other is not in the offline excerpt'))).toBe(
      true,
    );
    expect(
      out.some((m) =>
        m.startsWith('info: Arguments of Query.other are not in the offline excerpt'),
      ),
    ).toBe(true);
    expect(out.some((m) => m.startsWith('info: Type Missing is not in the offline excerpt'))).toBe(
      true,
    );
    expect(out.some((m) => m.startsWith('error:') && !m.includes('never used'))).toBe(false);
  });

  it('returns syntax errors as issues, never throws', () => {
    const result = validateDocument('{ product(id: "1" { id } }', schema);
    expect(result.issues[0].severity).toBe('error');
    expect(result.issues[0].line).toBe(1);
    expect(formatIssues(result.issues)[0]).toMatch(/^line 1:\d+ error: Syntax error/);
  });

  it('flags operation-level problems', () => {
    const out = messages(
      '{ a: product(id: "1") { id } } query Q { product(id: "1") { id } } query Q { __typename } subscription S { x }',
    );
    expect(out.some((m) => m.includes('anonymous operation must be the only'))).toBe(true);
    expect(out.some((m) => m.includes('Operation "Q" is defined more than once'))).toBe(true);
    expect(out.some((m) => m.includes('no subscription root type'))).toBe(true);
  });
});
