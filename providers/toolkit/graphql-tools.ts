// graphql_lookup and graphql_check: load any GraphQL schema (an SDL file, an introspection JSON
// file, or an endpoint that answers introspection) and look up types or validate a document
// against it. They report; the agent decides. The check is a validator: its result counts as proof.

import type { AgentTool } from '../../shared/types.ts';
import { fetchPage, remember, type NetworkOptions } from './fetch.ts';
import {
  formatIssues,
  namedType,
  schemaFromText,
  validateDocument,
  type ReducedField,
  type ReducedSchema,
} from './graphql.ts';
import { closest } from './text.ts';
import { bool, defineTool, num, obj, str } from './tool.ts';

// Four wrappers cover "[Type!]!" and "[[Type!]]"; deeper queries trip the depth limits that public
// GraphQL gateways enforce (they answer 413 "Query depth limit exceeded").
const TYPE_REF = 'kind name ofType { kind name ofType { kind name ofType { kind name } } }';

export const INTROSPECTION_QUERY = `query AptitudeIntrospection {
  __schema {
    queryType { name } mutationType { name } subscriptionType { name }
    types {
      kind name
      fields(includeDeprecated: true) {
        name isDeprecated deprecationReason
        args { name defaultValue type { ${TYPE_REF} } }
        type { ${TYPE_REF} }
      }
      inputFields { name defaultValue type { ${TYPE_REF} } }
      interfaces { name }
      enumValues(includeDeprecated: true) { name }
      possibleTypes { name }
    }
  }
}`;

export type LoadedSchema = { schema: ReducedSchema; label: string };

const schemaMemory = new Map<string, LoadedSchema>();

export function clearSchemaMemory(): void {
  schemaMemory.clear();
}

