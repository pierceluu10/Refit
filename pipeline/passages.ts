import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, isObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

export const MAX_PASSAGE_CHARACTERS = 1500;
export const PASSAGE_TEXT_CAP = 6000;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const DOCS_ROOT = fileURLToPath(new URL('./fixtures/docs/', import.meta.url));

export type DocPassage = {
  id: string;
  provider: string;
  sourceUrl: string;
  pageSha256: string;
  headingPath: string[];
  kind: 'doc' | 'spec-description' | 'changelog';
  text: string;
};

export type PassageIndex = {
  formatVersion: 1;
  kind: 'refit-passage-index';
  sha256: string;
  passages: DocPassage[];
};

export type PinnedPage = {
  provider: string;
  sourceUrl: string;
  pageSha256: string;
  kind: 'doc' | 'changelog';
  content: string;
};

export function passageId(pageSha256: string, headingPath: string[], index: number) {
  return digest(`${pageSha256}${headingPath.join('\u001f')}${index}`).slice(0, 16);
}

export function stripDocNoise(content: string) {
  return content
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, '')
    .replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, '')
    .replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level: string) => `\n${'#'.repeat(Number(level))} `)
    .replace(/<\/h[1-6]>/gi, '\n');
}

function chunks(text: string) {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length < 8) return [];
  const parts: string[] = [];
  let rest = cleaned;
  while (rest.length > MAX_PASSAGE_CHARACTERS) {
    let cut = rest.lastIndexOf(' ', MAX_PASSAGE_CHARACTERS);
    if (cut < Math.floor(MAX_PASSAGE_CHARACTERS / 2)) cut = MAX_PASSAGE_CHARACTERS;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function passagesFromPage(page: PinnedPage): DocPassage[] {
  const lines = stripDocNoise(page.content).split(/\r?\n/);
  const stack: { level: number; title: string }[] = [];
  const sections: { headingPath: string[]; body: string[] }[] = [];
  let current = { headingPath: [] as string[], body: [] as string[] };
  const push = () => {
    if (current.body.some((line) => line.trim())) sections.push(current);
  };
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      push();
      const level = heading[1].length;
      const title = heading[2].replace(/\s+#+\s*$/, '').trim();
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title });
      current = { headingPath: stack.map((item) => item.title), body: [] };
      continue;
    }
    if (/^\s*(skip to content|on this page|table of contents)\s*$/i.test(line)) continue;
    if (/^\s*\[[^\]]+\]\([^)]+\)\s*$/.test(line)) continue;
    current.body.push(line);
  }
  push();
  const passages: DocPassage[] = [];
  for (const section of sections) {
    const paragraphs = section.body
      .join('\n')
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
      .filter((paragraph) => paragraph.length >= 8);
    let index = 0;
    for (const paragraph of paragraphs) {
      for (const text of chunks(paragraph)) {
        passages.push({
          id: passageId(page.pageSha256, section.headingPath, index),
          provider: page.provider,
          sourceUrl: page.sourceUrl,
          pageSha256: page.pageSha256,
          headingPath: section.headingPath,
          kind: page.kind,
          text,
        });
        index += 1;
      }
    }
  }
  return passages;
}

function descriptionText(value: unknown) {
  if (!isObject(value) || typeof value.description !== 'string') return undefined;
  const text = value.description.trim();
  return text.length ? text : undefined;
}

function addSpecPassage(
  passages: DocPassage[],
  input: { provider: string; sourceUrl: string; pageSha256: string },
  headingPath: string[],
  text: string,
) {
  chunks(text).forEach((chunk, index) => {
    passages.push({
      id: passageId(input.pageSha256, headingPath, index),
      provider: input.provider,
      sourceUrl: input.sourceUrl,
      pageSha256: input.pageSha256,
      headingPath,
      kind: 'spec-description',
      text: chunk,
    });
  });
}

