import { expect, it } from 'vitest';
import {
  captureDocSnapshot,
  passagesFromDocSnapshot,
  readDocSnapshotValue,
} from './doc-snapshots.ts';
import {
  createPassageIndex,
  MAX_PASSAGE_CHARACTERS,
  passageId,
  passagesFromPage,
  passagesFromSpecification,
} from './passages.ts';
import { digest } from './specifications.ts';

const PAGE = {
  provider: 'stripe',
  sourceUrl: 'https://docs.example.test/charges',
  pageSha256: 'a'.repeat(64),
  kind: 'doc' as const,
  content: `# Charges

<nav>Skip to content</nav>

## charges

PaymentIntent.charges was removed from paymentIntents.retrieve responses.

\`\`\`js
const noise = true;
\`\`\`

Use the charges list filtered by payment_intent.
`,
};

it('splits headings into stable passages and drops navigation and code samples', async () => {
  const first = passagesFromPage(PAGE);
  const second = passagesFromPage(PAGE);
  expect(second).toEqual(first);
  expect(first.every((passage) => passage.text.length <= MAX_PASSAGE_CHARACTERS)).toBe(true);
  expect(first.some((passage) => passage.text.includes('const noise'))).toBe(false);
  expect(first.some((passage) => passage.text.includes('Skip to content'))).toBe(false);
  expect(first[0].id).toBe(passageId(PAGE.pageSha256, first[0].headingPath, 0));
  expect(first[0].id).toHaveLength(16);
  const long = 'word '.repeat(800);
  const split = passagesFromPage({ ...PAGE, content: `# Topic\n\n${long}` });
  expect(split.length).toBeGreaterThan(1);
  expect(new Set(split.map((passage) => passage.id)).size).toBe(split.length);
});

it('turns specification descriptions into spec passages and hashes the index', async () => {
  const document = {
    openapi: '3.0.3',
    paths: {
      '/v1/messages': {
        post: {
          operationId: 'messages.create',
          description: 'messages.create accepts max_tokens as the generation limit.',
        },
      },
    },
    components: {
      schemas: {
        Message: {
          properties: {
            max_tokens: {
              type: 'integer',
              description: 'The max_tokens limit for messages.create.',
            },
          },
        },
      },
    },
  };
  const specPassages = passagesFromSpecification({
    provider: 'anthropic',
    document,
    sourceUrl: 'spec://anthropic',
    pageSha256: 'b'.repeat(64),
  });
  expect(specPassages.every((passage) => passage.kind === 'spec-description')).toBe(true);
  expect(
    specPassages.some((passage) => passage.headingPath.join('/') === 'Message/max_tokens'),
  ).toBe(true);
  const index = await createPassageIndex({
    provider: 'anthropic',
    document,
    sourceUrl: 'spec://anthropic',
    pageSha256: 'b'.repeat(64),
  });
  expect(index.sha256).toBe(digest(JSON.stringify(index.passages)));
  expect(
    index.passages.some((passage) => passage.provider === 'stripe' && passage.kind === 'doc'),
  ).toBe(true);
  const snapshot = await captureDocSnapshot(
    { kind: 'file', path: 'pipeline/fixtures/docs/anthropic-messages.md' },
    'anthropic',
  );
  expect(readDocSnapshotValue(snapshot, 'snapshot').hash).toBe(digest(snapshot.content));
  expect(passagesFromDocSnapshot(snapshot).length).toBeGreaterThan(0);
  await expect(
    captureDocSnapshot({ kind: 'https', url: 'https://example.com/docs?x=1' }, 'anthropic'),
  ).rejects.toThrow(/without credentials, fragments or query/);
});
