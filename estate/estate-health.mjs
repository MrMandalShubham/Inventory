// Estate health check — read-only.
//
//   node estate-health.mjs
//
// Reads DATABASE_URL from the environment, or from a .dbenv file
// beside this script. Runs every integrity check the three systems
// ship, plus the cross-system ones none of them can run alone,
// and reports PASS / FAIL / WARN per check.
//
// Nothing here writes. Every query is a select.
//
// ── Why this exists ──
//
// Inventory ships four integrity functions and a db:verify script.
// Logistics ships its own db:verify. Grocery ships nothing. None of
// them can see the other two, so the questions that matter most —
// is an order lost between systems, is stock held under a parcel
// nobody is carrying — have never been answerable from one place.
import pg from "pg";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let url = process.env.DATABASE_URL;
if (!url) {
  const f = join(here, ".dbenv");
  if (existsSync(f)) {
    url = readFileSync(f, "utf8").split("\n")
      .find((l) => l.startsWith("DATABASE_URL="))?.slice("DATABASE_URL=".length).trim();
  }
}
if (!url) {
  console.error("Set DATABASE_URL, or put it in a .dbenv file beside this script.");
  process.exit(2);
}

const db = new pg.Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 60_000,
});

const C = { pass: "\x1b[32m", fail: "\x1b[31m", warn: "\x1b[33m",
            dim: "\x1b[2m", bold: "\x1b[1m", off: "\x1b[0m" };
const tally = { pass: 0, fail: 0, warn: 0 };

function banner(name, sub) {
  console.log(`\n${C.bold}${"═".repeat(72)}${C.off}`);
  console.log(`${C.bold}  ${name}${C.off}${C.dim}  ${sub}${C.off}`);
  console.log(`${C.bold}${"═".repeat(72)}${C.off}`);
}

/**
 * Run one check.
 *
 * `sql` must return a single row with a single numeric column: the
 * number of things that are wrong. Zero is healthy.
 *
 * `level` decides what a non-zero means — 'fail' for an invariant
 * that must hold, 'warn' for something a person should look at but
 * which is not itself corruption.
 */
async function check(label, sql, { level = "fail", detail = null, ok = null } = {}) {
  let n, err = null;
  try {
    const r = await db.query(sql);
    n = Number(Object.values(r.rows[0] ?? { n: 0 })[0]);
  } catch (e) {
    err = e.message;
  }

  if (err) {
    tally.fail++;
    console.log(`  ${C.fail}ERROR${C.off}  ${label}`);
    console.log(`         ${C.dim}${err}${C.off}`);
    return;
  }

  const good = n === 0;
  const tag = good ? `${C.pass}PASS ${C.off}`
                   : level === "warn" ? `${C.warn}WARN ${C.off}` : `${C.fail}FAIL ${C.off}`;
  if (good) tally.pass++; else if (level === "warn") tally.warn++; else tally.fail++;

  console.log(`  ${tag}  ${label}${good ? (ok ? ` ${C.dim}${ok}${C.off}` : "") : `  ${C.bold}${n}${C.off}`}`);

  if (!good && detail) {
    try {
      const d = await db.query(detail);
      for (const row of d.rows.slice(0, 5)) {
        console.log(`         ${C.dim}${Object.entries(row)
          .map(([k, v]) => `${k}=${v === null ? "—" : v}`).join("  ")}${C.off}`);
      }
      if (d.rows.length > 5) console.log(`         ${C.dim}… and ${d.rows.length - 5} more${C.off}`);
    } catch { /* detail is a nicety, never a reason to fail the run */ }
  }
}

await db.connect();

