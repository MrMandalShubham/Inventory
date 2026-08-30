// Single source of truth for how the database is reached.
//
// Local development runs a Postgres container on port 55432 rather
// than 5432, so it never collides with a Postgres the developer
// already runs. Production is Supabase.
//
// ── Why this file knows the difference ──
//
// Several things in this repo are safe against a disposable container
// and catastrophic against a real project: the test harness TRUNCATEs
// every table, the seed script rebuilds the world, and the local auth
// shim would overwrite Supabase's own auth.jwt(). Each of those now
// asks this file whether the target is local, and refuses if it is
// not. A guard that depends on remembering is not a guard.

export const CONTAINER = "inventory-core-db";

// Tracks the deployed project's major version. Supabase runs 17.6; a
// suite green on 16 says nothing about the database the code actually
// lives on. db-up.mjs recreates the container when this changes.
export const IMAGE = "postgres:17-alpine";
export const PORT = process.env.PGPORT ?? "55432";
export const PASSWORD = "postgres";
export const DB = "inventory_core";

export const LOCAL_CONNECTION =
  `postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DB}`;

export const CONNECTION = process.env.DATABASE_URL ?? LOCAL_CONNECTION;

/**
 * Is this a throwaway database on this machine?
 *
 * Deliberately strict: anything that is not plainly a loopback address
 * is treated as real. Being wrong in that direction costs a refused
 * command; being wrong in the other direction costs a database.
 */
export function isLocal(connection = CONNECTION) {
  try {
    const host = new URL(connection).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1"
        || host === "0.0.0.0" || host === "host.docker.internal";
  } catch {
    return false;
  }
}

/**
 * Refuse a destructive operation against anything but the local
 * container.
 *
 * Called by the test harness and the seed script. Both TRUNCATE every
 * table in the system; pointing DATABASE_URL at Supabase and running
 * `npm test` would empty the production database in about four
 * seconds, and the first anyone would know is that the catalogue was
 * gone.
 */
export function assertLocal(what, connection = CONNECTION) {
  if (isLocal(connection)) return;

  let where = "the configured database";
  try { where = new URL(connection).hostname; } catch { /* unparseable */ }

  throw new Error(
    `REFUSING_TO_RUN_AGAINST_A_REMOTE_DATABASE\n\n` +
    `  ${what} truncates every table in the system, and DATABASE_URL points at\n` +
    `  ${where} — not the local container.\n\n` +
    `  If this really is a disposable database, unset DATABASE_URL or point it\n` +
    `  at 127.0.0.1. There is deliberately no flag to override this.\n`);
}

/**
 * The test suite's target, which may be remote ONLY when named.
 *
 * assertLocal above says there is deliberately no flag to override
 * it, and there still is not — this is a different question with a
 * different answer.
 *
 * The suite must normally refuse a remote database, because the usual
 * way it reaches one is a stray DATABASE_URL, and the cost is a wiped
 * project. But "does this code work on Supabase?" cannot be answered
 * by a container pretending to be Supabase, and the difference has
 * already cost a broken deploy once (see supabase/local/01-supabase-
 * shape.sql). So there is one path to a remote run, and it is narrow:
 *
 *   • scripts/test-supabase.mjs is the only caller that sets the
 *     variable, and it will not set it until the host is typed on the
 *     command line,
 *   • the value must MATCH the host actually connected to, so a
 *     variable left over in a shell cannot authorise a different
 *     database than the one it was typed for.
 *
 * Anything else — CI, a bare `npm test`, an editor task — still gets
 * the flat refusal.
 */
