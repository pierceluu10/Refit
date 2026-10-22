// Builds data/messaging-deprecations.json: the members of each messaging SDK's client that the SDK's
// own type declarations mark `@deprecated`, with the provider's message and the replacement it
// names, plus npm's deprecation notice for whole packages the providers retired. Declarations are
// parsed with the TypeScript compiler from unpacked npm tarballs; no SDK code is executed or
// installed.
//
// Each --sdk names an unpacked package, the declaration file and class of the client a user holds
// (`twilio(sid, token)` returns `Twilio`; `new Mailgun(FormData).client(...)` returns
// `MailgunClient`) and how deep to walk its members. A member typed by an interface also takes the
// `@deprecated` tags of the classes that implement it, because mailgun.js documents them there.
//
//   npm pack twilio@6.2.0 mailgun.js@14.1.0 --ignore-scripts, then unpack each
//   node scripts/messaging-deprecations.mjs \
//     --sdk twilio=twilio/package:lib/rest/Twilio.d.ts:Twilio:2 \
//     --sdk mailgun.js=mailgun/package:Types/Classes/MailgunClient.d.ts:MailgunClient:3 \
//     --retired sendgrid --retired mailgun-js --checked-at 2026-10-22 \
//     --output data/messaging-deprecations.json
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import ts from 'typescript-compiler';

const REGISTRY = 'https://registry.npmjs.org';
const { values } = parseArgs({
  options: {
    sdk: { type: 'string', multiple: true },
    retired: { type: 'string', multiple: true },
    'checked-at': { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (
  values.help ||
  !values.sdk?.length ||
  !/^\d{4}-\d{2}-\d{2}$/.test(values['checked-at'] ?? '') ||
  !values.output
) {
  console.log(
    'Usage: node scripts/messaging-deprecations.mjs --sdk <name>=<dir>:<declaration file>:<class>:<depth>… [--retired <package>…] --checked-at YYYY-MM-DD --output <file.json>',
  );
  process.exit(values.help ? 0 : 1);
}

async function registry(name) {
  const response = await fetch(`${REGISTRY}/${name.replace('/', '%2F')}`);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return response.json();
}

function deprecation(symbol, checker) {
  const tag = symbol.getJsDocTags(checker).find((item) => item.name === 'deprecated');
  if (!tag) return undefined;
  const text = ts
    .displayPartsToString(tag.text ?? [])
    .replace(/^[\s-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text || 'Deprecated.';
}

// `Use v2.services instead` is relative to the member's parent; `Please use
// 'domains.domainTracking.getTracking' instead` names the whole path.
function replacementOf(message, parent) {
  const quoted = /use ['"`]([\w.]+)['"`]/i.exec(message)?.[1];
  if (quoted) return quoted;
  const relative = /^Use ([\w.]+);? instead/i.exec(message)?.[1];
  return relative ? [...parent, relative].join('.') : null;
}

async function members(directory, file, className, depth) {
  const root = join(directory, file);
  // Every declaration file, so implementing classes nothing imports are still read.
  const declarations = (await readdir(directory, { recursive: true }))
    .filter((name) => name.endsWith('.d.ts') && !name.includes('node_modules'))
    .map((name) => join(directory, name));
  const program = ts.createProgram([root, ...declarations], {
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
  });
  const checker = program.getTypeChecker();
  // Interface name -> classes declared to implement it, across the package.
  const implementations = new Map();
  for (const source of program.getSourceFiles()) {
    if (!source.fileName.startsWith(directory)) continue;
    ts.forEachChild(source, function visit(node) {
      if (ts.isClassDeclaration(node))
        for (const clause of node.heritageClauses ?? [])
          if (clause.token === ts.SyntaxKind.ImplementsKeyword)
            for (const type of clause.types) {
              const name = type.expression.getText(source);
              implementations.set(name, [...(implementations.get(name) ?? []), node]);
            }
      ts.forEachChild(node, visit);
    });
  }
  const source = program.getSourceFile(root);
  if (!source) throw new Error(`${root} was not found.`);
  let rootClass;
  ts.forEachChild(source, (node) => {
    if (ts.isClassDeclaration(node) && node.name?.text === className) rootClass = node;
  });
  if (!rootClass) throw new Error(`${file} declares no class ${className}.`);
  const found = new Map();
  const walk = (type, path, level, seen) => {
    const name = type.symbol?.name;
    const classes = name ? (implementations.get(name) ?? []) : [];
    for (const property of checker.getPropertiesOfType(type)) {
      if (property.name.startsWith('_') || property.name.startsWith('#')) continue;
      const memberPath = [...path, property.name];
      let message = deprecation(property, checker);
      for (const implementation of classes) {
        if (message) break;
        const member = checker
          .getPropertiesOfType(checker.getTypeAtLocation(implementation))
          .find((item) => item.name === property.name);
        if (member) message = deprecation(member, checker);
      }
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (message)
        found.set(memberPath.join('.'), {
          path: memberPath.join('.'),
          kind:
            declaration &&
            (ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration))
              ? 'method'
              : declaration && ts.isGetAccessorDeclaration(declaration)
                ? 'getter'
                : 'property',
          message,
          replacement: replacementOf(message, path),
        });
      if (level + 1 >= depth || !declaration) continue;
      const child = checker.getTypeOfSymbolAtLocation(property, declaration);
      const key = checker.typeToString(child);
      if (seen.has(key) || !(child.flags & ts.TypeFlags.Object)) continue;
      walk(child, memberPath, level + 1, new Set([...seen, key]));
    }
  };
  walk(checker.getTypeAtLocation(rootClass), [], 0, new Set());
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

const sdks = {};
for (const option of values.sdk) {
  const match = /^([^=]+)=(.+):([^:]+):([^:]+):(\d+)$/.exec(option);
  if (!match) throw new Error(`Bad --sdk ${option}`);
  const [, name, directory, file, className, depth] = match;
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (manifest.name !== name) throw new Error(`${directory} is not ${name}.`);
  const published = (await registry(name)).versions?.[manifest.version];
  sdks[name] = {
    version: manifest.version,
    integrity: published?.dist?.integrity ?? null,
    client: { file, class: className, depth: Number(depth) },
    members: await members(directory, file, className, Number(depth)),
  };
  console.error(`${name} ${manifest.version}: ${sdks[name].members.length} deprecated members`);
}
const retired = {};
for (const name of values.retired ?? []) {
  const entry = await registry(name);
  const latest = entry['dist-tags']?.latest;
  retired[name] = {
    latest,
    deprecated: entry.versions?.[latest]?.deprecated ?? null,
    source: `${REGISTRY}/${name.replace('/', '%2F')}`,
  };
}
await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      generatedBy: 'scripts/messaging-deprecations.mjs',
      checkedAt: values['checked-at'],
      sdks,
      retired,
    },
    null,
    2,
  )}\n`,
);
