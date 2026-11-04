import { describe, expect, it } from 'vitest';
import { failingCheckers, gradeValidators, runPassed } from './validators.ts';

const unrunnable = {
  tool: 'openweathermap__openapi_check',
  output:
    'openapi_check failed to run: https://openweathermap.org/api/one-call-4: could not parse it as JSON or YAML. Nothing was checked.',
  passed: false,
};

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

  it('matches a claim by its bare, provider or SDK tool name', () => {
    const runs = [
      { tool: 'openai__openai_check_request', output: 'Unknown parameters: none.', passed: true },
    ];
    for (const name of [
      'openai_check_request',
      'openai__openai_check_request',
      'mcp__aptitude__openai__openai_check_request',
    ]) {
      expect(gradeValidators([claim(name)], runs)[0], name).toMatchObject({
        ran: true,
        passed: true,
      });
    }
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
      'Product status: current.\nNote: The older 2008 version reached End of Life on 2023-12-15.',
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
      'Version used: v2 (path prefix /v2).\nProduct status: end-of-life (EOL date 2022-07-25).',
      'Version v1 status: deprecated.',
      '- v23.0 (2025-05-29) [marketing] field `instagram_actor_id`: removed -> ig_user_id',
      'Model gpt-9-ultra-made-up: not in snapshot (see openai_model_lookup for closest matches).',
      '2099-01-01.madeup is not in the snapshot (retrieved 2026-11-01). It may be newer than the snapshot or mistyped.',
    ];
    for (const output of problems) expect(runPassed(output), output).toBe(false);
  });
});

describe('openai_check_request', () => {
  const output = (model: string) =>
    [
      'POST /v1/audio/transcriptions (createTranscription)',
      'Endpoint note (models deprecated, 2027-02-26): whisper-1 shut down 2027-02-26; replacements gpt-transcribe.',
      'Deprecated parameters: none found.',
      'Unknown parameters: none.',
      `Model ${model}. Run openai_model_lookup for replacement and dates.`,
    ].join('\n\n');

  it('passes a request on an active model, whatever the endpoint says of other models', () => {
    expect(runPassed(output('gpt-transcribe: active'))).toBe(true);
  });

  it('fails a request whose own model is deprecated or shut down', () => {
    expect(runPassed(output('whisper-1: deprecated (shutdown 2027-02-26)'))).toBe(false);
    expect(runPassed(output('whisper-1: shut down (since 2027-02-26)'))).toBe(false);
  });
});

describe('a validator that could not run', () => {
  it('is no proof and does not hold back the grade', () => {
    const [grade] = gradeValidators(
      [{ name: 'openweathermap__openapi_check', passed: false, detail: 'could not run' }],
      [unrunnable],
    );
    expect(grade).toMatchObject({ ran: false, passed: true });
    expect(failingCheckers([unrunnable])).toEqual([]);
  });
});

describe('failingCheckers', () => {
  it('lists check and validate tools whose latest call failed, claimed or not', () => {
    const runs = [
      { tool: 'stripe__stripe_check_params', output: 'Unknown params', passed: false },
      { tool: 'stripe__stripe_check_params', output: 'No problems found', passed: true },
      { tool: 'shopify__shopify_validate_graphql', output: 'Result: 1 error(s)', passed: false },
      { tool: 'openai__openai_model_lookup', output: 'Status: deprecated', passed: false },
    ];
    expect(failingCheckers(runs)).toEqual(['shopify__shopify_validate_graphql']);
  });
});
