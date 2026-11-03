import { describe, expect, it } from 'vitest';
import { parseYaml, YamlError } from './yaml.ts';

function yamlError(source: string): YamlError {
  try {
    parseYaml(source);
  } catch (error) {
    if (error instanceof YamlError) return error;
    throw error;
  }
  throw new Error('expected parseYaml to throw a YamlError');
}

// Walks into a parsed document by keys and indexes.
function at(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) current = (current as Record<string | number, unknown>)[key];
  return current;
}

describe('block collections', () => {
  it('parses nested mappings and sequences at any depth', () => {
    const source = `
info:
  title: Example
  contact:
    name: Team
    urls:
      - https://a.example
      - https://b.example
servers:
  - url: https://api.example.com
    variables:
      region:
        default: us
        enum:
          - us
          - eu
`;
    expect(parseYaml(source)).toEqual({
      info: {
        title: 'Example',
        contact: { name: 'Team', urls: ['https://a.example', 'https://b.example'] },
      },
      servers: [
        {
          url: 'https://api.example.com',
          variables: { region: { default: 'us', enum: ['us', 'eu'] } },
        },
      ],
    });
  });

  it('reads compact items and sequences at their parent key indent', () => {
    const source = `
parameters:
- name: id
  in: path
  required: true
- name: q
  in: query
matrix:
- - 1
  - 2
- - - 3
-   spaced: yes
    more: no
- tags:
  - a
  - b
  after: 1
`;
    expect(parseYaml(source)).toEqual({
      parameters: [
        { name: 'id', in: 'path', required: true },
        { name: 'q', in: 'query' },
      ],
      matrix: [[1, 2], [[3]], { spaced: 'yes', more: 'no' }, { tags: ['a', 'b'], after: 1 }],
    });
  });

  it('reads empty values as null', () => {
    const source = 'a:\nb: \nc: ~\nlist:\n-\n- x\n-   # comment\nnested:\n  inner:\nlast:';
    expect(parseYaml(source)).toEqual({
      a: null,
      b: null,
      c: null,
      list: [null, 'x', null],
      nested: { inner: null },
      last: null,
    });
  });

  it('returns null for an empty document and reads top-level scalars', () => {
    expect(parseYaml('')).toBeNull();
    expect(parseYaml('# only a comment\n\n')).toBeNull();
    expect(parseYaml('---\n')).toBeNull();
    expect(parseYaml('hello')).toBe('hello');
    expect(parseYaml('42\n')).toBe(42);
    expect(parseYaml('- a\n- b\n')).toEqual(['a', 'b']);
    expect(parseYaml('  a: 1\n  b: 2\n')).toEqual({ a: 1, b: 2 });
  });

  it('accepts CRLF line endings and a byte order mark', () => {
    expect(parseYaml('\ufeffa: 1\r\nb:\r\n  - x\r\n  - |\r\n    text\r\n')).toEqual({
      a: 1,
      b: ['x', 'text\n'],
    });
  });

  it('allows tabs as separators inside a line', () => {
    expect(parseYaml('key:\tvalue\nlist:\n  -\tx\t# comment\n')).toEqual({
      key: 'value',
      list: ['x'],
    });
  });
});

