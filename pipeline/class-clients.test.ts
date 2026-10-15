import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { compareApiVersion } from './api-version.ts';
import { migrationReviewReason } from './migration-review.ts';
import type { ProviderAdapter } from './providers.ts';

const VERSION = 'before-v1';
const provider: ProviderAdapter = {
  id: 'catalog',
  packageName: '@example/catalog',
  defaultImport: true,
  namedExport: 'Catalog',
  operations: [{ resource: 'customers', method: 'retrieve', schema: 'customer' }],
  propertyRenames: [{ schema: 'customer', removed: 'legacy_name', replacement: 'display_name' }],
  apiVersion: { constructorArgument: 0, property: 'apiVersion', requestArguments: [1] },
};
const schemas = {
  customer: {
    type: 'object',
    properties: { legacy_name: { type: 'string' }, id: { type: 'string' } },
  },
};
const removals = [
  { id: 'name', schema: 'customer', property: 'legacy_name', pointer: '/customer/legacy_name' },
];
const imports = `import Catalog from '@example/catalog';`;
const creation = `new Catalog({ apiVersion: '${VERSION}' })`;
const method = `async name() { const value = await this.client.customers.retrieve('cus'); return value.legacy_name; }`;
function analyze(source: string, extra: Record<string, string> = {}, path = 'service.ts') {
  return analyzeRepository(
    {
      root: '/class-fixture',
      files: [
        { path, content: source },
        ...Object.entries(extra).map(([path, content]) => ({ path, content })),
      ],
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    removals,
    provider,
    schemas,
  );
}

it.each([
  [
    'TypeScript field initializer',
    `${imports} class Service { private client = ${creation}; ${method} }`,
  ],
  [
    'private field',
    `${imports} class Service { #client = ${creation}; ${method.replaceAll('this.client', 'this.#client')} }`,
  ],
  [
    'constructor assignment',
    `${imports} class Service { private client; constructor() { this.client = ${creation}; } ${method} }`,
  ],
  [
    'JavaScript implicit property',
    `${imports} class Service { constructor() { this.client = ${creation}; } ${method} }`,
  ],
  [
    'const client alias',
    `${imports} const shared = ${creation}; class Service { readonly client = shared; ${method} }`,
  ],
  [
    'local constructor client',
    `${imports} class Service { client; constructor() { const client = ${creation}; this.client = client; } ${method} }`,
  ],
  [
    'arrow method',
    `${imports} class Service { client = ${creation}; name = async () => { const value = await this.client.customers.retrieve('cus'); return value.legacy_name; } }`,
  ],
  [
    'local field alias',
    `${imports} class Service { client = ${creation}; ${method.replace('const value = await this.client', 'const client = this.client; const value = await client')} }`,
  ],
  [
    'CommonJS constructor',
    `const Catalog = require('@example/catalog'); class Service { client = ${creation}; ${method} }`,
  ],
])(
  'traces %s through response evidence, scalar edits and API-version declarations',
  (_label, source) => {
    const result = analyze(source, {}, _label.includes('JavaScript') ? 'service.js' : 'service.ts');
    expect(result.sdkCalls).toHaveLength(1);
    expect(result.findings).toMatchObject([{ confidence: 'confirmed' }]);
    expect(result.edits).toHaveLength(1);
    expect(migrationReviewReason(result)).toBeUndefined();
    const version = compareApiVersion(
      VERSION,
      { info: { version: VERSION } },
      { info: { version: 'after-v2' } },
      { configured: true, declarations: result.apiVersionDeclarations },
      'source-verified',
    );
    expect(version.source.status).toBe('verified');
  },
);

it.each([
  [
    'conditional initialization',
    `client; constructor() { if (enabled) this.client = ${creation}; }`,
  ],
  ['lazy initialization', `client; initialize() { this.client = ${creation}; }`],
  ['replacement', `client = ${creation}; reset() { this.client = alternate; }`],
  [
    'resource mutation',
    `client = ${creation}; reset() { this.client.customers.retrieve = alternate; }`,
  ],
  [
    'alias mutation',
    `client = ${creation}; reset() { const alias = this.client; alias.customers.retrieve = alternate; }`,
  ],
  ['instance escape', `client = ${creation}; expose() { mutate(this); }`],
  ['constructor return', `client = ${creation}; constructor() { return otherInstance; }`],
  [
    'client call before initialization',
    `client; constructor() { this.name(); this.client = ${creation}; }`,
  ],
])('keeps %s under review and prevents automatic migration', (_label, members) => {
  const result = analyze(`${imports} class Service { ${members} ${method} }`);
  expect(result.sdkCalls.length).toBeGreaterThan(0);
  expect(result.findings).toMatchObject([
    { confidence: 'review', classClient: { stability: 'review' } },
  ]);
  expect(result.edits).toEqual([]);
  expect(migrationReviewReason(result)).toMatch(/stable class-client provenance/);
});

it.each([
  `const service = new Service(); service.client = other;`,
  `const service = new Service(); (service as any).client = other;`,
  `const service = new Service(); service['client'] = other;`,
  `const service = new Service(); Object.defineProperty(service, 'client', { value: other });`,
  `const service = new Service(); const method = service.name;`,
])('detects outside mutations and borrowed methods: %s', (mutation) => {
  const result = analyze(
    `${imports} export class Service { client = ${creation}; ${method} } ${mutation}`,
  );
  expect(result.findings).toMatchObject([
    { confidence: 'review', classClient: { stability: 'review' } },
  ]);
  expect(result.edits).toEqual([]);
});

it('does not treat injected, static or wrong lexical this values as proven SDK clients', () => {
  for (const source of [
    `${imports} class Service { constructor(private client: Catalog) {} ${method} }`,
    `${imports} class Service { static client = ${creation}; static ${method} }`,
    `${imports} class Service { client = ${creation}; run() { function nested() { return this.client.customers.retrieve('cus'); } } }`,
  ])
    expect(analyze(source).sdkCalls).toEqual([]);
});

it('traces imported clients and keeps mutation evidence across the module graph', () => {
  const source = `import { shared } from './client'; export class Service { client = shared; ${method} }`;
  const client = `${imports} export const shared = ${creation};`;
  expect(analyze(source, { 'client.ts': client }).findings[0].confidence).toBe('confirmed');
  expect(
    analyze(source, { 'client.ts': `${client} shared.customers.retrieve = other;` }).findings[0]
      .confidence,
  ).toBe('review');
  expect(analyze(source, { 'client.ts': `${client} mutate(shared);` }).findings[0].confidence).toBe(
    'confirmed',
  );
});

it('keeps inherited clients under review', () => {
  const source = `${imports} class Service { client = ${creation}; ${method} } class Child extends Service { client = alternate; }`;
  expect(analyze(source).findings[0].confidence).toBe('review');
});

it('preserves class review evidence when the SDK operation has no adapter mapping', () => {
  const source = `${imports} class Service { client = ${creation}; reset() { this.client = other; } async name() { const value = await this.client.unknown.retrieve('cus'); return value.legacy_name; } }`;
  expect(analyze(source).findings).toMatchObject([
    { confidence: 'review', classClient: { stability: 'review' } },
  ]);
});

it('keeps class clients confirmed when a class field only stores the SDK constructor', () => {
  const result = analyze(
    `${imports} class Holder { constructorReference = Catalog; } class Service { client = ${creation}; ${method} }`,
  );
  expect(result.findings[0].confidence).toBe('confirmed');
});

it.each([['client escape', `client = ${creation}; expose() { return this.client; }`]])(
  'keeps class-client reads confirmed after %s',
  (_label, members) => {
    const result = analyze(`${imports} class Service { ${members} ${method} }`);
    expect(result.findings).toMatchObject([{ confidence: 'confirmed' }]);
    expect(result.findings[0].classClient).toBeUndefined();
    expect(migrationReviewReason(result)).toBeUndefined();
  },
);

it('handles constructors with ordinary arrow callbacks without treating their returns as constructor exits', () => {
  const source = `${imports} class Service { client; constructor() { const read = () => { return 'ok'; }; this.client = ${creation}; } ${method} }`;
  expect(analyze(source).findings[0].confidence).toBe('confirmed');
});
