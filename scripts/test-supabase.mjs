// Run the confirmation suite against a REAL Supabase project.
//
//   npm run test:supabase -- --target=db.xxxx.supabase.co
//
// ── Why this exists ──
//
// The local container is now shaped like Supabase — Postgres 17, the
// `extensions` schema, the same roles (see supabase/local/01-supabase-
// shape.sql). That closes the gap that let `digest(text, unknown) does
// not exist` reach a deploy. It does not close the gap entirely, and
// pretending otherwise is how the next one gets through:
//
//   • Supavisor's transaction pooling, which the deployed app uses and
//     which discards session state between statements
//   • Supabase's own auth.jwt(), owned by supabase_auth_admin, rather
//     than our four-line shim
//   • pg_cron, absent from the container altogether
//   • whatever Supabase changes next
//
// A container imitating a database is evidence. The database is proof.
//
// ── What this destroys ──
//
// Everything. The suite TRUNCATEs every inventory table before each
// file. Point this at a project you can afford to empty — ideally a
// second, free Supabase project kept for exactly this. Running it
// against the project your storefront reads will take the catalogue,
// the stock and the demo images with it.
//
// So: the host has to be typed, the row counts are shown first, and
// the foreign-key check runs before anything is touched.

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import pg from "pg";
import "./env.mjs";
import {
  CONNECTION, isLocal, connectionOptions,
  assertTruncateCannotEscape, OUR_SCHEMAS,
} from "./db-config.mjs";

const connection = process.env.TEST_DATABASE_URL ?? CONNECTION;

let host = "?";
try { host = new URL(connection).hostname; } catch { /* unparseable */ }

if (isLocal(connection)) {
  console.error(`
  DATABASE_URL points at ${host} — the local container.

  This runner is for proving the code against a real Supabase project.
  For the local suite, use:

    npm test
`);
  process.exit(1);
}

// Typing the host is the confirmation. Same shape as db:seed, for the
// same reason: this must be impossible to do by accident, and a flag
// that is always the same word is one somebody pastes without reading.
if (!process.argv.includes(`--target=${host}`)) {
  console.error(`
  REFUSING — name the host you intend to empty.

    npm run test:supabase -- --target=${host}

  Every inventory table in that project will be truncated, repeatedly.
`);
  process.exit(1);
}

const db = new pg.Client(connectionOptions(connection));
await db.connect();

const version = (await db.query("show server_version")).rows[0].server_version;

// TRUNCATE ... CASCADE follows foreign keys inward. If the customer
// app has grown a key into our schemas since the last run, this stops
// here rather than emptying their orders too.
await assertTruncateCannotEscape(db);

const { rows: counts } = await db.query(`
  select n.nspname as schema, c.relname as table,
         coalesce(s.n_live_tup, 0) as rows
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_stat_user_tables s on s.relid = c.oid
   where c.relkind = 'r' and n.nspname = any($1) and coalesce(s.n_live_tup,0) > 0
   order by 3 desc limit 12`, [OUR_SCHEMAS]);

const total = counts.reduce((a, r) => a + Number(r.rows), 0);

console.log(`
  Target      ${host}
  Postgres    ${version}
  Schemas     ${OUR_SCHEMAS.join(", ")}

  About to DESTROY roughly ${total.toLocaleString()} rows:
`);
for (const r of counts) {
  console.log(`    ${(r.schema + "." + r.table).padEnd(34)} ${String(r.rows).padStart(8)}`);
}
if (counts.length === 0) console.log("    (nothing — these schemas are already empty)");

console.log(`
  Nothing outside those schemas is touched, and the foreign-key check
  above confirmed no other schema references them.
`);

// An interactive confirmation on top of the typed host. The host
// proves you meant THIS database; this proves you meant it NOW.
if (process.stdin.isTTY && !process.argv.includes("--yes")) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`  Type the host again to proceed: `);
  rl.close();
  if (answer.trim() !== host) {
    console.error("\n  Did not match. Nothing was changed.\n");
    await db.end();
    process.exit(1);
  }
}

await db.end();

const env = {
  ...process.env,
  DATABASE_URL: connection,
  // The suite's own guard checks this against the host it actually
  // connects to, so a stale variable cannot authorise a different
  // database than the one named above.
  ALLOW_REMOTE_TEST_TARGET: host,
  // Images in the suite go to local disk. The bucket is shared and
  // content-addressed; a test run should not add objects to it.
  STORAGE_DRIVER: "local",
};

const steps = [
  ["Migrating", "node", ["scripts/migrate.mjs"]],
  ["Testing", "node", ["--import", "tsx", "--test", "--test-concurrency=1", "tests/*.test.mjs"]],
];

for (const [label, cmd, args] of steps) {
  console.log(`\n─── ${label} against ${host} ───\n`);
  const r = spawnSync(cmd, args, {
    stdio: "inherit", shell: process.platform === "win32", env,
  });
  if (r.status !== 0) {
    console.error(`\n${label} failed against ${host}.

  The project is now in whatever state the run left it. To restore the
  demo data:

    npm run db:seed -- --target=${host}
`);
    process.exit(r.status ?? 1);
  }
}

console.log(`
  Passed against ${host} — Postgres ${version}.

  The project is EMPTY of demo data now; the suite truncates as it
  goes. Reseed it if this is a project you use for anything else:

    npm run db:seed -- --target=${host}
    npx tsx scripts/demo-images.mjs
`);
