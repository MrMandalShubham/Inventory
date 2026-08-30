// Apply migrations in order, forward only.
//
// Every migration runs inside a transaction and is recorded in
// platform.schema_migration. A migration that has run anywhere is
// never edited — see docs/02 §5.

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import "./env.mjs";
import { CONNECTION, isLocal, connectionOptions } from "./db-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const migrationsDir = join(root, "supabase", "migrations");
const localDir = join(root, "supabase", "local");

const sqlIn = (dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

const local = isLocal();
const client = new pg.Client(connectionOptions());
await client.connect();

const target = (() => {
  try { return new URL(CONNECTION).hostname; } catch { return "?"; }
})();
console.log(`
Target: ${target} ${local ? "(local container)" : "(REMOTE)"}
`);

// ── the migration session must be able to see the extensions ──
//
// On Supabase, pgcrypto and pg_trgm live in a schema called
// `extensions`, which is not on the default search_path of a fresh
// connection. A `language sql` function body is PARSED when the
// function is created, so 0022_auth.sql failed at migration time with
// "function digest(text, unknown) does not exist" — the function could
// not be created at all, never mind called.
//
// Setting it here rather than in each migration keeps the migrations
// portable: on the local container `extensions` does not exist, and
// Postgres silently ignores a missing schema in a search_path.
//
// This affects only where names RESOLVE. Every object our migrations
// create is schema-qualified, so nothing lands anywhere unexpected.
await client.query('set search_path = "$user", public, extensions');

// ── and body validation has to be deferred on a remote target ──
//
// The line above is not enough on its own. A function that pins its
// own search_path is validated against THAT path, not the session's —
// and ours pin `platform, public`, which on Supabase cannot see
// pgcrypto. So `create function` itself fails, before migration 0043
// gets the chance to append `extensions`.
//
// Turning off body checking creates the function without parsing its
// body; 0043 then fixes every search_path, and the functions resolve
// correctly from that point on.
//
// The cost is real and worth naming: a genuine syntax error inside a
// function body would not be caught here. It IS caught on the local
// container, where checking stays on and where every migration is run
// and tested before it ever reaches a project. This is the same
// mechanism pg_restore uses for the same reason.
if (!local) {
  await client.query("set check_function_bodies = off");
  console.log("· note   body validation deferred to migration 0043 (see scripts/migrate.mjs)\n");
}

// ── The auth shim is LOCAL ONLY, and now enforced ──
//
// It defines auth.jwt() and auth.uid(). A real Supabase project
// already has both, owned by supabase_auth_admin and wired into
// Supabase Auth. Applying the shim there would either fail on
// permissions or — worse, if run as an owner — replace the real
// functions with our approximations and quietly change what every
// policy in the project sees.
//
// The file says "never applied to a real project" in its own header.
// That was a comment; this is the check.
if (local) {
  for (const file of sqlIn(localDir)) {
    if (file.startsWith("99-")) continue; // grants run after migrations
    await client.query(readFileSync(join(localDir, file), "utf8"));
    console.log(`• local  ${file}`);
  }
} else {
  console.log("· skip   local/ shim — the project provides auth.jwt() itself");
}

// RLS on the bookkeeping table too. It holds no business data, but
// "no exceptions granted for now" only means something if it has no
// exceptions — and the coverage check in CI does not know or care
// that this table is infrastructure.
await client.query(`
  create schema if not exists platform;
  create table if not exists platform.schema_migration (
    filename    text primary key,
    applied_at  timestamptz not null default now()
  );
  alter table platform.schema_migration enable row level security;
  do $$
  begin
    if not exists (
      select 1 from pg_policy p
        join pg_class c on c.oid = p.polrelid
       where c.relname = 'schema_migration' and p.polname = 'schema_migration_admin_read'
    ) then
      create policy schema_migration_admin_read on platform.schema_migration
        for select using (coalesce(auth.jwt() ->> 'role', '') = 'admin');
    end if;
  end $$;
`);

const { rows } = await client.query("select filename from platform.schema_migration");
const applied = new Set(rows.map((r) => r.filename));

let count = 0;
for (const file of sqlIn(migrationsDir)) {
  if (applied.has(file)) {
    console.log(`· skip   ${file}`);
    continue;
  }
  const sql = readFileSync(join(migrationsDir, file), "utf8");
  try {
    await client.query("begin");
    await client.query(sql);
    await client.query("insert into platform.schema_migration (filename) values ($1)", [file]);
    await client.query("commit");
    console.log(`✓ apply  ${file}`);
    count++;
  } catch (err) {
    await client.query("rollback");
    console.error(`✗ FAILED ${file}\n  ${err.message}`);
    await client.end();
    process.exit(1);
  }
}

// Grants last: they reference objects the migrations just created.
// Needed on BOTH targets — `authenticated` has to be able to reach our
// schemas before row-level security can decide what it sees — so this
// one is not skipped for a remote project.
for (const file of sqlIn(localDir).filter((f) => f.startsWith("99-"))) {
  await client.query(readFileSync(join(localDir, file), "utf8"));
  console.log(`• grants ${file}`);
}

console.log(count === 0 ? "\nUp to date." : `\n${count} migration(s) applied.`);
await client.end();
