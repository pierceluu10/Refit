import pg, { type Pool, type PoolClient } from 'pg';

export const CONNECTION_TIMEOUT_MS = 10_000;
// Every hosted query is short; a migration must also finish within this limit.
export const STATEMENT_TIMEOUT_MS = 30_000;
// The client gives up a little after the server would have, so a lost network cannot hang a query.
const QUERY_TIMEOUT_MS = STATEMENT_TIMEOUT_MS + 5_000;
// Node socket errors, SQLSTATE 57P01–57P03 (shutdown, crash, starting up) and 57014 (statement
// timeout); class 08 (connection exception) is matched by prefix.
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  '57P01',
  '57P02',
  '57P03',
  '57014',
]);
// node-postgres raises these without a code when a connection drops or times out.
const UNAVAILABLE_MESSAGES = [
  'Connection terminated',
  'timeout exceeded when trying to connect',
  'Query read timeout',
  'Client has encountered a connection error and is not queryable',
];

export function openHostedPool(connectionString: string, onError: (error: Error) => void) {
  const pool = new pg.Pool({
    connectionString,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    // A SET passes through Supabase's session pooler; a statement_timeout startup parameter might
    // not. The pool hands out a new connection only after it succeeds.
    onConnect: async (client) => {
      await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    },
  });
  // An idle client whose server goes away emits here; unhandled, it would end the process.
  pool.on('error', onError);
  return pool;
}

// True for errors that mean PostgreSQL could not be reached or answer, not that a query was wrong.
export function isDatabaseUnavailable(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  return (
    UNAVAILABLE_CODES.has(code) ||
    code.startsWith('08') ||
    UNAVAILABLE_MESSAGES.some((message) => error.message.startsWith(message))
  );
}

export async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  // A checked-out client that loses its connection between queries emits 'error' with no pool
  // listener attached; the failure still reaches the next query, so the event itself is ignored.
  const ignore = () => undefined;
  client.on('error', ignore);
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // A broken connection cannot roll back; the server ends its transaction when the session goes.
    await client.query('ROLLBACK').catch((rollback: Error) => (broken = rollback));
    throw error;
  } finally {
    client.removeListener('error', ignore);
    client.release(broken);
  }
}