describe('plain scalars', () => {
  it('folds multi-line plain scalars', () => {
    const source = `
description: This is a long
  description that wraps

  and has a second paragraph.
list:
  - first line
    second line
next: value
`;
    expect(parseYaml(source)).toEqual({
      description: 'This is a long description that wraps\nand has a second paragraph.',
      list: ['first line second line'],
      next: 'value',
    });
  });

  it('keeps ":" and "#" where YAML allows them', () => {
    const source = [
      'url: https://x.com/a#b',
      'time: 12:30',
      'a:b: c',
      'note: tag#1',
      'comment: value # dropped',
      'host: localhost:8080',
      'pattern: ^[a-z]+$',
      'path: /users/{id}',
      '/users/{id}: route',
    ].join('\n');
    expect(parseYaml(source)).toEqual({
      url: 'https://x.com/a#b',
      time: '12:30',
      'a:b': 'c',
      note: 'tag#1',
      comment: 'value',
      host: 'localhost:8080',
      pattern: '^[a-z]+$',
      path: '/users/{id}',
      '/users/{id}': 'route',
    });
  });

  it('keeps ": " in a value on its key line as text', () => {
    expect(parseYaml('description: Note: read this\ntitle: Ends with: # c\n')).toEqual({
      description: 'Note: read this',
      title: 'Ends with:',
    });
    expect(parseYaml('- key: a: b\n')).toEqual([{ key: 'a: b' }]);
  });

  it('rejects ": " on a continuation line, which is usually a mis-indented key', () => {
    const error = yamlError('type: object\n  properties:\n    id: 1\n');
    expect(error.line).toBe(2);
  });
});

describe('quoted scalars', () => {
  it('reads single-quoted scalars', () => {
    const source = "a: 'it''s'\nb: 'one\n  two\n\n  three'\nc: ''\nd: '# not a comment'\n";
    expect(parseYaml(source)).toEqual({
      a: "it's",
      b: 'one two\nthree',
      c: '',
      d: '# not a comment',
    });
  });

  it('reads double-quoted escapes', () => {
    const source = [
      String.raw`a: "line\nnext\ttab \"q\" back\\slash \/"`,
      String.raw`b: "\u00e9 \x41 \U0001F600 \0 \e \N \_ \L"`,
    ].join('\n');
    expect(parseYaml(source)).toEqual({
      a: 'line\nnext\ttab "q" back\\slash /',
      b: 'é A 😀 \0 \x1b \x85 \xa0 \u2028',
    });
  });

  it('folds double-quoted scalars across lines', () => {
    const source = 'a: "one\n  two\n\n  three"\nb: "joined\\\n  here"\nc: "keep  \\\n  spaces"\n';
    expect(parseYaml(source)).toEqual({ a: 'one two\nthree', b: 'joinedhere', c: 'keep  spaces' });
    // How PyYAML wraps long strings that have a space at the break.
    expect(parseYaml('d: "first part\\\n  \\ second part"')).toEqual({
      d: 'first part second part',
    });
  });

  it('reads quoted keys and keeps quoted values as strings', () => {
    const source = [
      '"quoted key": 1',
      "'single': 2",
      '"with: colon": 3',
      '"t": "true"',
      "n: '42'",
      'z: "null"',
    ].join('\n');
    expect(parseYaml(source)).toEqual({
      'quoted key': 1,
      single: 2,
      'with: colon': 3,
      t: 'true',
      n: '42',
      z: 'null',
    });
  });
});

describe('block scalars', () => {
  it('applies clip, strip and keep chomping', () => {
    const source =
      'clip: |\n  line 1\n  line 2\n\nstrip: |-\n  text\n\nkeep: |+\n  text\n\nlast: x\n';
    expect(parseYaml(source)).toEqual({
      clip: 'line 1\nline 2\n',
      strip: 'text',
      keep: 'text\n\n',
      last: 'x',
    });
  });

  it('folds > scalars but keeps more-indented lines', () => {
    const source =
      'folded: >\n  one\n  two\n\n  three\n    indented\n  four\nshort: >-\n  a\n  b\n';
    expect(parseYaml(source)).toEqual({
      folded: 'one two\nthree\n  indented\nfour\n',
      short: 'a b',
    });
  });

  it('honors explicit indentation indicators', () => {
    const source =
      'code: |2\n    indented first line\n  second\nboth: >2-\n   x\n  y\nflip: |-1\n  z\n';
    expect(parseYaml(source)).toEqual({
      code: '  indented first line\nsecond\n',
      both: ' x\ny',
      flip: ' z',
    });
  });

  it('keeps blank lines inside and handles trailing ones', () => {
    const source = 'text: |\n\n  after blank\n\n\n  two blanks\n\n\nkeep: >+\n  k\n\n\nnext: 1\n';
    expect(parseYaml(source)).toEqual({
      text: '\nafter blank\n\n\ntwo blanks\n',
      keep: 'k\n\n\n',
      next: 1,
    });
  });

  it('reads block scalars in sequences, with comments and at the end of input', () => {
    const source = `
steps:
  - |
    echo one
    echo two
  - run: |  # header comment
      # not a comment
      make
    shell: bash
end: |
  no newline at the end`;
    expect(parseYaml(source)).toEqual({
      steps: ['echo one\necho two\n', { run: '# not a comment\nmake\n', shell: 'bash' }],
      end: 'no newline at the end',
    });
  });
});

