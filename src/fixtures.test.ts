import { describe, expect, it } from 'vitest';
import {
  examplePullRequests,
  exampleReports,
  exampleRepos,
  outcomeLabels,
  providerName,
  runs,
} from './fixtures';

const items = exampleReports.flatMap((report) => report.items);

describe('example data', () => {
  it('has one report per repo, on the example org', () => {
    expect(exampleReports.map((report) => report.repo)).toEqual(exampleRepos);
    for (const repo of exampleRepos) expect(repo).toMatch(/^example-org\//);
  });

  it('covers every kind and status the dashboard promises to show', () => {
    for (const kind of [
      'runtime-eol',
      'model-retirement',
      'framework-major',
      'dependency-major',
      'ci-deprecation',
      'container-image-eol',
      'security-fix',
    ]) {
      expect(items.map((item) => item.change.kind)).toContain(kind);
    }
    expect(new Set(items.map((item) => item.status))).toEqual(
      new Set(['open', 'pr-open', 'merged', 'not-affected']),
    );
  });

  it('never links a pull request anywhere but an obviously fake address', () => {
    const links = [
      ...items.flatMap((item) => item.pr ?? []),
      ...examplePullRequests.map((pullRequest) => pullRequest.url),
      ...runs.flatMap((run) => run.pr ?? []),
    ];
    for (const link of links) expect(link).toMatch(/^https:\/\/example\.com\/example-org\//);
  });

  it('gives every item a real source link, and every finding with a PR a matching PR', () => {
    for (const item of items) {
      expect(item.change.source.url).toMatch(/^https:\/\/(?!example\.com)/);
      if (item.pr) {
        expect(examplePullRequests.map((pullRequest) => pullRequest.url)).toContain(item.pr);
      }
    }
  });

  it('shows all four outcomes, on known repos and known changes', () => {
    expect(new Set(runs.map((run) => run.outcome))).toEqual(new Set(Object.keys(outcomeLabels)));
    const changeIds = items.map((item) => item.change.id);
    for (const run of runs) {
      expect(exampleRepos).toContain(run.repo);
      expect(changeIds).toContain(run.changeId);
    }
  });

  it('names known providers and passes unknown ones through', () => {
    expect(providerName('nodejs')).toBe('Node.js');
    expect(providerName('some-new-provider')).toBe('some-new-provider');
  });
});
