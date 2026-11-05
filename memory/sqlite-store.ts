// The store on SQLite, so two processes (the app and a batch) can write at once. Same interface as
// the JSON store; node:sqlite is free, local and needs no service.
import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { JsonMemoryStore, type Collection } from './store.ts';

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS docs (
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (collection, id)
  );
`;

export class SqliteMemoryStore extends JsonMemoryStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    super(dirname(file));
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
  }

  // One store per customer: what one customer's runs hold never reaches another's file.
  static forOwner(dir: string, owner: string): SqliteMemoryStore {
    const safe = owner.replace(/[^A-Za-z0-9_-]/g, (char) => `~${char.charCodeAt(0).toString(16)}`);
    return new SqliteMemoryStore(join(dir, 'customers', `${safe || '_local'}.sqlite`));
  }

  private put(collection: Collection, id: string, value: unknown) {
    this.db
      .prepare('INSERT OR REPLACE INTO docs (collection, id, value) VALUES (?, ?, ?)')
      .run(collection, id, JSON.stringify(value));
  }

  private get<T>(collection: Collection, id: string): T | undefined {
    const row = this.db
      .prepare('SELECT value FROM docs WHERE collection = ? AND id = ?')
      .get(collection, id) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  protected override async write(collection: Collection, id: string, value: unknown) {
    this.put(collection, id, value);
  }

  protected override async read<T>(collection: Collection, id: string) {
    return this.get<T>(collection, id);
  }

  protected override async list<T>(collection: Collection) {
    const rows = this.db
      .prepare('SELECT value FROM docs WHERE collection = ? ORDER BY id')
      .all(collection) as { value: string }[];
    return rows.map((row) => JSON.parse(row.value) as T);
  }

  protected override async update<T>(
    collection: Collection,
    id: string,
    change: (value: T | undefined) => T,
  ) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = change(this.get<T>(collection, id));
      this.put(collection, id, value);
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

// Every customer's store, for what reads across them on purpose: the dashboard and the batch.
export function customerStores(dir: string): SqliteMemoryStore[] {
  let names: string[] = [];
  try {
    names = readdirSync(join(dir, 'customers'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return names
    .filter((name) => name.endsWith('.sqlite'))
    .map((name) => new SqliteMemoryStore(join(dir, 'customers', name)));
}
