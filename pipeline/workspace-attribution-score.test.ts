import { expect, it } from 'vitest';
import { scoreAttribution } from './workspace-attribution-score.ts';

it('scores attribution against the labelled package and live precision against product code', () => {
  const labels = [
    { file: 'package.json', package: '.', category: 'product' },
    { file: 'apps/web/package.json', package: 'apps/web', category: 'product' },
    { file: 'apps/web/src/stripe.ts', package: 'apps/web', category: 'product' },
    { file: 'examples/demo/index.ts', package: 'examples/demo', category: 'example' },
  ];
  const before = scoreAttribution(labels, [
    { file: 'package.json', live: true, workspace: null },
    { file: 'apps/web/package.json', live: true, workspace: null },
    { file: 'apps/web/src/stripe.ts', live: true, workspace: null },
    { file: 'examples/demo/index.ts', live: true, workspace: null },
    { file: 'scripts/seed.ts', live: true, workspace: null },
  ]);
  expect(before).toEqual({
    findings: 5,
    unlabelled: 1,
    attributed: { correct: 1, total: 4, accuracy: 0.25 },
    live: { product: 3, total: 4, precision: 0.75 },
    productLive: 3,
  });
  const after = scoreAttribution(labels, [
    { file: 'package.json', live: true, workspace: '.' },
    { file: 'apps/web/package.json', live: true, workspace: 'apps/web' },
    { file: 'apps/web/src/stripe.ts', live: true, workspace: 'apps/web' },
    { file: 'examples/demo/index.ts', live: false, workspace: 'examples/demo' },
  ]);
  expect(after.attributed.accuracy).toBe(1);
  expect(after.live).toEqual({ product: 3, total: 3, precision: 1 });
});
