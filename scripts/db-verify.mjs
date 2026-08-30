// Prove a deployed database actually WORKS, not merely that it migrated.
//
//   npm run db:verify                      # the local container
//   DATABASE_URL=... npm run db:verify     # a real project
//
// Migrating cleanly and working are different things. Against Supabase
// this system can apply all 43 migrations without an error and still
// be unable to sign anybody in, because pgcrypto lives in a schema the
// definer functions cannot see. That failure has no symptom until a
// person tries to log in.
//
// Read-only apart from a handful of probe rows it creates and removes.

import pg from "pg";
import "./env.mjs";
import { CONNECTION, connectionOptions } from "./db-config.mjs";

const c = new pg.Client(connectionOptions(process.argv[2] ?? CONNECTION));
await c.connect();

const where = (() => {
  try { return new URL(process.argv[2] ?? CONNECTION).hostname; } catch { return "?"; }
})();
console.log(`
Verifying ${where}`);

let bad = 0;
const ok = (name, cond, detail = "") => {
  if (cond) console.log(`  ✔ ${name}`);
  else { bad++; console.log(`  ✖ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

const PROBE_ID = "22222222-2222-4222-8222-0000000000ff";
const ADMIN = { sub: PROBE_ID, role: "admin", all_locations: true, location_ids: "" };
const asAdmin = () => c.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(ADMIN)]);

console.log("\n── the four things that would have broken silently ──\n");

// 1. pgcrypto inside a definer function
await asAdmin();
try {
  const r = await c.query(`select platform.create_api_client('probe', array['stock:read']) as k`);
  ok("gen_random_bytes + digest work inside a definer function", !!r.rows[0].k);
} catch (e) { ok("gen_random_bytes + digest inside a definer function", false, e.message); }

// 2. bcrypt, via the real sign-in path
try {
  await c.query(`insert into platform.app_user (id,email,full_name,role,all_locations)
                 values ($1,'probe@example.com','Probe','admin',true)
                 on conflict (email) do nothing`, [PROBE_ID]);
  await c.query(`insert into platform.credential (user_id, password_hash)
                 select id, crypt('probe-pw', gen_salt('bf',10)) from platform.app_user
                  where email='probe@example.com'
                 on conflict (user_id) do nothing`);
  const s = await c.query("select * from platform.sign_in($1,$2)", ["probe@example.com", "probe-pw"]);
  ok("sign-in works (crypt inside platform.sign_in)", s.rows.length === 1,
     `${s.rows.length} rows back`);

  const wrong = await c.query("select * from platform.sign_in($1,$2)", ["probe@example.com", "nope"]);
  ok("and a wrong password is refused", wrong.rows.length === 0);
} catch (e) { ok("sign-in", false, e.message); }

// 3. pg_trgm, via product search
try {
  await c.query(`insert into catalog.product (name, base_uom_id)
                 select 'Probe Toor Dal', id from catalog.uom where code='PCS'
                 on conflict do nothing`);
  const r = await c.query("select * from catalog.search_products($1, 5)", ["toor"]);
  ok("fuzzy product search works (word_similarity from pg_trgm)", r.rows.length > 0,
     `${r.rows.length} results for "toor"`);
} catch (e) { ok("fuzzy product search", false, e.message); }

// 4. RLS actually applies to `authenticated`
//
// This used to assert "an operator sees no stock at all", and it
// passed — against an EMPTY database, where it could not have failed.
// The moment there was real data it found two rows, and they turned
// out to be TRANSIT: virtual locations are readable by everyone on
// purpose (migration 0016), because otherwise a shop manager could not
// dispatch their own goods — the transit leg of their own transfer
// would be refused.
//
// So the question is not "does the operator see nothing" but "does the
// operator see only what they hold", and that needs stock at several
// locations before it means anything.
try {
  await c.query("begin");
  await c.query("set local role authenticated");

  const sh1 = (await c.query("select id from platform.location where code='SH1'")).rows[0];

  if (!sh1) {
    console.log("  · RLS scoping not checked — no seed data on this database");
  } else {
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
      sub: "22222222-2222-4222-8222-000000000001",
      role: "operator", all_locations: false, location_ids: sh1.id,
    })]);

    const seen = (await c.query(`
      select l.code, l.type, count(*)::int n
        from stock.balance b join platform.location l on l.id = b.location_id
       group by l.code, l.type order by l.code`)).rows;

    const real = seen.filter((r) => r.type !== "VIRTUAL");
    const foreign = real.filter((r) => r.code !== "SH1");

    ok("an operator sees their own shop's stock",
      real.some((r) => r.code === "SH1" && r.n > 0),
      `saw: ${real.map((r) => `${r.code}=${r.n}`).join(", ") || "nothing"}`);

    ok("and no stock at any location they do not hold",
      foreign.length === 0,
      foreign.map((r) => `${r.code}=${r.n}`).join(", "));

    // Shared by design. Asserted rather than tolerated, so that if it
    // ever stops being true somebody finds out here.
    ok("transit is visible to everyone (deliberate — migration 0016)",
      seen.some((r) => r.type === "VIRTUAL"),
      "no virtual rows visible; dispatch would now fail");
  }
  await c.query("rollback");
} catch (e) { await c.query("rollback").catch(()=>{}); ok("RLS as authenticated", false, e.message); }

console.log("\n── and the things that must NOT have happened ──\n");

// Our grants script must never have reached Supabase's own schemas.
//
// Filtering by GRANTOR, not by the mere existence of a grant: Supabase
// itself gives `authenticated` full DML on storage.objects — that is
// how its storage RLS model works, and flagging it would be blaming
// ourselves for the platform's own defaults. What matters is whether
// WE granted anything there.
const leaked = (await c.query(`
  select table_schema, table_name, privilege_type
    from information_schema.role_table_grants
   where grantee = 'authenticated'
     and table_schema in ('auth','storage','vault','realtime','graphql')
     and grantor = 'postgres'
   limit 10`)).rows;
ok("our grants never reached auth/storage/vault",
   leaked.length === 0,
   leaked.map(r => `${r.table_schema}.${r.table_name} ${r.privilege_type}`).join(", "));

// our schemas ARE reachable
const granted = (await c.query(`
  select count(distinct table_schema)::int n
    from information_schema.role_table_grants
   where grantee = 'authenticated'
     and table_schema in ('platform','catalog','stock','movement','partner','insight','alerting','ledger')`))
  .rows[0].n;
ok("our eight schemas are reachable by `authenticated`", granted === 8, `${granted} of 8`);

// the auth shim must not have been applied
const shim = (await c.query(
  `select pg_get_functiondef(p.oid) as def from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='auth' and p.proname='jwt'`)).rows[0];
ok("Supabase's own auth.jwt() is intact (shim not applied)",
   !!shim && shim.def.includes("request.jwt.claim"),
   shim ? "definition changed" : "auth.jwt() missing");

// every function can see the extensions schema
const blind = (await c.query(`
  select count(*)::int n from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral unnest(coalesce(p.proconfig,'{}')) cfg
   where n.nspname in ('platform','catalog','stock','movement','partner','insight','alerting','ledger')
     and cfg like 'search\\_path=%' and cfg not like '%extensions%'`)).rows[0].n;
ok("no function is blind to the extensions schema", blind === 0, `${blind} still blind`);

// integrity checks
await asAdmin();
for (const [name, fn] of [
  ["stock balances", "stock.verify_balances()"],
  ["transit", "movement.verify_transit()"],
  ["reservations", "stock.verify_reservations()"],
  ["the books", "ledger.verify_balanced()"],
]) {
  const n = (await c.query(`select count(*)::int n from ${fn}`)).rows[0].n;
  ok(`${name} reconcile`, n === 0, `${n} discrepancies`);
}

// clean up the probe rows
await c.query("delete from catalog.product where name='Probe Toor Dal'");
await c.query("delete from platform.api_client where name='probe'");
await c.query("delete from platform.session where user_id=$1", [PROBE_ID]);
await c.query("delete from platform.credential where user_id=$1", [PROBE_ID]);
await c.query("delete from platform.app_user where email='probe@example.com'");

console.log(`\n${bad === 0 ? "All checks passed." : `${bad} check(s) failed.`}\n`);
await c.end();
process.exit(bad === 0 ? 0 : 1);