export function assertDisposableTarget(what, connection = CONNECTION) {
  if (isLocal(connection)) return;

  let host = "?";
  try { host = new URL(connection).hostname; } catch { /* unparseable */ }

  if (process.env.ALLOW_REMOTE_TEST_TARGET === host) return;

  throw new Error(
    "REFUSING_TO_RUN_AGAINST_A_REMOTE_DATABASE\n\n" +
    `  ${what} truncates every table in the system, and DATABASE_URL points at\n` +
    `  ${host} — not the local container.\n\n` +
    "  To run the suite against a real Supabase project ON PURPOSE, use the\n" +
    "  runner, which makes you name the host and shows you what it will\n" +
    "  destroy first:\n\n" +
    `    npm run test:supabase -- --target=${host}\n\n` +
    "  Point it at a project you can afford to empty. It is not a smoke test\n" +
    "  against production.\n");
}

/**
 * Connection options for `pg`.
 *
 * Supabase requires TLS. node-postgres does not enable it from the
 * connection string alone unless sslmode is present, and a plain
 * `?sslmode=require` still verifies against a CA bundle that does not
 * include Supabase's by default.
 */
export function connectionOptions(connection = CONNECTION) {
  return {
    connectionString: connection,
    ...(isLocal(connection)
      ? {}
      : { ssl: { rejectUnauthorized: false } }),
  };
}

/** The eight schemas this system owns. Nothing outside them is ours. */
export const OUR_SCHEMAS = [
  "platform", "catalog", "stock", "movement",
  "partner", "insight", "alerting", "ledger",
];

/**
 * Refuse to TRUNCATE if CASCADE could reach somebody else's data.
 *
 * The inventory now shares a Supabase project with a customer-facing
 * app. `TRUNCATE ... CASCADE` follows foreign keys INWARD: any table
 * anywhere that references one of ours gets emptied too, silently and
 * in the same statement.
 *
 * Today no such key exists. That is not a reason to skip the check —
 * the customer app is under active development, and the day somebody
 * adds `order_items.product_id → catalog.product` is the day a demo
 * reseed deletes real orders. So this is re-checked on every run
 * rather than reasoned about once.
 */
export async function assertTruncateCannotEscape(client) {
  const { rows } = await client.query(`
    select cn.nspname as child_schema, cl.relname as child_table,
           pn.nspname as parent_schema, pl.relname as parent_table,
           con.conname
      from pg_constraint con
      join pg_class cl on cl.oid = con.conrelid
      join pg_namespace cn on cn.oid = cl.relnamespace
      join pg_class pl on pl.oid = con.confrelid
      join pg_namespace pn on pn.oid = pl.relnamespace
     where con.contype = 'f'
       and pn.nspname = any($1)
       and cn.nspname <> all($1)`, [OUR_SCHEMAS]);

  if (rows.length === 0) return;

  const list = rows
    .map((r) =>
      `    ${r.child_schema}.${r.child_table} → ${r.parent_schema}.${r.parent_table}  (${r.conname})`)
    .join("\n");

  throw new Error(
    "REFUSING_TO_TRUNCATE\n\n" +
    `  ${rows.length} table(s) outside the inventory schemas reference tables inside\n` +
    "  them. TRUNCATE ... CASCADE would empty those too:\n\n" +
    list +
    "\n\n  That is somebody else's data. Drop the foreign key, or seed a database\n" +
    "  that is not shared.\n");
}

/**
 * A destructive operation against a REAL database, done on purpose.
 *
 * Unlike assertLocal — which the test harness uses and which can never
 * be overridden — seeding a deployed database is a legitimate act you
 * do once. It just must not be possible by accident, so the host has
 * to be named on the command line. Typing it is the confirmation.
 */
export function assertConfirmedTarget(what, argv, connection = CONNECTION) {
  if (isLocal(connection)) return;

  let host = "?";
  try { host = new URL(connection).hostname; } catch { /* unparseable */ }

  if (argv.includes(`--target=${host}`)) return;

  throw new Error(
    "REFUSING_TO_RUN_AGAINST_A_REMOTE_DATABASE\n\n" +
    `  ${what} truncates every inventory table, and DATABASE_URL points at\n` +
    `  ${host}.\n\n` +
    "  If that is really what you want, name the host so it cannot happen by\n" +
    "  accident:\n\n" +
    `    npm run db:seed -- --target=${host}\n`);
}
