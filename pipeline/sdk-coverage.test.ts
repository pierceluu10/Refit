import { expect, it } from 'vitest';
import { measureCoverage } from './sdk-coverage.ts';
import type { Repository } from './types.ts';

function repository(files: Record<string, string>): Repository {
  return {
    root: '/coverage-test',
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
}

it('separates traced calls from misses and explains each miss', () => {
  const sites = measureCoverage(
    repository({
      'direct.ts': `import OpenAI from 'openai';
const client = new OpenAI();
export async function ask() { return client.chat.completions.create({ model: 'x', messages: [] }); }`,
      'commonjs.js': `const OpenAI = require('openai');
const openai = new OpenAI();
module.exports = () => openai.chat.completions.create({});`,
      'service.ts': `import OpenAI from 'openai';
export class Service {
  private client = new OpenAI();
  run() { return this.client.responses.create({}); }
}
export function withClient(openai: OpenAI) { return openai.models.list(); }
export async function fromFactory() {
  const client = getClient();
  return client.embeddings.create({});
}
declare function getClient(): OpenAI;`,
      'database.ts': `export const save = (db: any) => db.customers.create({});`,
    }),
    'openai',
  );
  const byExpression = Object.fromEntries(sites.map((site) => [site.expression, site]));
  expect(byExpression['client.chat.completions.create']).toMatchObject({ traced: true });
  expect(byExpression['openai.chat.completions.create']).toMatchObject({
    traced: false,
    reason: 'commonjs-require',
  });
  expect(byExpression['this.client.responses.create']).toMatchObject({ reason: 'class-field' });
  expect(byExpression['openai.models.list']).toMatchObject({ reason: 'parameter' });
  expect(byExpression['client.embeddings.create']).toMatchObject({ reason: 'factory-call' });
  expect(sites.some((site) => site.expression.startsWith('db.'))).toBe(false);
});
