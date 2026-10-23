import { expect, it } from 'vitest';
import { scoreInventory } from './package-manifests-score.ts';

const unit = (provider: string, ecosystem: string, file: string) => ({ provider, ecosystem, file });

it('scores manifest-level units per ecosystem and providers per repository', () => {
  const labels = [
    {
      repository: 'a/one',
      commit: '1',
      units: [
        unit('stripe', 'pypi', 'requirements.txt'),
        unit('openai', 'pypi', 'api/pyproject.toml'),
      ],
    },
    { repository: 'b/two', commit: '2', units: [unit('twilio', 'go', 'go.mod')] },
    { repository: 'c/three', commit: '3', units: [unit('stripe', 'cargo', 'Cargo.toml')] },
    { repository: 'd/four', commit: '4', units: [] },
  ];
  const results = [
    {
      repository: 'a/one',
      commit: '1',
      units: [unit('stripe', 'pypi', 'requirements.txt'), unit('openai', 'pypi', 'pyproject.toml')],
    },
    { repository: 'b/two', commit: '2', units: [unit('twilio', 'go', 'go.mod')] },
    { repository: 'c/three', commit: '3', error: 'clone failed', units: [] },
    { repository: 'd/four', commit: '4', units: [unit('stripe', 'nuget', 'App.csproj')] },
  ];
  const score = scoreInventory(labels, results);
  expect(score.unscanned).toEqual(['c/three']);
  expect(score.overall).toEqual({
    truePositives: 2,
    falsePositives: 2,
    falseNegatives: 2,
    precision: 0.5,
    recall: 0.5,
  });
  expect(score.byEcosystem).toEqual({
    cargo: { truePositives: 0, falsePositives: 0, falseNegatives: 1, precision: null, recall: 0 },
    go: { truePositives: 1, falsePositives: 0, falseNegatives: 0, precision: 1, recall: 1 },
    nuget: { truePositives: 0, falsePositives: 1, falseNegatives: 0, precision: 0, recall: null },
    pypi: { truePositives: 1, falsePositives: 1, falseNegatives: 1, precision: 0.5, recall: 0.5 },
  });
  // The misplaced OpenAI file is still the right provider at repository level.
  expect(score.providers).toEqual({
    truePositives: 3,
    falsePositives: 1,
    falseNegatives: 1,
    precision: 0.75,
    recall: 0.75,
  });
  expect(score.falsePositives.map((item) => `${item.repository}:${item.file}`)).toEqual([
    'a/one:pyproject.toml',
    'd/four:App.csproj',
  ]);
  expect(score.falseNegatives.map((item) => `${item.repository}:${item.file}`)).toEqual([
    'a/one:api/pyproject.toml',
    'c/three:Cargo.toml',
  ]);
});

it('ignores results for another commit of a labelled repository', () => {
  const score = scoreInventory(
    [{ repository: 'a/one', commit: 'new', units: [unit('stripe', 'pypi', 'requirements.txt')] }],
    [{ repository: 'a/one', commit: 'old', units: [unit('stripe', 'pypi', 'requirements.txt')] }],
  );
  expect(score.unscanned).toEqual(['a/one']);
  expect(score.overall.recall).toBe(0);
});