describe('flow collections', () => {
  it('reads nested flow collections over several lines', () => {
    const source = `
enum: [a, "b c", 'd, e', 1, true, null]
nested: {a: 1, b: [x, {c: y}], d: {}}
multi: [
  one,   # first
  two,
  { k: v,
    k2: [3, 4,], },
]
json: {"a":1,"b":[true,false]}
empty: [[], {}]
urls: [http://x.y/z, a:b]
`;
    expect(parseYaml(source)).toEqual({
      enum: ['a', 'b c', 'd, e', 1, true, null],
      nested: { a: 1, b: ['x', { c: 'y' }], d: {} },
      multi: ['one', 'two', { k: 'v', k2: [3, 4] }],
      json: { a: 1, b: [true, false] },
      empty: [[], {}],
      urls: ['http://x.y/z', 'a:b'],
    });
  });

  it('reads single pairs in sequences, keys without values and multi-line plain scalars', () => {
    expect(parseYaml('[a: 1, b]')).toEqual([{ a: 1 }, 'b']);
    expect(parseYaml('{a, b: 1, c: }')).toEqual({ a: null, b: 1, c: null });
    expect(parseYaml('[multi\n  line, plain]')).toEqual(['multi line', 'plain']);
  });
});

describe('documents and comments', () => {
  it('reads only the first document', () => {
    expect(parseYaml('%YAML 1.2\n---\na: 1\n...\n---\nb: 2\n')).toEqual({ a: 1 });
    expect(parseYaml('a: 1\n---\nb: 2\n')).toEqual({ a: 1 });
    expect(parseYaml('a: 1\n...\nnot: parsed\n')).toEqual({ a: 1 });
  });

  it('reads content on the "---" line', () => {
    expect(parseYaml('--- |\n  text\n')).toBe('text\n');
    expect(parseYaml('--- [1, 2]\n')).toEqual([1, 2]);
    expect(parseYaml('--- plain\n')).toBe('plain');
    expect(parseYaml('--- # comment\na: 1\n')).toEqual({ a: 1 });
  });

  it('skips comments and blank lines anywhere', () => {
    const source =
      '# leading\n\na: 1 # trailing\n  # indented comment\nb:\n  # inside\n\n  c: 2\n# end';
    expect(parseYaml(source)).toEqual({ a: 1, b: { c: 2 } });
  });
});

describe('anchors, aliases and merge keys', () => {
  it('reuses the anchored value for each alias', () => {
    const source = `
base: &base
  type: object
ref: *base
list: [*base, *base]
scalar: &s hello
again: *s
seq: &items
- 1
copy: *items
`;
    const doc = parseYaml(source) as Record<string, unknown>;
    expect(doc.ref).toBe(doc.base);
    expect((doc.list as unknown[])[1]).toBe(doc.base);
    expect(doc.again).toBe('hello');
    expect(doc.copy).toEqual([1]);
    expect(doc.copy).toBe(doc.seq);
  });

  it('merges mappings, with explicit keys winning', () => {
    const source = `
defaults: &defaults
  timeout: 30
  retries: 3
extra: &extra
  retries: 5
  verbose: true
service:
  <<: *defaults
  timeout: 60
both:
  <<: [*defaults, *extra]
before:
  retries: 1
  <<: *defaults
flow: {<<: *extra, verbose: false}
`;
    expect(parseYaml(source)).toMatchObject({
      service: { timeout: 60, retries: 3 },
      both: { timeout: 30, retries: 3, verbose: true },
      before: { retries: 1, timeout: 30 },
      flow: { retries: 5, verbose: false },
    });
  });

  it('reports unknown aliases and bad merge values', () => {
    expect(yamlError('a: 1\nb: *nope\n')).toMatchObject({ line: 2, column: 4 });
    expect(yamlError('s: &s text\nm:\n  <<: *s\n').line).toBe(3);
  });
});

