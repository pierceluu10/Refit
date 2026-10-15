import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { applySourceEdits } from './patches.ts';
import { readProviderAdapter } from './providers.ts';
import { runPipeline } from './run.ts';

const directories: string[] = [];
const MOVE = {
  schema: 'invoice',
  removed: 'subscription',
  replacement: 'parent.subscription_details.subscription',
};
const EXPANDABLE_SUBSCRIPTION = {
  anyOf: [{ maxLength: 5000, type: 'string' }, { $ref: '#/components/schemas/subscription' }],
  'x-expansionResources': { oneOf: [{ $ref: '#/components/schemas/subscription' }] },
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

// Shapes mirror Stripe's published 2025-02-24.acacia and 2025-04-30.basil schemas, including
// basil's other removals named like segments of the new path.
function contracts() {
  const subscription = { type: 'object', properties: { id: { type: 'string' } } };
  const before = {
    openapi: '3.0.0',
    paths: {},
    components: {
      schemas: {
        subscription,
        invoice: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            subscription: {
              ...EXPANDABLE_SUBSCRIPTION,
              description: 'The subscription that this invoice was prepared for, if any.',
              nullable: true,
            },
            subscription_details: {
              anyOf: [{ $ref: '#/components/schemas/subscription_details_data' }],
              nullable: true,
            },
          },
        },
        subscription_details_data: { type: 'object', properties: { metadata: { type: 'object' } } },
        invoiceitem: {
          type: 'object',
          properties: { id: { type: 'string' }, subscription: { ...EXPANDABLE_SUBSCRIPTION } },
        },
      },
    },
  };
  const after = {
    openapi: '3.0.0',
    paths: {},
    components: {
      schemas: {
        subscription,
        invoice: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            parent: {
              anyOf: [{ $ref: '#/components/schemas/invoice_parent' }],
              nullable: true,
            },
          },
        },
        subscription_details_data: { type: 'object', properties: { metadata: { type: 'object' } } },
        invoiceitem: { type: 'object', properties: { id: { type: 'string' } } },
        invoice_parent: {
          type: 'object',
          properties: {
            subscription_details: {
              anyOf: [{ $ref: '#/components/schemas/invoice_subscription_parent' }],
              nullable: true,
            },
          },
        },
        invoice_subscription_parent: {
          type: 'object',
          properties: {
            subscription: {
              ...EXPANDABLE_SUBSCRIPTION,
              description: 'The subscription that generated this invoice',
            },
          },
        },
      },
    },
  };
  return { before, after };
}

async function proposed(input: Promise<Awaited<ReturnType<typeof inputs>>>) {
  const report = await runPipeline(await input);
  if (!('diff' in report.patch)) throw new Error('Expected deterministic patch');
  return { ...report, patch: report.patch };
}

async function inputs(
  source: string,
  options: {
    move?: typeof MOVE;
    edit?: (specifications: ReturnType<typeof contracts>) => void;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'refit-property-moves-'));
  directories.push(root);
  const repository = join(root, 'repository');
  await mkdir(repository);
  await writeFile(
    join(repository, 'package.json'),
    JSON.stringify({ dependencies: { stripe: '17.7.0' } }),
  );
  await writeFile(join(repository, 'billing.ts'), source);
  const specifications = contracts();
  options.edit?.(specifications);
  const before = join(root, 'before.json');
  const after = join(root, 'after.json');
  const providerConfig = join(root, 'provider.json');
  await writeFile(before, JSON.stringify(specifications.before));
  await writeFile(after, JSON.stringify(specifications.after));
  await writeFile(
    providerConfig,
    JSON.stringify({
      id: 'stripe-basil-moves',
      packageName: 'stripe',
      defaultImport: true,
      namedExport: null,
      operations: [{ resource: 'invoices', method: 'retrieve', schema: 'invoice' }],
      propertyRenames: [options.move ?? MOVE],
    }),
  );
  return { repository, before, after, providerConfig, proposePatch: true };
}

const RETRIEVE = `import Stripe from 'stripe';

const stripe = new Stripe('sk_test_placeholder');

export async function invoiceSubscription(id: string) {
  const invoice = await stripe.invoices.retrieve(id);
  return invoice.subscription;
}
`;

it('moves a removed field to its new nested path with optional chaining and a null fallback', async () => {
  const report = await proposed(inputs(RETRIEVE));
  expect(report.findings).toMatchObject([{ expression: '.subscription', confidence: 'confirmed' }]);
  expect(report.patch).toMatchObject({ status: 'proposed', edits: 3, unresolvedFindings: 0 });
  expect(report.patch.diff).toContain(
    '+  return (invoice.parent?.subscription_details?.subscription ?? null);',
  );
});

it('reports but does not move a value known only from its Stripe type', async () => {
  const source = `import Stripe from 'stripe';

export function invoiceSubscription(invoice: Stripe.Invoice) {
  return invoice.subscription;
}
`;
  const report = await proposed(inputs(source));
  expect(report.findings).toMatchObject([
    { expression: '.subscription', confidence: 'confirmed', declaredType: { schema: 'invoice' } },
  ]);
  expect(report.patch).toMatchObject({ edits: 0, unresolvedFindings: 1 });
});