/** Load a schema from a file URL (SDL or introspection JSON) or by introspecting an endpoint. */
export async function loadSchema(
  source: { url?: string; endpoint?: string },
  network: NetworkOptions,
): Promise<{ loaded?: LoadedSchema; error?: string }> {
  const key = source.endpoint ? `endpoint ${source.endpoint}` : `file ${source.url}`;
  const memo = schemaMemory.get(key);
  if (memo) return { loaded: memo };
  let text: string;
  let label: string;
  if (source.endpoint) {
    const page = await fetchPage(source.endpoint, {
      ...network,
      method: 'POST',
      timeoutMs: network.timeoutMs ?? 60_000,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: INTROSPECTION_QUERY }),
    });
    if (!page.ok) {
      const auth = page.status === 401 || page.status === 403;
      return {
        error: `introspection of ${source.endpoint} answered ${page.error}${auth ? '; it needs credentials, which tools never send, so pass a published schema file (SDL or introspection JSON) as schema_url' : ''}`,
      };
    }
    text = page.text;
    label = `introspection of ${source.endpoint}`;
  } else if (source.url) {
    const page = await fetchPage(source.url, {
      ...network,
      timeoutMs: network.timeoutMs ?? 60_000,
    });
    if (!page.ok) return { error: `could not load ${source.url} (${page.error})` };
    text = page.text;
    label = `schema file ${page.url}`;
  } else {
    return {
      error: 'no schema given: pass "schema_url" (SDL or introspection JSON) or "endpoint"',
    };
  }
  try {
    const parsed = JSON.parse(text.trim().startsWith('{') ? text : 'null') as {
      errors?: { message?: string }[];
    } | null;
    if (parsed?.errors?.length && !(parsed as { data?: unknown }).data) {
      return {
        error: `${label} returned GraphQL errors: ${parsed.errors.map((e) => e.message).join('; ')}`,
      };
    }
  } catch {
    // Not JSON: SDL text.
  }
  try {
    const loaded = { schema: schemaFromText(text), label };
    remember(schemaMemory, key, loaded, 20);
    return { loaded };
  } catch (error) {
    return {
      error: `${label} is not a schema I can read (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

function fieldLine(name: string, field: ReducedField): string {
  const args =
    field.args && Object.keys(field.args).length
      ? `(${Object.entries(field.args)
          .map(([a, t]) => `${a}: ${t}${field.deprecatedArgs?.[a] ? ' [deprecated]' : ''}`)
          .join(', ')})`
      : '';
  const deprecated = field.isDeprecated
    ? ` [deprecated: ${field.deprecationReason ?? 'no reason given'}]`
    : '';
  return `- ${name}${args}: ${field.type}${deprecated}`;
}

function typeReport(schema: ReducedSchema, name: string, limit: number): string {
  const type = schema.types[name];
  if (!type) {
    const near = closest(name, Object.keys(schema.types));
    return `Type ${name} is not in this schema.${near.length ? ` Did you mean ${near.join(', ')}?` : ''}`;
  }
  const out = [
    `${type.kind} ${name}${type.interfaces?.length ? ` implements ${type.interfaces.join(' & ')}` : ''}${type.partial ? ' (partial excerpt)' : ''}`,
  ];
  const fields = Object.entries(type.fields ?? {});
  for (const [fieldName, field] of fields.slice(0, limit)) out.push(fieldLine(fieldName, field));
  if (fields.length > limit) out.push(`... ${fields.length - limit} more fields (raise "limit")`);
  if (type.enumValues?.length) out.push(`Values: ${type.enumValues.join(', ')}`);
  if (type.possibleTypes?.length) out.push(`Possible types: ${type.possibleTypes.join(', ')}`);
  const deprecated = fields.filter(([, f]) => f.isDeprecated).length;
  if (deprecated) out.push(`${deprecated} deprecated field(s) on ${name}.`);
  return out.join('\n');
}

function deprecatedReport(schema: ReducedSchema, limit: number): string {
  const lines: string[] = [];
  for (const [typeName, type] of Object.entries(schema.types)) {
    for (const [fieldName, field] of Object.entries(type.fields ?? {})) {
      if (field.isDeprecated)
        lines.push(`- ${typeName}.${fieldName}: ${field.deprecationReason ?? 'no reason given'}`);
      for (const [arg, reason] of Object.entries(field.deprecatedArgs ?? {})) {
        lines.push(`- ${typeName}.${fieldName}(${arg}): ${reason}`);
      }
    }
  }
  return lines.length
    ? `Deprecated in this schema (${lines.length}):\n${lines.slice(0, limit).join('\n')}${lines.length > limit ? `\n... ${lines.length - limit} more (raise "limit")` : ''}`
    : 'Nothing in this schema is marked deprecated.';
}

function searchReport(schema: ReducedSchema, query: string, limit: number): string {
  const needle = query.toLowerCase();
  const hits: string[] = [];
  for (const [typeName, type] of Object.entries(schema.types)) {
    if (typeName.toLowerCase().includes(needle)) hits.push(`- type ${typeName} (${type.kind})`);
    for (const [fieldName, field] of Object.entries(type.fields ?? {})) {
      if (fieldName.toLowerCase().includes(needle))
        hits.push(
          `- ${typeName}.${fieldName}: ${field.type}${field.isDeprecated ? ' [deprecated]' : ''}`,
        );
    }
  }
  return hits.length
    ? `${hits.length} type(s) and field(s) match "${query}":\n${hits.slice(0, limit).join('\n')}${hits.length > limit ? '\n...' : ''}`
    : `No type or field name contains "${query}".`;
}

function sourceOf(
  input: Record<string, unknown>,
  defaults: { schemaUrl?: string; endpoint?: string },
) {
  const url = str(input, 'schema_url') ?? str(input, 'url');
  const endpoint = str(input, 'endpoint');
  if (url || endpoint) return { url, endpoint };
  return { url: defaults.schemaUrl, endpoint: defaults.endpoint };
}

export function createGraphqlTools(
  options: NetworkOptions & { schemaUrl?: string; endpoint?: string } = {},
): AgentTool[] {
  const { schemaUrl, endpoint, ...network } = options;
  const defaults = { schemaUrl, endpoint };
  const known = schemaUrl || endpoint ? ` Default schema: ${schemaUrl ?? endpoint}.` : '';
  const sourceProps = {
    schema_url: {
      type: 'string',
      description: 'URL of the schema: SDL (.graphql) or introspection JSON.',
    },
    endpoint: {
      type: 'string',
      description: 'A GraphQL endpoint that answers introspection without credentials.',
    },
  };
  const lookup = defineTool({
    name: 'graphql_lookup',
    description: `Look up a GraphQL schema: one type's fields and arguments with deprecation reasons, a field by name across types, or everything marked deprecated. Informational.${known}`,
    inputSchema: {
      type: 'object',
      properties: {
        ...sourceProps,
        type: { type: 'string', description: 'A type name, e.g. "Product".' },
        search: { type: 'string', description: 'Part of a type or field name to find.' },
        deprecated: { type: 'boolean', description: 'List every deprecated field and argument.' },
        limit: { type: 'number', description: 'Lines to show (default 80).' },
      },
    },
    run: async (input) => {
      const { loaded, error } = await loadSchema(sourceOf(input, defaults), network);
      if (!loaded) return `Could not load a schema: ${error}.`;
      const { schema, label } = loaded;
      const limit = num(input, 'limit') ?? 80;
      const header = `Schema: ${label}; ${Object.keys(schema.types).length} types; query type ${schema.queryType ?? 'none'}, mutation type ${schema.mutationType ?? 'none'}.`;
      const type = str(input, 'type');
      if (type) {
        const [typeName, fieldName] = type.split('.');
        if (fieldName) {
          const field = schema.types[typeName]?.fields?.[fieldName];
          return `${header}\n${field ? fieldLine(`${typeName}.${fieldName}`, field) : `${typeName}.${fieldName} is not in this schema.\n${typeReport(schema, typeName, limit)}`}`;
        }
        return `${header}\n${typeReport(schema, type, limit)}`;
      }
      if (bool(input, 'deprecated')) return `${header}\n${deprecatedReport(schema, limit)}`;
      const search = str(input, 'search') ?? str(input, 'query');
      if (search) return `${header}\n${searchReport(schema, search, limit)}`;
      const roots = [schema.queryType, schema.mutationType].filter((t): t is string => !!t);
      return [
        header,
        ...roots.map((root) => typeReport(schema, root, Math.min(limit, 40))),
        'Pass "type", "search" or "deprecated" for more.',
      ].join('\n\n');
    },
  });
  const check = defineTool({
    name: 'graphql_check',
    description: `Validate a GraphQL document (query, mutation or fragment) against a schema: unknown fields with suggestions, deprecated fields and arguments, wrong argument and variable types, missing required input. Pass "compare_to" (an older schema) to see where a missing field went. A validator: its result counts toward proof.${known}`,
    inputSchema: {
      type: 'object',
      properties: {
        ...sourceProps,
        document: {
          type: 'string',
          description:
            'The GraphQL document as the code sends it (inline any ${...} interpolation).',
        },
        variables: {
          type: 'object',
          description: 'Variables the code sends, to spot missing required ones.',
        },
        compare_to: {
          type: 'string',
          description: 'URL of an older schema, used to explain fields missing from the new one.',
        },
      },
      required: ['document'],
    },
    run: async (input) => {
      const document = str(input, 'document') ?? str(input, 'query');
      if (!document)
        return 'graphql_check failed to run: pass "document", the GraphQL text to check. Nothing was checked.';
      const { loaded, error } = await loadSchema(sourceOf(input, defaults), network);
      if (!loaded) return `graphql_check failed to run: ${error}. Nothing was checked.`;
      const history: { label: string; schema: ReducedSchema }[] = [];
      const notes: string[] = [];
      const compareTo = str(input, 'compare_to');
      if (compareTo) {
        const older = await loadSchema({ url: compareTo }, network);
        if (older.loaded) history.push({ label: older.loaded.label, schema: older.loaded.schema });
        else notes.push(`The comparison schema could not be loaded (${older.error}).`);
      }
      const result = validateDocument(document, loaded.schema, {
        variables: obj(input, 'variables'),
        history,
      });
      const errors = result.issues.filter((i) => i.severity === 'error').length;
      const warnings = result.issues.filter((i) => i.severity === 'warning').length;
      const infos = result.issues.filter((i) => i.severity === 'info').length;
      const lines = [
        `Checked the document against ${loaded.label}.`,
        `Result: ${errors} error(s), ${warnings} warning(s), ${infos} note(s); ${result.checkedFields} field(s) checked.`,
      ];
      if (result.issues.length)
        lines.push(...formatIssues(result.issues).map((line) => `- ${line}`));
      else lines.push('No problems found in the checked fields.');
      if (result.uncheckedTypes.length) {
        lines.push(
          `Not checked (types missing from this schema): ${result.uncheckedTypes.map(namedType).join(', ')}`,
        );
      }
      if (/\$\{/.test(document))
        lines.push('Note: the document has ${...} interpolation; inline it and check again.');
      lines.push(...notes.map((note) => `Note: ${note}`));
      lines.push(
        'This is a static check: it does not run the operation, check permissions, cost or runtime errors.',
      );
      return lines.join('\n');
    },
  });
  return [lookup, check];
}