describe('tags', () => {
  it('honors core tags and ignores others', () => {
    const source = `
str: !!str 123
int: !!int "42"
hex: !!int 0x1A
float: !!float 1
bool: !!bool "false"
nothing: !!null ~
map: !!map {a: 1}
seq: !!seq [1]
emptyStr: !!str
custom: !Ref MyResource
verbatim: !<tag:yaml.org,2002:str> 7
anchored: &a !!str 5
again: *a
`;
    expect(parseYaml(source)).toEqual({
      str: '123',
      int: 42,
      hex: 26,
      float: 1,
      bool: false,
      nothing: null,
      map: { a: 1 },
      seq: [1],
      emptyStr: '',
      custom: 'MyResource',
      verbatim: '7',
      anchored: '5',
      again: '5',
    });
  });

  it('rejects values that do not fit their tag', () => {
    expect(yamlError('a: 1\nb: !!int abc\n').line).toBe(2);
    expect(yamlError('a: !!map [1]\n').line).toBe(1);
    expect(yamlError('a: !!bool yes\n').message).toContain('!!bool');
  });
});

describe('core schema', () => {
  it('resolves nulls, booleans, integers and floats in plain scalars only', () => {
    expect(parseYaml('[~, null, Null, NULL]')).toEqual([null, null, null, null]);
    expect(parseYaml('[true, True, TRUE, false, False, FALSE]')).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(parseYaml('[0, 42, -17, +5, 0x1F, 0o17, 007]')).toEqual([0, 42, -17, 5, 31, 15, 7]);
    expect(parseYaml('[1.5, -2e3, .5, 1e3, 2.5E-1, .inf, -.Inf, +.INF]')).toEqual([
      1.5,
      -2000,
      0.5,
      1000,
      0.25,
      Infinity,
      -Infinity,
      Infinity,
    ]);
    expect(parseYaml('.nan')).toBeNaN();
  });

  it('keeps everything else as strings', () => {
    expect(
      parseYaml('[2024-01-01, 3.0.0, 1_000, 0b101, 0x, yes, no, on, off, tRue, nil, 12:30]'),
    ).toEqual([
      '2024-01-01',
      '3.0.0',
      '1_000',
      '0b101',
      '0x',
      'yes',
      'no',
      'on',
      'off',
      'tRue',
      'nil',
      '12:30',
    ]);
    expect(parseYaml('[\'1\', "true", \'\', "~"]')).toEqual(['1', 'true', '', '~']);
  });
});

