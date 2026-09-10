import pg from "pg";

// One pool per process. Next.js hot-reload re-evaluates modules, so
// without the global guard a dev session leaks a pool per edit and
// exhausts the connection limit within a few minutes.
const globalForPg = globalThis as unknown as { pool?: pg.Pool };

const CONNECTION =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:55432/inventory_core";

// Anything that is not plainly loopback is treated as a real,
// TLS-required database. Supabase refuses an unencrypted connection
// outright, and node-postgres does not enable TLS from the connection
// string alone.
const isLocal = (() => {
  try {
    const h = new URL(CONNECTION).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return false;
  }
})();

export const pool =
  globalForPg.pool ??
  new pg.Pool({
    connectionString: CONNECTION,
    ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
    // The API takes one connection per request; the 200-concurrent
    // gate is the shape to size for.
    //
    // On a serverless host this number is PER INSTANCE, and Vercel
    // will happily run dozens of them. Twenty each is a good way to
    // exhaust Supavisor's tenant limit and start refusing connections
    // under exactly the load the pool was sized for. A small pool per
    // instance is right there: the pooler is what multiplexes, not us.
    max: process.env.VERCEL ? 3 : 20,

    // Serverless instances are frozen between requests and killed
    // without warning. A connection held open across that is a
    // connection the pooler is still counting.
    idleTimeoutMillis: process.env.VERCEL ? 10_000 : 30_000,

    // Fail fast enough that a misconfigured host surfaces as an error
    // rather than as a request that eventually times out somewhere
    // less informative.
    connectionTimeoutMillis: 10_000,
  });

if (process.env.NODE_ENV !== "production") globalForPg.pool = pool;

// REQUIRED, not optional. node-postgres emits 'error' on idle clients
// when the backend goes away — a database restart, a failover, an
// idle-connection timeout, or (in development) a docker container
// being rebuilt. Without a listener, Node turns that into an
// uncaughtException and takes the whole server down.
//
// Found the hard way: `npm run db:reset` while the dev server was
// running crashed it repeatedly.
pool.on("error", (err) => {
  console.error("[db] idle client error — the pool will replace it:", err.message);
});

/**
 * Run queries as a signed-in user.
 *
 * ── Why this exists rather than a plain pool.query ──
 *
 * The dashboard is a client of this system, not a privileged part of
 * it. Every query it makes runs as `authenticated` with the caller's
 * claims set, so row-level security applies to the UI exactly as it
 * applies to a third-party app. Switch to the Shop 1 manager and
 * Shop 2's stock genuinely disappears from the screen — not because
 * a WHERE clause hid it, but because the database refused it.
 *
 * A page that queried as `postgres` would look identical and prove
 * nothing.
 */
export async function withSession<T>(
  claims: Record<string, unknown>,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(claims),
    ]);
    // SET LOCAL is transaction-scoped, so COMMIT restores the
    // connection's own role before it returns to the pool.
    await client.query("set local role authenticated");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run as the signed-in user, then throw the work away.
 *
 * The import screen offers a preview, and a preview that guesses is
 * worse than none: it would pass rows the real import rejects, because
 * the rules live in constraints, triggers and CHECK clauses rather
 * than in anything a page could reimplement.
 *
 * So the preview IS the import. It runs every row through the same
 * function, collects exactly what happened, and rolls back. What you
 * see is what you will get, because it already got it.
 *
 * The rollback is unconditional — no early return, no branch that
 * could commit. Anything read out of here must be plain data, since
 * the rows it describes no longer exist by the time it is returned.
 */
export async function withRollback<T>(
  claims: Record<string, unknown>,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(claims),
    ]);
    await client.query("set local role authenticated");
    return await fn(client);
  } finally {
    // In the finally, so a thrown error and a clean return leave by
    // the same door. A commit path that exists at all is a commit path
    // that runs one day.
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

/**
 * Queries that run BEFORE a session exists — listing the personas the
 * switcher offers. This is the one place the app legitimately reads
 * without claims, standing in for what an auth server would do.
 */
export async function withoutSession<T>(
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