export function passagesFromSpecification(input: {
  provider: string;
  document: Record<string, unknown>;
  sourceUrl: string;
  pageSha256: string;
}) {
  const passages: DocPassage[] = [];
  const components = input.document.components;
  if (isObject(components) && isObject(components.schemas)) {
    for (const schema of Object.keys(components.schemas).sort()) {
      const definition = components.schemas[schema];
      const schemaDescription = descriptionText(definition);
      if (schemaDescription) addSpecPassage(passages, input, [schema], schemaDescription);
      if (!isObject(definition) || !isObject(definition.properties)) continue;
      for (const property of Object.keys(definition.properties).sort()) {
        const propertyDescription = descriptionText(definition.properties[property]);
        if (propertyDescription)
          addSpecPassage(passages, input, [schema, property], propertyDescription);
      }
    }
  }
  if (isObject(input.document.paths)) {
    const methods = ['delete', 'get', 'head', 'options', 'patch', 'post', 'put'];
    for (const path of Object.keys(input.document.paths).sort()) {
      const item = input.document.paths[path];
      if (!isObject(item)) continue;
      for (const method of methods) {
        const operation = item[method];
        if (!isObject(operation)) continue;
        const operationId =
          typeof operation.operationId === 'string' && operation.operationId.trim()
            ? operation.operationId.trim()
            : `${method.toUpperCase()} ${path}`;
        const summary = typeof operation.summary === 'string' ? operation.summary.trim() : '';
        const description = descriptionText(operation) ?? '';
        const text = [summary, description].filter(Boolean).join(' ');
        if (text) addSpecPassage(passages, input, [operationId], text);
        if (!Array.isArray(operation.parameters)) continue;
        for (const parameter of operation.parameters) {
          if (!isObject(parameter) || typeof parameter.name !== 'string') continue;
          const parameterDescription = descriptionText(parameter);
          if (parameterDescription)
            addSpecPassage(passages, input, [operationId, parameter.name], parameterDescription);
        }
      }
    }
  }
  return passages;
}

export async function loadPinnedPages(): Promise<PinnedPage[]> {
  const manifest = parseObject(await readFile(join(DOCS_ROOT, 'manifest.json'), 'utf8'), 'docs');
  if (!Array.isArray(manifest.pages))
    throw new PipelineInputError('Pinned doc manifest is missing pages.');
  const pages: PinnedPage[] = [];
  for (const page of manifest.pages) {
    if (
      !isObject(page) ||
      typeof page.provider !== 'string' ||
      !PROVIDER_ID.test(page.provider) ||
      typeof page.sourceUrl !== 'string' ||
      typeof page.file !== 'string' ||
      !/^[a-z0-9.-]+$/.test(page.file) ||
      (page.kind !== 'doc' && page.kind !== 'changelog')
    )
      throw new PipelineInputError('Pinned doc manifest contains an invalid page.');
    const content = await readFile(join(DOCS_ROOT, page.file), 'utf8');
    pages.push({
      provider: page.provider,
      sourceUrl: page.sourceUrl,
      pageSha256: digest(content),
      kind: page.kind,
      content,
    });
  }
  return pages;
}

export async function createPassageIndex(input: {
  provider: string;
  document?: Record<string, unknown>;
  sourceUrl?: string;
  pageSha256?: string;
  pages?: PinnedPage[];
}): Promise<PassageIndex> {
  const pages = input.pages ?? (await loadPinnedPages());
  const passages = pages.flatMap(passagesFromPage);
  if (input.document && input.pageSha256) {
    passages.push(
      ...passagesFromSpecification({
        provider: input.provider,
        document: input.document,
        sourceUrl: input.sourceUrl ?? `spec://${input.provider}`,
        pageSha256: input.pageSha256,
      }),
    );
  }
  return {
    formatVersion: 1,
    kind: 'refit-passage-index',
    sha256: digest(JSON.stringify(passages)),
    passages,
  };
}