it('keeps the removed field’s null result when any parent on the new path is missing', async () => {
  const source = RETRIEVE.replace('return invoice.subscription;', 'return invoice?.subscription;');
  const report = await proposed(inputs(source));
  const line = report.patch.diff
    .split('\n')
    .find((entry: string) => entry.startsWith('+  return '))!;
  const expression = line.slice('+  return '.length, -1);
  expect(expression).toBe('(invoice?.parent?.subscription_details?.subscription ?? null)');
  const read = new Function('invoice', `return ${expression};`);
  expect(read(undefined)).toBeNull();
  expect(read({ parent: null })).toBeNull();
  expect(read({ parent: { subscription_details: null } })).toBeNull();
  expect(read({ parent: { subscription_details: { subscription: 'sub_123' } } })).toBe('sub_123');
  expect(read({ parent: { subscription_details: { subscription: { id: 'sub_123' } } } })).toEqual({
    id: 'sub_123',
  });
});

it('keeps undefined for an optional non-nullable field behind nullable parents', async () => {
  const report = await proposed(
    inputs(RETRIEVE, {
      edit: ({ before }) => {
        delete (before.components.schemas.invoice.properties.subscription as { nullable?: true })
          .nullable;
      },
    }),
  );
  expect(report.patch).toMatchObject({ status: 'proposed', edits: 1, unresolvedFindings: 0 });
  const line = report.patch.diff
    .split('\n')
    .find((entry: string) => entry.startsWith('+  return '))!;
  const expression = line.slice('+  return '.length, -1);
  expect(expression).toBe('invoice.parent?.subscription_details?.subscription');
  const read = new Function('invoice', `return ${expression};`);
  expect(read({ parent: null })).toBeUndefined();
  expect(read({ parent: { subscription_details: { subscription: 'sub_123' } } })).toBe('sub_123');
});

it('reads required non-nullable intermediates directly without a fallback', async () => {
  const report = await proposed(
    inputs(RETRIEVE, {
      edit: ({ after }) => {
        const schemas = after.components.schemas;
        Object.assign(schemas.invoice, { required: ['parent'] });
        delete (schemas.invoice.properties.parent as { nullable?: boolean }).nullable;
        Object.assign(schemas.invoice_parent, { required: ['subscription_details'] });
        delete (schemas.invoice_parent.properties.subscription_details as { nullable?: boolean })
          .nullable;
      },
    }),
  );
  expect(report.patch).toMatchObject({ status: 'proposed', edits: 1, unresolvedFindings: 0 });
  expect(report.patch.diff).toContain(
    '+  return invoice.parent.subscription_details.subscription;',
  );
});

it('leaves an expandable move for review when a request expands the old field', async () => {
  for (const expand of ["['subscription']", "['data.subscription']", 'fields']) {
    const source = RETRIEVE.replace(
      'stripe.invoices.retrieve(id)',
      `stripe.invoices.retrieve(id, { expand: ${expand} })`,
    ).replace('export async', `const fields = ['subscription'];\n\nexport async`);
    const report = await runPipeline(await inputs(source));
    expect(report.patch, expand).toMatchObject({
      status: 'unsupported',
      edits: 0,
      unresolvedFindings: 1,
    });
  }
});

it('still moves the field when expansions name only other fields', async () => {
  const source = RETRIEVE.replace(
    'stripe.invoices.retrieve(id)',
    "stripe.invoices.retrieve(id, { expand: ['customer'] })",
  );
  const report = await runPipeline(await inputs(source));
  expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 0 });
});

it('moves an expandable field whose new location holds only its ID string, unless expanded', async () => {
  const narrowed = {
    edit: ({ after }: ReturnType<typeof contracts>) => {
      after.components.schemas.invoice_subscription_parent.properties.subscription = {
        maxLength: 5000,
        type: 'string',
      } as never;
    },
  };
  const report = await proposed(inputs(RETRIEVE, narrowed));
  expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 0 });
  expect(report.patch.diff).toContain(
    '+  return (invoice.parent?.subscription_details?.subscription ?? null);',
  );
  const expanded = RETRIEVE.replace(
    'stripe.invoices.retrieve(id)',
    "stripe.invoices.retrieve(id, { expand: ['subscription'] })",
  );
  expect((await runPipeline(await inputs(expanded, narrowed))).patch).toMatchObject({
    status: 'unsupported',
    unresolvedFindings: 1,
  });
});

