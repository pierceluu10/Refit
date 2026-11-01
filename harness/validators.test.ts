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

  // Trimmed from the provider tool packs' real output on 2026-11-01.
  it('reads the problem lines the provider packs print', () => {
    const clean = [
      'Result: 0 error(s), 0 warning(s), 0 note(s); 2 field(s) checked.\nNo problems found in the checked fields.',
      'Deprecated parameters: none found.\nUnknown parameters: none.\nRequired parameters present (messages, model).\nModel gpt-6-luna: active.',
      'Operation: POST /v1/checkout/sessions (PostCheckoutSessions).\nNo problems found against this spec for the params given.',
      '## gpt-6-luna\nStatus: active as far as the snapshot shows (listed on the models page).',
      'Endpoint note (supported): Chat Completions remains supported, but Responses is recommended for new projects.',
      'No known old-SDK call shapes matched. That is not proof the code is current: the patterns are a hint list.',
    ];
    for (const output of clean) expect(runPassed(output), output).toBe(true);
    const problems = [
      'Result: 1 error(s), 0 warning(s), 0 note(s); 1 field(s) checked.\n- line 1:10 error: Field "nameThatDoesNotExist" does not exist on type Shop.',
      'Unknown parameters:\n- bogus_param: not a top-level parameter of POST /chat/completions in the spec.',
      'Deprecated or legacy parameters:\n- max_tokens: deprecated in spec.',
      'Required by the spec but missing: messages',
      'Reasoning model: temperature is not supported when reasoning effort is not none.',
      'Unknown params (not in the spec for this operation):\n- payment_method_types',
      'Required params missing: line_items.',
      'Enum mismatch: mode = "subscriptions" is not one of [payment, setup, subscription].',
      '## gpt-4o-2024-08-06\nStatus (as of 2026-11-01): deprecated, shutdown scheduled 2027-01-14',
      "Endpoint note (legacy): Completions is a legacy endpoint (the model pages label it 'Completions (legacy)').",
      'Old SDK shapes found:\n- [node] Configuration -> new OpenAI({ apiKey })',
    ];
    for (const output of problems) expect(runPassed(output), output).toBe(false);
  });
});
