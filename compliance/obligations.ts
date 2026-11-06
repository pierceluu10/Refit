// The obligations the rules agent has read, so the dashboard can show them without spending again.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Obligation } from '../shared/types.ts';

const FILE_NAME = 'obligations.json';

const obligationsFile = (env: NodeJS.ProcessEnv) =>
  join(env.REFIT_AUDIT_DIR ?? join(process.cwd(), '.refit', 'audit'), FILE_NAME);

export async function listObligations(env: NodeJS.ProcessEnv = process.env): Promise<Obligation[]> {
  const text = await readFile(obligationsFile(env), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '[]';
      throw error;
    },
  );
  return JSON.parse(text) as Obligation[];
}

// Keeps what earlier reads found, newest wins per id: a read that could not reach one family must not drop it.
export async function saveObligations(
  obligations: Obligation[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const byId = new Map((await listObligations(env)).map((o) => [o.id, o]));
  for (const obligation of obligations) byId.set(obligation.id, obligation);
  const file = obligationsFile(env);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, `${JSON.stringify([...byId.values()], null, 2)}\n`);
}
