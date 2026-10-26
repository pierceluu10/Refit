import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MODEL_ID,
  classify,
  collectChanges,
  rankProviders,
  type ClassifiedChange,
} from '../scripts/provider-family-fit.mjs';
import { MODEL_ID as RETIREMENT_MODEL_ID } from './model-retirements.ts';

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));
const changes = collectChanges(read);
const find = (provider: string, key: string) => {
  const found = changes.find((change) => change.provider === provider && change.key === key);
  if (!found) throw new Error(`No ${provider} change ${key}`);
  return found;
};

describe('classify', () => {
  it('uses the model-retirement rule only for text models with a concrete replacement', () => {
    expect(MODEL_ID.source).toBe(RETIREMENT_MODEL_ID.source);
    const model = { provider: 'openai', shape: 'model-retired' };
    expect(classify({ ...model, key: 'gpt-4.5-preview', replacement: 'gpt-4.1' })).toBe(
      'model-replacement',
    );
    expect(classify({ ...model, key: 'dall-e-3', replacement: 'gpt-image-2' })).toBe('model-stop');
    expect(classify({ ...model, key: 'gpt-4-0314', replacement: null })).toBe('model-stop');
    expect(classify({ ...model, key: 'gpt-4', replacement: 'A supported stable version' })).toBe(
      'model-stop',
    );
  });

  it('refuses a shape it has no rule for', () => {
    expect(() => classify({ provider: 'x', key: 'y', shape: 'renamed' })).toThrow(/Unknown/);
  });
});

describe('collectChanges', () => {
  it('treats a deprecated SDK path that reaches the same resource as an operation replacement', () => {
    expect(find('twilio', 'api.addresses')).toMatchObject({
      family: 'operationReplacements',
      replacement: 'api.account.addresses',
    });
    expect(find('mailgun', 'domains.assignIp')).toMatchObject({
      family: 'symbolReviews',
      replacement: null,
    });
  });

  it('pairs a removed SDK method with the method that serves the same route', () => {
    // ordersCreate and createOrder both POST /v2/checkout/orders in @paypal/paypal-server-sdk.
    expect(find('paypal', 'OrdersController.ordersCreate')).toMatchObject({
      category: 'mechanism',
      replacement: 'OrdersController.createOrder',
    });
    expect(find('paypal', 'OrdersCreateRequest').family).toBe('sdk-replacement');
  });

  it('classifies Meta changes by kind', () => {
    expect(find('meta-graph', 'meta-graph-v14-0-field-removed-video-title').family).toBe(
      'readReviews',
    );
    expect(find('meta-graph', 'meta-graph-v15-0-edge-removed-tabs').family).toBe('request-review');
    expect(find('meta-graph', 'meta-graph-v15-0-edge-changed-adsets').family).toBe(
      'semantic-change',
    );
  });

  it('reads GitHub REST titles without mistaking "pull request" for a request body', () => {
    expect(find('github', 'Remove merge_commit_sha field from pull request responses').family).toBe(
      'readReviews',
    );
    expect(
      find('github', 'Remove deprecated permission property from request when a team is created')
        .family,
    ).toBe('request-removals');
    expect(
      find('github', 'Change success status code from 204 to 202 for deleting an installation')
        .family,
    ).toBe('semantic-change');
  });

  it('counts a change recorded in two files once, with both sources', () => {
    const upload = find('slack', 'files.upload');
    expect(upload.family).toBe('symbolReviews');
    expect(upload.sources).toEqual([
      'slack-methods.json#webApi.properties.files.upload',
      'deadlines.json#slack-files-upload',
    ]);
    const team = find('github', 'GET /teams/{}');
    expect(team.sources).toEqual([
      'github-api.json#openapi.deprecated',
      'deadlines.json#github-teams-legacy-endpoints',
    ]);
    expect(changes.filter((change) => change.provider === 'stripe')).toEqual([]);
  });
});

describe('rankProviders', () => {
  const change = (
    provider: string,
    category: ClassifiedChange['category'],
    family: string,
  ): ClassifiedChange => ({
    provider,
    key: family,
    shape: '',
    sources: ['a.json#x'],
    rule: '',
    category,
    family,
  });

  it('ranks by changes handled without new code, then by edits, and lists providers with none', () => {
    const result = rankProviders(
      [
        change('a', 'review', 'symbolReviews'),
        change('a', 'review', 'readReviews'),
        change('b', 'mechanism', 'operationReplacements'),
        change('b', 'review', 'symbolReviews'),
        change('b', 'new-code', 'graphql-documents'),
      ],
      ['a', 'b', 'c'],
    );
    expect(result.ranked.map((row) => [row.provider, row.covered, row.edits])).toEqual([
      ['b', 2, 1],
      ['a', 2, 0],
    ]);
    expect(result.ranked[0]).toMatchObject({ recorded: 3, newCode: 1, coveredPercent: 66.7 });
    expect(result.unknown).toEqual(['c']);
  });
});
