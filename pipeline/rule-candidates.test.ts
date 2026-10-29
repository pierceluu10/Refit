import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { RuleCandidate } from './ai-misses.ts';

// The rule stubs pipeline/ai-miss-rules-cli.ts proposed from dev-set misses
// (docs/proposals/ai-miss-rules.md). Each must stay generic (D5), sourced and dev-set only, and its
// matcher must match every fixture it was built from and no other group's.

const DIRECTORY = new URL('../data/rule-candidates/', import.meta.url);
const OFFICIAL =
  /^https:\/\/(?:developers\.openai\.com|platform\.openai\.com|github\.com\/openai|platform\.claude\.com|docs\.anthropic\.com|github\.com\/anthropics|ai\.google\.dev|github\.com\/googleapis|github\.com\/google-gemini)\b/;

async function stubs() {
  const names = (await readdir(DIRECTORY).catch(() => [])).filter((name) => name.endsWith('.json'));
  return Promise.all(
    names.map(async (name) => ({
      name,
      stub: JSON.parse(await readFile(new URL(name, DIRECTORY), 'utf8')) as RuleCandidate,
    })),
  );
}

async function measurementRepos() {
  const repos = new Set<string>();
  for (const list of ['openai-100', 'anthropic-100', 'gemini-30']) {
    const parsed = JSON.parse(
      await readFile(new URL(`../docs/benchmarks/subsets/${list}.json`, import.meta.url), 'utf8'),
    ) as { repos: Array<{ repo: string }> };
    for (const entry of parsed.repos) repos.add(entry.repo);
  }
  return repos;
}

describe('rule candidates', () => {
  it('are proposals with two or more repositories and a quoted official source', async () => {
    for (const { name, stub } of await stubs()) {
      expect(name).toBe(`${stub.id}.json`);
      expect(['rule-candidate', 'needs-fix-example']).toContain(stub.status);
      expect(stub.repositories).toBeGreaterThanOrEqual(2);
      expect(new Set(stub.fixtures.map((fixture) => fixture.repo)).size).toBeGreaterThanOrEqual(2);
      expect(stub.sources.length).toBeGreaterThan(0);
      for (const source of stub.sources) {
        expect(source.url).toMatch(OFFICIAL);
        expect(source.quote.trim().length).toBeGreaterThan(0);
      }
      if (stub.status === 'rule-candidate')
        expect(stub.fixtures.some((fixture) => fixture.diff)).toBe(true);
    }
  });

  it('name no repository, path or measurement repository in what they match (D5)', async () => {
    const measured = await measurementRepos();
    for (const { stub } of await stubs()) {
      const generic = [stub.pattern, stub.match, ...stub.shapes].join('\n');
      for (const fixture of stub.fixtures) {
        expect(measured.has(fixture.repo)).toBe(false);
        expect(generic).not.toContain(fixture.repo);
        expect(generic).not.toContain(fixture.file);
      }
    }
  });

  it('match every fixture they came from and no fixture of another kind of stop', async () => {
    const all = await stubs();
    for (const { stub } of all) {
      const matcher = new RegExp(stub.match);
      for (const fixture of stub.fixtures) expect(matcher.test(fixture.stopReason)).toBe(true);
      for (const { stub: other } of all)
        if (other.pattern !== stub.pattern)
          for (const fixture of other.fixtures)
            expect(matcher.test(fixture.stopReason), `${stub.id} vs ${other.id}`).toBe(false);
    }
  });
});
