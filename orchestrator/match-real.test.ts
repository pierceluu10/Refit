import { describe, expect, it } from 'vitest';
import type { ProviderChange } from '../shared/types.ts';
import type { MatchedTask, MatchResult } from './match.ts';
import { shapeProblems } from './match-real.ts';

const change = (id: string) => ({ id }) as ProviderChange;
const task = (id: string, bundled: string[] = []) =>
  ({
    id: `repo:${id}`,
    change: change(id),
    alsoResolves: bundled.map((b) => ({ change: change(b), why: '' })),
  }) as MatchedTask;
const result = (...tasks: MatchedTask[]): MatchResult => ({ tasks, notAffected: [], costUsd: 0 });

describe('shapeProblems', () => {
  const upgrade = { oneTask: ['sdk-major', 'api-version', 'param-removed'], separate: [] };

  it('passes one upgrade task that carries the rest', () => {
    expect(
      shapeProblems(result(task('sdk-major', ['api-version', 'param-removed'])), upgrade),
    ).toEqual([]);
  });

  it('flags the 2026-11-03 shape: one upgrade split over several tasks', () => {
    const split = result(task('sdk-major'), task('api-version'), task('param-removed'));
    expect(shapeProblems(split, upgrade)).toEqual([
      'the upgrade is split over 3 tasks',
      '3 tasks where the upgrade should be the only one',
    ]);
  });

  it('flags an independent change bundled into another task, or left without one', () => {
    const separate = { oneTask: [], separate: ['model-a', 'model-b', 'model-c'] };
    expect(shapeProblems(result(task('model-a', ['model-b'])), separate)).toEqual([
      'model-b is bundled into repo:model-a',
      'model-c has no task',
    ]);
  });
});