describe('mapping keys', () => {
  it('turns keys into strings and lets the last duplicate win', () => {
    const doc = parseYaml("200: ok\n'201': created\n1.0: one\ntrue: t\n~: tilde\na: 1\na: 2\n");
    expect(doc).toEqual({
      '200': 'ok',
      '201': 'created',
      '1.0': 'one',
      true: 't',
      '~': 'tilde',
      a: 2,
    });
  });

  it('keeps "__proto__" as an own key', () => {
    const doc = parseYaml('__proto__:\n  polluted: true\nflow: {__proto__: 1}\n') as object;
    expect(Object.getPrototypeOf(doc)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(doc, '__proto__')?.value).toEqual({ polluted: true });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('errors', () => {
  it('throws YamlError with a 1-based line and column', () => {
    const error = yamlError('a: 1\n\tb: 2\n');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('YamlError');
    expect(error).toMatchObject({ line: 2, column: 1 });
    expect(error.message).toMatch(/tab.*line 2, column 1/);
  });

  it('reports unsupported and malformed input where it happens', () => {
    expect(yamlError('a: 1\n? b\n: c\n')).toMatchObject({ line: 2, column: 1 });
    expect(yamlError('a: 1\nb: "open\n\nc: 2\n')).toMatchObject({ line: 2, column: 4 });
    expect(yamlError("a: 'open\n")).toMatchObject({ line: 1, column: 4 });
    expect(yamlError('a: [1, 2\n')).toMatchObject({ line: 1, column: 4 });
    expect(yamlError('a: {b: 1\n')).toMatchObject({ line: 1, column: 4 });
    expect(yamlError('a: [1 2 3}\n').line).toBe(1);
    expect(yamlError('a:\n  b: 1\n c: 2\n')).toMatchObject({ line: 3, column: 2 });
    expect(yamlError('a: - b\n')).toMatchObject({ line: 1, column: 4 });
    expect(yamlError('[a]: b\n').line).toBe(1);
    expect(yamlError('{a: 1}: b\n').line).toBe(1);
    expect(yamlError('a: "bad \\q"\n')).toMatchObject({ line: 1, column: 9 });
    expect(yamlError('a: "\\u12"\n').line).toBe(1);
    expect(yamlError('a: |x\n').line).toBe(1);
    expect(yamlError('- a\nb: 1\n').line).toBe(2);
    expect(yamlError('a: 1\n- b\n').line).toBe(2);
    expect(yamlError('a: 1\nplain line\n').line).toBe(2);
    expect(yamlError('%YAML 1.2\na: 1\n').line).toBe(2);
    expect(yamlError('a: @x\n').line).toBe(1);
    expect(yamlError('a: &x &y z\n').line).toBe(1);
    expect(yamlError('a: [1,,2]\n').line).toBe(1);
  });

  it('stops at absurd nesting instead of overflowing the stack', () => {
    expect(yamlError(`${'['.repeat(600)}${']'.repeat(600)}`).message).toContain(
      'nested too deeply',
    );
    expect(parseYaml(`${'['.repeat(100)}1${']'.repeat(100)}`)).toBeInstanceOf(Array);
  });
});

describe('OpenAPI documents', () => {
  it('reads a realistic OpenAPI 3.1 fragment', () => {
    const source = `openapi: 3.1.0
info:
  title: Example Store API
  version: 2024-06-01
  description: |
    The Example Store API.

    Use it to manage **orders**.
paths:
  /orders/{orderId}:
    parameters:
      - name: orderId
        in: path
        required: true
        schema:
          type: string
          pattern: ^ord_[a-z0-9]+$
    get:
      operationId: getOrder
      deprecated: true
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Order'
        '404':
          description: Not found
    post:
      operationId: updateOrder
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/OrderUpdate"
      responses:
        200:
          description: Updated
        default:
          $ref: '#/components/responses/Error'
components:
  schemas:
    Order:
      type: object
      required: [id, status]
      properties:
        id:
          type: string
          example: ord_123
        status:
          type: string
          enum:
            - pending
            - shipped
            - cancelled
        total:
          type: [number, 'null']
          minimum: 0
          maximum: 1.0e6
        legacyCode:
          type: integer
          deprecated: true
          description: >-
            Use status instead.
            Removed in 2025.
`;
    const doc = parseYaml(source);
    expect(at(doc, 'openapi')).toBe('3.1.0');
    expect(at(doc, 'info', 'version')).toBe('2024-06-01');
    expect(at(doc, 'info', 'description')).toBe(
      'The Example Store API.\n\nUse it to manage **orders**.\n',
    );
    const path = at(doc, 'paths', '/orders/{orderId}');
    expect(at(path, 'parameters')).toEqual([
      {
        name: 'orderId',
        in: 'path',
        required: true,
        schema: { type: 'string', pattern: '^ord_[a-z0-9]+$' },
      },
    ]);
    expect(at(path, 'get', 'deprecated')).toBe(true);
    expect(Object.keys(at(path, 'get', 'responses') as object)).toEqual(['200', '404']);
    expect(at(path, 'get', 'responses', '200', 'content', 'application/json', 'schema')).toEqual({
      $ref: '#/components/schemas/Order',
    });
    const body = at(path, 'post', 'requestBody', 'content', 'application/json', 'schema', '$ref');
    expect(body).toBe('#/components/schemas/OrderUpdate');
    expect(Object.keys(at(path, 'post', 'responses') as object)).toEqual(['200', 'default']);
    expect(at(path, 'post', 'responses', '200', 'description')).toBe('Updated');
    const order = at(doc, 'components', 'schemas', 'Order');
    expect(at(order, 'required')).toEqual(['id', 'status']);
    expect(at(order, 'properties', 'status', 'enum')).toEqual(['pending', 'shipped', 'cancelled']);
    expect(at(order, 'properties', 'total')).toEqual({
      type: ['number', 'null'],
      minimum: 0,
      maximum: 1e6,
    });
    expect(at(order, 'properties', 'legacyCode')).toEqual({
      type: 'integer',
      deprecated: true,
      description: 'Use status instead. Removed in 2025.',
    });
  });

  it('reads JSON, which is valid YAML flow syntax', () => {
    const sample = {
      openapi: '3.1.0',
      info: {
        title: 'Sample "quoted" API',
        version: '1.0',
        description: 'Line one\nLine two\ttabbed \\ backslash / slash',
      },
      tags: [],
      servers: [{ url: 'https://api.example.com/v1', variables: {} }],
      numbers: [0, -1, 2.5, 1e21, -3.25e-7, 123456789],
      flags: [true, false, null],
      nested: { a: { b: { c: [1, [2, [3, { d: 'e' }]]] } } },
      unicode: 'café ✓ 😀',
      control: '\u0001\u001f',
      'key with spaces': 'value: with colon # and hash',
      '200': { description: 'OK' },
      empty: '',
      '': 'empty key',
    };
    expect(parseYaml(JSON.stringify(sample, null, 2))).toEqual(sample);
    expect(parseYaml(JSON.stringify(sample))).toEqual(sample);
  });

  it('parses a 1 MB spec quickly', () => {
    const lines = ['openapi: 3.1.0', 'info:', '  title: Synthetic', '  version: 1.0.0', 'paths:'];
    for (let i = 0; lines.length < 40_000; i++) {
      lines.push(
        `  /items/${i}/{id}:`,
        '    get:',
        `      operationId: getItem${i}`,
        '      description: |',
        '        Returns one item.',
        '        Supports **markdown** and `code`.',
        '      parameters:',
        '        - name: id',
        '          in: path',
        '          required: true',
        '          schema: {type: string, enum: [a, b, "c d"]}',
        '      responses:',
        "        '200':",
        '          description: OK # trailing comment',
        '          content:',
        '            application/json:',
        '              schema:',
        `                $ref: '#/components/schemas/Item${i}'`,
        '        default:',
        '          description: Error',
      );
    }
    const source = `${lines.join('\n')}\n`;
    expect(source.length).toBeGreaterThan(1_000_000);
    const started = performance.now();
    const doc = parseYaml(source);
    expect(performance.now() - started).toBeLessThan(2000);
    const count = Object.keys(at(doc, 'paths') as object).length;
    const last = at(doc, 'paths', `/items/${count - 1}/{id}`, 'get');
    expect(at(last, 'operationId')).toBe(`getItem${count - 1}`);
    expect(at(last, 'parameters', 0, 'schema')).toEqual({
      type: 'string',
      enum: ['a', 'b', 'c d'],
    });
    expect(at(last, 'responses', '200', 'content', 'application/json', 'schema', '$ref')).toBe(
      `#/components/schemas/Item${count - 1}`,
    );
    expect(at(last, 'description')).toBe('Returns one item.\nSupports **markdown** and `code`.\n');
  });
});