try {
  const { rows: [meta] } = await db.query(
    "select current_database() db, version() v, now() at time zone 'utc' t");
  console.log(`${C.dim}${meta.db} · ${meta.v.split(" on ")[0]} · ${meta.t.toISOString()}${C.off}`);

  // ══════════════════════════════════════════════════════════════
  banner("1 · INVENTORY CORE", "system of record for stock and money");
  // ══════════════════════════════════════════════════════════════

  console.log(`\n${C.dim}  the four integrity functions${C.off}`);

  await check("balance projection reproduces the ledger",
    "select count(*) n from stock.verify_balances()",
    { detail: `select product_id, location_id, batch_id, balance_says, ledger_says
                 from stock.verify_balances() limit 6` });

  await check("reservation rows agree with balance.reserved",
    "select count(*) n from stock.verify_reservations()");

  await check("every accounting journal balances",
    "select count(*) n from ledger.verify_balanced()");

  await check("goods in transit are accounted for",
    "select count(*) n from movement.verify_transit()");

  console.log(`\n${C.dim}  stock sanity${C.off}`);

  await check("no negative on-hand, reserved, allocated or damaged",
    `select count(*) n from stock.balance
      where on_hand < 0 or reserved < 0 or allocated < 0 or damaged < 0`);

  await check("no line claims more stock than it holds",
    `select count(*) n from stock.balance
      where reserved + allocated + damaged > on_hand`);

  await check("no reservation outlived its expiry unswept",
    `select count(*) n from stock.reservation
      where status = 'HELD' and expires_at < now()`,
    { level: "warn",
      detail: `select id, order_ref, expires_at from stock.reservation
                where status='HELD' and expires_at < now() order by expires_at limit 6` });

  await check("lot-tracked stock actually sits in a lot",
    `select count(*) n from stock.balance b
       join catalog.product p on p.id = b.product_id
      where p.tracking_mode <> 'NONE' and b.batch_id is null and b.on_hand > 0`,
    { detail: `select p.sku_code, p.name, p.tracking_mode, b.on_hand
                 from stock.balance b join catalog.product p on p.id=b.product_id
                where p.tracking_mode<>'NONE' and b.batch_id is null and b.on_hand>0
                order by p.sku_code limit 6` });

  console.log(`\n${C.dim}  catalogue${C.off}`);

  await check("every active product has a price",
    `select count(*) n from catalog.product p
      where p.status = 'ACTIVE'
        and not exists (select 1 from catalog.price pr where pr.product_id = p.id)`,
    { level: "warn",
      detail: `select sku_code, name from catalog.product p where p.status='ACTIVE'
                and not exists (select 1 from catalog.price pr where pr.product_id=p.id)
                limit 6` });

  await check("no two active products share a name",
    `select count(*) n from (
       select lower(btrim(name)) nm from catalog.product
        where status='ACTIVE' group by 1 having count(*) > 1) x`,
    { level: "warn",
      detail: `select lower(btrim(name)) as name, count(*) as copies,
                      string_agg(sku_code, ', ' order by sku_code) as skus
                 from catalog.product where status='ACTIVE'
                group by 1 having count(*) > 1 limit 6` });

  await check("every active product has a base unit",
    `select count(*) n from catalog.product where status='ACTIVE' and base_uom_id is null`);

  await check("no product claims a shelf life without lot tracking",
    `select count(*) n from catalog.product
      where shelf_life_days is not null and tracking_mode = 'NONE'`);

  // ══════════════════════════════════════════════════════════════
  banner("2 · LOGISTICS CORE", "delivery operations");
  // ══════════════════════════════════════════════════════════════

  console.log(`\n${C.dim}  the guarantees logistics makes about itself${C.off}`);

  // A table with no RLS is only a leak if a browser role can reach
  // it. ops.schema_migration has RLS off on purpose — 0004 revokes
  // every grant on it instead, which is stronger: RLS can be got
  // wrong by a later policy, a missing grant cannot. So the check is
  // "unreachable", not "has RLS".
  await check("no table is reachable by a browser role without RLS",
    `select count(*) n from pg_class c
       join pg_namespace ns on ns.oid=c.relnamespace
      where c.relkind='r' and ns.nspname in ('delivery','fleet','identity','integration','ops')
        and not c.relrowsecurity
        and exists (select 1 from information_schema.role_table_grants g
                     where g.table_schema=ns.nspname and g.table_name=c.relname
                       and g.grantee in ('anon','authenticated'))`,
    { detail: `select ns.nspname||'.'||c.relname as tbl from pg_class c
                 join pg_namespace ns on ns.oid=c.relnamespace
                where c.relkind='r' and ns.nspname in ('delivery','fleet','identity','integration','ops')
                  and not c.relrowsecurity
                  and exists (select 1 from information_schema.role_table_grants g
                               where g.table_schema=ns.nspname and g.table_name=c.relname
                                 and g.grantee in ('anon','authenticated'))` });

  await check("every table with RLS has at least one policy",
    `select count(*) n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
      where c.relkind='r' and ns.nspname in ('delivery','fleet','identity','integration','ops')
        and c.relrowsecurity
        and not exists (select 1 from pg_policy p where p.polrelid=c.oid)`,
    { detail: `select ns.nspname||'.'||c.relname as tbl from pg_class c
                 join pg_namespace ns on ns.oid=c.relnamespace
                where c.relkind='r' and ns.nspname in ('delivery','fleet','identity','integration','ops')
                  and c.relrowsecurity and not exists (select 1 from pg_policy p where p.polrelid=c.oid)` });

  await check("no role holds DELETE anywhere in logistics",
    `select count(*) n from information_schema.role_table_grants
      where table_schema in ('delivery','fleet','identity','integration','ops')
        and privilege_type = 'DELETE' and grantee not in ('postgres','supabase_admin')`,
    { detail: `select table_schema, table_name, grantee from information_schema.role_table_grants
                where table_schema in ('delivery','fleet','identity','integration','ops')
                  and privilege_type='DELETE' and grantee not in ('postgres','supabase_admin') limit 6` });

  console.log(`\n${C.dim}  the delivery state machine${C.off}`);

  await check("at most one live assignment per delivery",
    `select count(*) n from (
       select delivery_id from fleet.assignment
        where status in ('OFFERED','ACCEPTED') group by delivery_id having count(*) > 1) x`);

  await check("no delivered delivery is missing its timestamp",
    `select count(*) n from delivery.delivery where status='DELIVERED' and delivered_at is null`);

  await check("no delivery was ingested against an unknown hold",
    `select count(*) n from delivery.delivery
      where hold_status='unknown' and status not in ('CANCELLED','DELIVERED','RETURNED')`,
    { level: "warn" });

  await check("no delivery is stuck before assignment",
    `select count(*) n from delivery.delivery
      where status in ('RECEIVED','READY_FOR_ASSIGNMENT')
        and created_at < now() - interval '24 hours'`,
    { level: "warn",
      detail: `select tracking_id, status, created_at from delivery.delivery
                where status in ('RECEIVED','READY_FOR_ASSIGNMENT')
                  and created_at < now() - interval '24 hours' limit 6` });

  console.log(`\n${C.dim}  the outbound queue${C.off}`);

  await check("no dead-lettered outbound event",
    "select count(*) n from integration.outbound_event where status='DEAD'",
    { detail: `select id, target, event, attempts, left(last_error,60) as err
                 from integration.outbound_event where status='DEAD' order by id limit 6` });

  await check("nothing stuck mid-send",
    `select count(*) n from integration.outbound_event
      where status='SENDING' and claimed_at < now() - interval '15 minutes'`);

  await check("no delivery failed to commit to Inventory",
    "select count(*) n from delivery.delivery where commit_status='failed'",
    { detail: `select tracking_id, external_order_id, commit_status, delivered_at
                 from delivery.delivery where commit_status='failed' limit 6` });

  await check("no unresolved delivery exception",
    `select count(*) n from delivery.delivery_exception where resolved_at is null`,
    { level: "warn",
      detail: `select delivery_id, code, created_at from delivery.delivery_exception
                where resolved_at is null limit 6` });

  console.log(`\n${C.dim}  inbound${C.off}`);

  await check("no inbound order was refused and left unreplayed",
    `select count(*) n from integration.inbound_event where status='REJECTED'`,
    { level: "warn",
      detail: `select id, left(coalesce(rejection_code,'—'),40) as why, received_at
                 from integration.inbound_event where status='REJECTED' limit 6` });

  // ══════════════════════════════════════════════════════════════
  banner("3 · GROCERY", "the storefront");
  // ══════════════════════════════════════════════════════════════

  console.log(`\n${C.dim}  order integrity${C.off}`);

  await check("every order has at least one line",
    `select count(*) n from public.orders o
      where not exists (select 1 from public.order_items i where i.order_id = o.id)`,
    { detail: `select id, status, created_at from public.orders o
                where not exists (select 1 from public.order_items i where i.order_id=o.id)
                limit 6` });

  await check("no order line is orphaned",
    `select count(*) n from public.order_items i
      where not exists (select 1 from public.orders o where o.id = i.order_id)`);

  await check("no paid order has a null total",
    `select count(*) n from public.orders
      where status in ('PAID','SHIPPED','DELIVERED') and final_amount is null`);

  await check("every delivery-bound order carries an address and a geocode",
    `select count(*) n from public.orders
      where status in ('PAID','SHIPPED','DELIVERED')
        and (delivery_line1 is null or delivery_lat is null or delivery_lng is null)`,
    { detail: `select id, status, delivery_line1, delivery_lat from public.orders
                where status in ('PAID','SHIPPED','DELIVERED')
                  and (delivery_line1 is null or delivery_lat is null or delivery_lng is null)
                limit 6` });

  console.log(`\n${C.dim}  the logistics handoff${C.off}`);

  await check("no paid order is missing its tracking id",
    `select count(*) n from public.orders
      where status='PAID' and logistics_tracking_id is null
        and created_at < now() - interval '15 minutes'`,
    { detail: `select id, created_at from public.orders
                where status='PAID' and logistics_tracking_id is null
                  and created_at < now() - interval '15 minutes' limit 6` });

  // Phase 1 of the integration plan. Before it, this was every line
  // in the database; a row here now means confirm failed at checkout
  // AND the reconcile sweep has not caught up.
  await check("every live order's stock hold has stopped expiring",
    `select count(*) n from public.order_items i
       join public.orders o on o.id = i.order_id
      where i.reservation_ids is not null
        and i.reservation_confirmed_at is null
        and o.status in ('PAID','SHIPPED')
        and o.created_at < now() - interval '10 minutes'`,
    { detail: `select i.order_id, i.sku, o.status, o.created_at
                 from public.order_items i join public.orders o on o.id=i.order_id
                where i.reservation_ids is not null and i.reservation_confirmed_at is null
                  and o.status in ('PAID','SHIPPED')
                  and o.created_at < now() - interval '10 minutes' limit 6` });

  await check("no status event refers to an order that is gone",
    `select count(*) n from public.logistics_status_event e
      where e.order_id is not null
        and not exists (select 1 from public.orders o where o.id = e.order_id)`);

  await check("no order shows a delivery step without a sequence",
    `select count(*) n from public.orders
      where delivery_step is not null and delivery_status_sequence is null`);

  console.log(`\n${C.dim}  schema${C.off}`);

  await check("service_requests table exists",
    `select case when to_regclass('public.service_requests') is null then 1 else 0 end n`,
    { ok: "(the app writes to it)" });

  await check("every public table has row-level security",
    `select count(*) n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
      where c.relkind='r' and ns.nspname='public' and not c.relrowsecurity`,
    { detail: `select c.relname from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
                where c.relkind='r' and ns.nspname='public' and not c.relrowsecurity` });

  await check("RLS policies are evaluated once, not per row",
    `select count(*) n from pg_policy p
       join pg_class c on c.oid=p.polrelid
       join pg_namespace ns on ns.oid=c.relnamespace
      where ns.nspname='public'
        and (coalesce(pg_get_expr(p.polqual,p.polrelid),'') like '%auth.uid()%'
             and coalesce(pg_get_expr(p.polqual,p.polrelid),'') not like '%SELECT auth.uid()%'
          or coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'') like '%auth.uid()%'
             and coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'') not like '%SELECT auth.uid()%')`,
    { level: "warn",
      detail: `select c.relname||' · '||p.polname as policy from pg_policy p
                 join pg_class c on c.oid=p.polrelid join pg_namespace ns on ns.oid=c.relnamespace
                where ns.nspname='public'
                  and coalesce(pg_get_expr(p.polqual,p.polrelid),'') like '%auth.uid()%'
                  and coalesce(pg_get_expr(p.polqual,p.polrelid),'') not like '%SELECT auth.uid()%'
                limit 8` });

  await check("foreign keys are indexed",
    `select count(*) n from pg_constraint con
       join pg_class cl on cl.oid=con.conrelid
       join pg_namespace ns on ns.oid=cl.relnamespace
      where con.contype='f' and ns.nspname='public'
        and not exists (select 1 from pg_index i
                         where i.indrelid=con.conrelid and i.indkey[0]=con.conkey[1])`,
    { level: "warn",
      detail: `select cl.relname||'.'||a.attname as unindexed_fk from pg_constraint con
                 join pg_class cl on cl.oid=con.conrelid
                 join pg_namespace ns on ns.oid=cl.relnamespace
                 join pg_attribute a on a.attrelid=con.conrelid and a.attnum=con.conkey[1]
                where con.contype='f' and ns.nspname='public'
                  and not exists (select 1 from pg_index i
                                   where i.indrelid=con.conrelid and i.indkey[0]=con.conkey[1])` });

  // ══════════════════════════════════════════════════════════════
  banner("4 · THE ESTATE", "questions no single system can answer");
  // ══════════════════════════════════════════════════════════════

  await check("no paid order is unknown to logistics",
    `select count(*) n from public.orders o
      where o.status='PAID' and o.created_at < now() - interval '15 minutes'
        and not exists (select 1 from delivery.delivery d
                         where d.external_order_id = o.id::text)`,
    { detail: `select id, created_at, final_amount from public.orders o
                where o.status='PAID' and o.created_at < now() - interval '15 minutes'
                  and not exists (select 1 from delivery.delivery d
                                   where d.external_order_id=o.id::text) limit 6` });

  await check("no delivery refers to an order Grocery does not have",
    `select count(*) n from delivery.delivery d
      where d.external_order_id !~ '^verify-probe'
        and not exists (select 1 from public.orders o where o.id::text = d.external_order_id)`,
    { level: "warn",
      detail: `select tracking_id, external_order_id, status from delivery.delivery d
                where d.external_order_id !~ '^verify-probe'
                  and not exists (select 1 from public.orders o where o.id::text=d.external_order_id)
                limit 6` });

  await check("no stock hold is lapsing under a live delivery",
    `select count(*) n from delivery.delivery d
       join stock.reservation r on r.order_ref = d.external_order_id
      where d.status not in ('DELIVERED','CANCELLED','RETURNED')
        and r.status in ('HELD','CONFIRMED')
        and r.expires_at < now() + interval '10 minutes'`,
    { detail: `select d.tracking_id, d.status, r.expires_at from delivery.delivery d
                 join stock.reservation r on r.order_ref = d.external_order_id
                where d.status not in ('DELIVERED','CANCELLED','RETURNED')
                  and r.status in ('HELD','CONFIRMED')
                  and r.expires_at < now() + interval '10 minutes' limit 6` });

  await check("no parcel was delivered without the sale reaching the ledger",
    `select count(*) n from delivery.delivery d
      where d.status='DELIVERED'
        and exists (select 1 from stock.reservation r where r.order_ref=d.external_order_id)
        and not exists (select 1 from stock.reservation r
                         where r.order_ref=d.external_order_id and r.status='CONSUMED')`,
    { detail: `select d.tracking_id, d.external_order_id, d.delivered_at, d.commit_status
                 from delivery.delivery d
                where d.status='DELIVERED'
                  and exists (select 1 from stock.reservation r where r.order_ref=d.external_order_id)
                  and not exists (select 1 from stock.reservation r
                                   where r.order_ref=d.external_order_id and r.status='CONSUMED')
                limit 6` });

  await check("Grocery and Logistics agree on which orders are delivered",
    `select count(*) n from public.orders o
       join delivery.delivery d on d.external_order_id = o.id::text
      where d.status='DELIVERED' and o.status <> 'DELIVERED'
        and d.delivered_at < now() - interval '15 minutes'`,
    { detail: `select o.id, o.status as grocery, d.status as logistics, d.delivered_at
                 from public.orders o join delivery.delivery d on d.external_order_id=o.id::text
                where d.status='DELIVERED' and o.status<>'DELIVERED'
                  and d.delivered_at < now() - interval '15 minutes' limit 6` });

  // ── summary ──
  console.log(`\n${C.bold}${"═".repeat(72)}${C.off}`);
  const verdict = tally.fail > 0 ? `${C.fail}${tally.fail} FAILED${C.off}`
                : tally.warn > 0 ? `${C.warn}${tally.warn} warning(s)${C.off}`
                : `${C.pass}all clear${C.off}`;
  console.log(`  ${C.pass}${tally.pass} passed${C.off}   ${C.warn}${tally.warn} warned${C.off}   ${C.fail}${tally.fail} failed${C.off}   →  ${verdict}`);
  console.log(`${C.bold}${"═".repeat(72)}${C.off}\n`);

  process.exitCode = tally.fail > 0 ? 1 : 0;
} finally {
  await db.end();
}
