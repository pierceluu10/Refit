import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { earlierResults } from './session-run.ts';

describe('earlierResults', () => {
  const ran = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'session-run-'));
    writeFileSync(path.join(dir, 'results.json'), JSON.stringify([{ repo: 'acme/shop' }]));
    return dir;
  };

  it('refuses a second sealed run unless it resumes that run', () => {
    expect(() => earlierResults(ran(), { sealed: true })).toThrow(/happens once/);
    expect(earlierResults(ran(), { sealed: true, resume: true })).toEqual([{ repo: 'acme/shop' }]);
  });

  it('starts over on a dev run, and an empty folder has nothing to resume', () => {
    expect(earlierResults(ran())).toEqual([]);
    expect(
      earlierResults(mkdtempSync(path.join(tmpdir(), 'session-run-')), { sealed: true }),
    ).toEqual([]);
  });
});