it('rejects moves the recorded contracts do not support', async () => {
  const cases: [string, Parameters<typeof inputs>[1]][] = [
    [
      'path already present before',
      {
        edit: ({ before, after }) => {
          Object.assign(before.components.schemas, {
            invoice_parent: after.components.schemas.invoice_parent,
            invoice_subscription_parent: after.components.schemas.invoice_subscription_parent,
          });
          Object.assign(before.components.schemas.invoice.properties, {
            parent: after.components.schemas.invoice.properties.parent,
          });
        },
      },
    ],
    [
      'different value shape',
      {
        edit: ({ after }) => {
          after.components.schemas.invoice_subscription_parent.properties.subscription = {
            type: 'string',
          } as never;
        },
      },
    ],
    [
      'required non-nullable value behind nullable parents',
      {
        edit: ({ before }) => {
          Object.assign(before.components.schemas.invoice, { required: ['subscription'] });
          delete (before.components.schemas.invoice.properties.subscription as { nullable?: true })
            .nullable;
        },
      },
    ],
    ['missing path', { move: { ...MOVE, replacement: 'parent.quote_details.subscription' } }],
    ['scalar intermediate', { move: { ...MOVE, replacement: 'id.subscription' } }],
  ];
  for (const [name, options] of cases)
    await expect(runPipeline(await inputs(RETRIEVE, options)), name).rejects.toThrow(
      'Configured move invoice.subscription → invoice.',
    );
});

it('accepts identifier paths up to four segments and rejects longer or prototype paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-property-move-config-'));
  directories.push(root);
  const path = join(root, 'provider.json');
  const write = (replacement: string) =>
    writeFile(
      path,
      JSON.stringify({
        id: 'stripe-basil-moves',
        packageName: 'stripe',
        defaultImport: true,
        namedExport: null,
        operations: [{ resource: 'invoices', method: 'retrieve', schema: 'invoice' }],
        propertyRenames: [{ ...MOVE, replacement }],
      }),
    );
  await write('a.b.c.d');
  expect((await readProviderAdapter(path)).propertyRenames?.[0].replacement).toBe('a.b.c.d');
  for (const replacement of ['a.b.c.d.e', 'parent.__proto__', 'parent..subscription', 'parent.']) {
    await write(replacement);
    await expect(readProviderAdapter(path), replacement).rejects.toThrow(
      'distinct replacement field or dot path of at most 4 identifiers',
    );
  }
});

it('applies the three move edits without overlapping', () => {
  const content = 'x(invoice.subscription)';
  const start = content.indexOf('invoice');
  const name = content.indexOf('subscription');
  expect(
    applySourceEdits(content, [
      { file: 'f', start: name, end: name + 12, replacement: 'parent?.a', changeId: 'c' },
      { file: 'f', start, end: start, replacement: '(', changeId: 'c' },
      { file: 'f', start: name + 12, end: name + 12, replacement: ' ?? null)', changeId: 'c' },
    ]),
  ).toBe('x((invoice.parent?.a ?? null))');
});

it('migrates every curated basil move with the shipped example adapter and real Stripe schemas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-basil-catalog-'));
  directories.push(root);
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ dependencies: { stripe: '17.7.0' } }),
  );
  await writeFile(
    join(root, 'billing.js'),
    `import Stripe from 'stripe';

const stripe = new Stripe('sk_test_placeholder');

export async function invoiceSubscription(id) {
  const invoice = await stripe.invoices.retrieve(id);
  return invoice.subscription;
}

export async function invoiceQuote(id) {
  const invoice = await stripe.invoices.retrieve(id);
  return invoice.quote;
}

export async function itemSubscription(id) {
  const item = await stripe.invoiceItems.retrieve(id);
  return item.subscription;
}

export async function itemSubscriptionItem(id) {
  const item = await stripe.invoiceItems.retrieve(id);
  return item.subscription_item;
}

export async function lineSubscriptionItems(id) {
  const invoice = await stripe.invoices.retrieve(id);
  return invoice.lines.data.map((line) => line.subscription_item);
}

export async function lineInvoiceItems(id) {
  const invoice = await stripe.invoices.retrieve(id);
  return invoice.lines.data.map((line) => line.invoice_item);
}
`,
  );
  const report = await proposed(
    Promise.resolve({
      repository: root,
      before: 'pipeline/fixtures/stripe-basil-moves/before.json',
      after: 'pipeline/fixtures/stripe-basil-moves/after.json',
      providerConfig: 'examples/stripe-basil-moves.provider.json',
      proposePatch: true,
    }),
  );
  expect(report.findings.filter((finding) => finding.confidence === 'confirmed')).toHaveLength(6);
  expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 0 });
  for (const line of [
    '+  return (invoice.parent?.subscription_details?.subscription ?? null);',
    '+  return (invoice.parent?.quote_details?.quote ?? null);',
    '+  return (item.parent?.subscription_details?.subscription ?? null);',
    '+  return item.parent?.subscription_details?.subscription_item;',
    '+  return invoice.lines.data.map((line) => line.parent?.subscription_item_details?.subscription_item);',
    '+  return invoice.lines.data.map((line) => line.parent?.invoice_item_details?.invoice_item);',
  ])
    expect(report.patch.diff).toContain(line);
});
