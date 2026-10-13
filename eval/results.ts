import { readFile, writeFile } from 'node:fs/promises';

export const RESULT_COLUMNS = [
  'repo',
  'commit',
  'file',
  'line',
  'modelId',
  'confidence',
  'label',
  'notes',
] as const;

export const RUN_COLUMNS = ['repo', 'commit', 'status', 'findingCount', 'notes'] as const;

export type ResultRow = {
  repo: string;
  commit: string;
  file: string;
  line: string;
  modelId: string;
  confidence: 'confirmed' | 'needs-review';
  label: '' | 'correct' | 'wrong';
  notes: string;
};

export type RunRow = {
  repo: string;
  commit: string;
  status: 'scanned' | 'clone-failed' | 'scan-failed';
  findingCount: string;
  notes: string;
};

function escapeCsv(value: string) {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function renderCsv(columns: readonly string[], rows: readonly object[]) {
  return `${[
    columns.join(','),
    ...rows.map((row) =>
      columns.map((column) => escapeCsv((row as Record<string, string>)[column] ?? '')).join(','),
    ),
  ].join('\n')}\n`;
}

export function parseCsv(content: string) {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"' && field === '') quoted = true;
    else if (character === ',') {
      record.push(field);
      field = '';
    } else if (character === '\n') {
      record.push(field.replace(/\r$/, ''));
      records.push(record);
      record = [];
      field = '';
    } else field += character;
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field.');
  if (field !== '' || record.length) {
    record.push(field.replace(/\r$/, ''));
    records.push(record);
  }
  return records.filter((fields) => fields.some((value) => value !== ''));
}

export async function readCsv<T extends object>(path: string, columns: readonly string[]) {
  const records = parseCsv(await readFile(path, 'utf8'));
  const header = records.shift();
  if (!header || header.join('\0') !== columns.join('\0'))
    throw new Error(`${path} must have columns: ${columns.join(',')}`);
  return records.map((fields, index) => {
    if (fields.length !== columns.length)
      throw new Error(
        `${path}:${index + 2} has ${fields.length} fields; expected ${columns.length}.`,
      );
    return Object.fromEntries(
      columns.map((column, fieldIndex) => [column, fields[fieldIndex]]),
    ) as T;
  });
}

export async function writeCsv(path: string, columns: readonly string[], rows: readonly object[]) {
  await writeFile(path, renderCsv(columns, rows));
}
