// F3: the demo scans watched chat-widget.example.com (a placeholder that can only fail) and wrote one
// row per Werkzeug advisory, seven rows for a single move to 3.x.
import { describe, expect, it } from 'vitest';
import { DEPENDENCY_SYSTEM_PROMPT, SYSTEM_PROMPT } from '../../inventory/prompt.ts';
import { SOURCE_GUIDES } from './prompt.ts';

describe('guidance for findings that are real and not repeated', () => {
  it.each([
    ['dependency', DEPENDENCY_SYSTEM_PROMPT],
    ['API', SYSTEM_PROMPT],
  ])('the %s inventory leaves placeholder hosts out as providers', (_, prompt) => {
    expect(prompt).toMatch(/domain reserved for examples and tests \(example\.com/);
    expect(prompt).toMatch(/Do not record it as a provider/);
  });

  it('collapses advisories one move fixes into one change', () => {
    expect(SOURCE_GUIDES.advisories).toMatch(
      /Advisories that one move fixes .* are one underlying change/,
    );
    expect(SOURCE_GUIDES.advisories).not.toMatch(/one change per advisory/);
  });
});
