import { describe, expect, it } from 'vitest';
import { gradeValidators, runPassed } from './validators.ts';

describe('gradeValidators', () => {
  const claim = (name: string, passed = true) => ({ name, passed, detail: '' });

  it('passes a claim only when its recorded call passed', () => {
    const runs = [
      { tool: 'stripe__check_params', output: 'invalid param: source', passed: false },
      { tool: 'stripe__check_params', output: 'params valid', passed: true },
    ];
    expect(gradeValidators([claim('check_params')], runs)).toEqual([
      { name: 'check_params', ran: true, passed: true, detail: 'params valid' },
    ]);
    expect(gradeValidators([claim('check_params')], runs.slice(0, 1))[0].passed).toBe(false);
    expect(gradeValidators([claim('check_params', false)], runs)[0].passed).toBe(false);
  });

  it('fails a claim with no recorded call', () => {
    expect(gradeValidators([claim('live_call')], [])[0]).toMatchObject({
      ran: false,
      passed: false,
    });
  });

  it('reads failure from tool text', () => {
    expect(runPassed('params valid for 2026-10-01')).toBe(true);
    expect(runPassed('error: network down')).toBe(false);
    expect(runPassed('2 fields failed validation')).toBe(false);
    expect(runPassed('{"valid": false}')).toBe(false);
  });
});
