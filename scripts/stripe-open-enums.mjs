#!/usr/bin/env node
// Records stripe-node's open (OtherString) response enums and the response fields that use them,
// for the open-enum compatibility rule. Usage:
//   node scripts/stripe-open-enums.mjs <extracted stripe package directory> <output.json>
// shortcut: only top-level resources (`Stripe.Price`, not `Stripe.Checkout.Session`); add
// namespaced resources when a benchmark repository needs one.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript-compiler';

const [packageDirectory, output] = process.argv.slice(2);
if (!packageDirectory || !output) {
  console.error(
    'Usage: node scripts/stripe-open-enums.mjs <stripe package directory> <output.json>',
  );
  process.exit(1);
}
const version = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')).version;
const resources = join(packageDirectory, 'cjs', 'resources');
const enums = {};
const interfaces = {};
const pending = [];
const isParams = (path) => path.split('.').some((part) => /Params$/.test(part));

function visit(node, scope) {
  if (ts.isModuleDeclaration(node) && node.body && ts.isModuleBlock(node.body)) {
    for (const statement of node.body.statements) visit(statement, [...scope, node.name.text]);
    return;
  }
  if (ts.isTypeAliasDeclaration(node) && ts.isUnionTypeNode(node.type)) {
    const path = [...scope, node.name.text].join('.');
    const members = node.type.types;
    const open = members.some(
      (member) => ts.isTypeReferenceNode(member) && member.typeName.getText() === 'OtherString',
    );
    const literals = members.flatMap((member) =>
      ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)
        ? [member.literal.text]
        : [],
    );
    if (open && literals.length === members.length - 1 && !isParams(path)) enums[path] = literals;
  }
  if (ts.isInterfaceDeclaration(node)) {
    const path = [...scope, node.name.text].join('.');
    if (isParams(path)) return;
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !member.type || !ts.isIdentifier(member.name))
        continue;
      const parts = ts.isUnionTypeNode(member.type) ? member.type.types : [member.type];
      const references = parts.filter(ts.isTypeReferenceNode);
      const nullable = parts.some(
        (part) => ts.isLiteralTypeNode(part) && part.literal.kind === ts.SyntaxKind.NullKeyword,
      );
      if (references.length !== 1 || parts.length !== references.length + (nullable ? 1 : 0))
        continue;
      pending.push({
        owner: path,
        field: member.name.text,
        reference: references[0].typeName.getText(),
        scope: [...scope, node.name.text],
        nullable,
      });
    }
  }
}

for (const name of readdirSync(resources).filter((entry) => entry.endsWith('.d.ts'))) {
  const source = ts.createSourceFile(
    name,
    readFileSync(join(resources, name), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of source.statements) visit(statement, []);
}
for (const entry of pending) {
  const names = new Set([...Object.keys(enums), ...pending.map((item) => item.owner)]);
  // A reference resolves in the innermost enclosing namespace that declares it.
  let resolved;
  for (let depth = entry.scope.length; depth >= 0 && !resolved; depth--) {
    const candidate = [...entry.scope.slice(0, depth), entry.reference].join('.');
    if (names.has(candidate)) resolved = candidate;
  }
  if (!resolved) continue;
  (interfaces[entry.owner] ??= {})[entry.field] = { type: resolved, nullable: entry.nullable };
}
// Keep only fields that lead to an open enum.
const reaches = new Map();
function leads(type, seen = new Set()) {
  if (enums[type]) return true;
  if (reaches.has(type)) return reaches.get(type);
  if (seen.has(type) || !interfaces[type]) return false;
  seen.add(type);
  const result = Object.values(interfaces[type]).some((field) => leads(field.type, seen));
  reaches.set(type, result);
  return result;
}
const fields = {};
for (const [owner, members] of Object.entries(interfaces)) {
  const kept = Object.fromEntries(Object.entries(members).filter(([, field]) => leads(field.type)));
  if (Object.keys(kept).length) fields[owner] = kept;
}
writeFileSync(
  output,
  `${JSON.stringify({ source: `stripe@${version} cjs/resources type declarations`, sdkVersion: version, enums, fields }, null, 1)}\n`,
);
console.log(
  `${Object.keys(enums).length} open enums, ${Object.keys(fields).length} interfaces from stripe@${version}`,
);
