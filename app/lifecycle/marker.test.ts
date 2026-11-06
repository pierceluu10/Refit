import { describe, expect, it } from 'vitest';
import { formatMarker, parseMarker, withMarker } from './marker.ts';
import type { LifecycleMarker } from './marker.ts';

const MARKER: LifecycleMarker = {
  dependency: 'node',
  kind: 'runtime-eol',
  target: '22',
  changeId: 'node-20-eol',
};

describe('marker', () => {
  it('formats the documented hidden comment and reads it back from a body', () => {
    expect(formatMarker(MARKER)).toBe(
      '<!-- refit:lifecycle {"dependency":"node","kind":"runtime-eol","target":"22","changeId":"node-20-eol"} -->',
    );
    expect(parseMarker(withMarker('A PR body.\n\nWith lines.', MARKER))).toEqual(MARKER);
  });

  it.each([
    ['a comment end', 'evil --> <img src=x onerror=alert(1)>'],
    ['the HTML5 bang end', 'evil --!> after'],
    ['a run of dashes before >', 'name--->'],
    ['a trailing dash', 'name-'],
    ['a backslash before dashes', 'a\\--b\\>c'],
    ['an embedded marker', '<!-- refit:lifecycle {"dependency":"x"} -->'],
    ['a quote and a newline', 'a"b\nc'],
  ])('keeps a name with %s inside one comment and round-trips it', (_, dependency) => {
    const marker = { ...MARKER, dependency, target: dependency };
    const formatted = formatMarker(marker);
    expect(formatted.indexOf('-->'), formatted).toBe(formatted.length - '-->'.length);
    expect(formatted.slice('<!--'.length, -'-->'.length), formatted).not.toContain('--');
    expect(parseMarker(`before\n${formatted}\nafter`), formatted).toEqual(marker);
  });

  it('takes the last marker, so one quoted in a harness body cannot override Refit', () => {
    const quoted = formatMarker({ ...MARKER, dependency: 'quoted' });
    expect(parseMarker(withMarker(`A changelog said ${quoted}`, MARKER))).toEqual(MARKER);
  });

  it.each([
    ['null', null],
    ['an empty body', ''],
    ['a body without a marker', 'Just a PR.'],
    ['broken JSON', '<!-- refit:lifecycle {"dependency": -->'],
    ['a JSON array', '<!-- refit:lifecycle [] -->'],
    ['JSON null', '<!-- refit:lifecycle null -->'],
    ['a missing field', '<!-- refit:lifecycle {"dependency":"node","kind":"x","target":"1"} -->'],
    [
      'a field of the wrong type',
      '<!-- refit:lifecycle {"dependency":"node","kind":"x","target":22,"changeId":"y"} -->',
    ],
  ])('does not match %s', (_, body) => {
    expect(parseMarker(body)).toBeUndefined();
  });
});
