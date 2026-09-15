-- ============================================================
-- Estate database audit
--
-- Read-only. Paste into the Supabase SQL editor of the project that
-- hosts Grocery (public), Inventory Core (8 schemas) and Logistics
-- Core (5 schemas), and run it a section at a time.
--
-- Nothing here writes, locks or drops. Every query either returns
-- rows that are a problem, or returns nothing — "no rows" is the
-- passing result for sections 2 through 6.
--
-- ── What it is looking for ──
--
-- Three systems sharing one Postgres have failure modes none of them
-- has alone. The dangerous ones are not collisions — the 13 schemas
-- are disjoint — but the two roles they all share: `authenticated`
-- and `anon`. On a standalone Postgres `authenticated` is a role the
-- application creates and only its own server ever becomes. On
-- Supabase it is the role every signed-in browser gets. A grant
-- written under the first assumption behaves very differently under
-- the second.
-- ============================================================


-- ─────────────────────────────────────────────────────────────
-- 0. What is actually installed
--
-- Expect 14 schemas: public (Grocery); alerting, catalog, insight,
-- ledger, movement, partner, platform, stock (Inventory); delivery,
-- fleet, identity, integration, ops (Logistics).
--
-- Anything else sharing this project is a fourth tenant nobody
-- planned for.
-- ─────────────────────────────────────────────────────────────
select
  n.nspname as schema,
  case n.nspname
    when 'public' then 'Grocery'
    when 'alerting' then 'Inventory' when 'catalog' then 'Inventory'
    when 'insight'  then 'Inventory' when 'ledger'  then 'Inventory'
    when 'movement' then 'Inventory' when 'partner' then 'Inventory'
    when 'platform' then 'Inventory' when 'stock'   then 'Inventory'
    when 'delivery' then 'Logistics' when 'fleet'   then 'Logistics'
    when 'identity' then 'Logistics' when 'integration' then 'Logistics'
    when 'ops'      then 'Logistics'
    else '*** UNRECOGNISED ***'
  end as owner_system,
  count(c.oid) filter (where c.relkind = 'r') as tables,
  pg_size_pretty(coalesce(sum(pg_total_relation_size(c.oid)), 0)) as total_size
from pg_namespace n
left join pg_class c on c.relnamespace = n.oid and c.relkind = 'r'
where n.nspname not in ('pg_catalog','information_schema','pg_toast',
                        'extensions','graphql','graphql_public','vault',
                        'auth','storage','realtime','supabase_migrations',
                        'supabase_functions','net','cron','pgsodium',
                        'pgsodium_masks','_realtime','_analytics')
  and n.nspname not like 'pg_temp%'
  and n.nspname not like 'pg_toast%'
group by n.nspname
order by owner_system, n.nspname;


-- ─────────────────────────────────────────────────────────────
-- 1. Foreign keys with no index on the referencing side
--
-- Postgres indexes the REFERENCED column (it must be unique) and
-- never the referencing one. Every row returned is a join or a
-- cascade delete doing a sequential scan.
--
-- Grocery migration 003 fixes every row this returns for `public`.
-- Inventory 0053 fixes catalog.product.category_id. Anything else is
-- new.
-- ─────────────────────────────────────────────────────────────
select
  n.nspname   as schema,
  cl.relname  as table_name,
  con.conname as fk_constraint,
  a.attname   as leading_column,
  pg_size_pretty(pg_total_relation_size(cl.oid)) as table_size
from pg_constraint con
join pg_class     cl on cl.oid = con.conrelid
join pg_namespace n  on n.oid  = cl.relnamespace
join pg_attribute a  on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
where con.contype = 'f'
  and n.nspname in ('public','alerting','catalog','insight','ledger','movement',
                    'partner','platform','stock','delivery','fleet','identity',
                    'integration','ops')
  and not exists (
    select 1 from pg_index i
     where i.indrelid = con.conrelid
       and i.indkey[0] = con.conkey[1]
  )
order by pg_total_relation_size(cl.oid) desc, n.nspname, cl.relname;


-- ─────────────────────────────────────────────────────────────
-- 2. Tables with row-level security ON and no policy at all
--
-- The quietest failure in the estate. With RLS enabled and no policy,
-- every query returns zero rows and no error — indistinguishable from
-- an empty table. Logistics' db:verify asserts against this; nothing
-- checks it across all three at once.
--
-- public.logistics_status_event is EXPECTED here and is correct: it
-- is service-role only by design, and the service role bypasses RLS.
-- Anything else wants explaining.
-- ─────────────────────────────────────────────────────────────
select n.nspname as schema, c.relname as table_name
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r'
  and c.relrowsecurity
  and n.nspname in ('public','alerting','catalog','insight','ledger','movement',
                    'partner','platform','stock','delivery','fleet','identity',
                    'integration','ops')
  and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
order by 1, 2;


-- ─────────────────────────────────────────────────────────────
-- 3. Tables with NO row-level security, that a browser role can read
--
-- This is the one that matters most in a shared project. A table with
-- no RLS plus a grant to `authenticated` or `anon` is readable by any
-- signed-in Grocery customer the moment its schema is exposed to
-- PostgREST.
--
-- Every row returned is either a deliberate public lookup table or a
-- leak. There is no third option, so decide about each one.
-- ─────────────────────────────────────────────────────────────
select
  n.nspname as schema,
  c.relname as table_name,
  string_agg(distinct g.grantee, ', ' order by g.grantee) as granted_to
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join information_schema.role_table_grants g
  on g.table_schema = n.nspname and g.table_name = c.relname
where c.relkind = 'r'
  and not c.relrowsecurity
  and g.grantee in ('anon','authenticated')
  and n.nspname in ('public','alerting','catalog','insight','ledger','movement',
                    'partner','platform','stock','delivery','fleet','identity',
                    'integration','ops')
group by 1, 2
order by 1, 2;


-- ─────────────────────────────────────────────────────────────
-- 4. Row-level security that re-runs auth.uid() for every row
--
-- `USING (auth.uid() = user_id)` calls the function once per row
-- examined. `USING ((select auth.uid()) = user_id)` is an InitPlan —
-- once per statement, same answer.
--
-- Grocery migration 003 rewrites every policy this returns for
-- `public`. Inventory and Logistics do not use auth.uid() — they set
-- their own claims — so rows from those schemas would be a surprise.
-- ─────────────────────────────────────────────────────────────
select
  n.nspname as schema,
  c.relname as table_name,
  p.polname as policy,
  pg_get_expr(p.polqual, p.polrelid) as using_expression
from pg_policy p
join pg_class c     on c.oid = p.polrelid
join pg_namespace n on n.oid = c.relnamespace
where pg_get_expr(p.polqual, p.polrelid) like '%auth.uid()%'
  and pg_get_expr(p.polqual, p.polrelid) not like '%SELECT auth.uid()%'
order by 1, 2, 3;


-- ─────────────────────────────────────────────────────────────
-- 5. What a signed-in browser user is granted OUTSIDE its own system
--
-- Logistics grants `authenticated` select/insert/update across
-- delivery, fleet, identity, integration and ops. That was correct
-- when it owned its database: the role was NOLOGIN and only its own
-- HTTP layer ever became it. In a shared Supabase project it is the
-- role every Grocery customer carries.
--
-- Logistics migration 0014 (ops.is_logistics_actor) closed the two
-- write paths this exposed, and RLS holds on reads. The grants are
-- still broad, so this section is about knowing the blast radius
-- rather than about an open hole.
--
-- The real gate is section 6: an unexposed schema is unreachable from
-- a browser regardless of grants.
-- ─────────────────────────────────────────────────────────────
select
  g.table_schema as schema,
  count(distinct g.table_name) as tables_granted,
  string_agg(distinct g.privilege_type, ', ' order by g.privilege_type) as privileges
from information_schema.role_table_grants g
where g.grantee = 'authenticated'
  and g.table_schema in ('alerting','catalog','insight','ledger','movement',
                         'partner','platform','stock','delivery','fleet',
                         'identity','integration','ops')
group by 1
order by 1;


-- ─────────────────────────────────────────────────────────────
-- 6. Which schemas PostgREST will serve to a browser
--
-- THE control that matters. Grocery's browser talks to PostgREST;
-- Inventory and Logistics talk to Postgres directly over the pooler.
-- So Inventory's and Logistics' schemas should NOT appear here.
--
-- Expect something like: public, graphql_public.
-- If `stock`, `delivery`, `identity` or `integration` appear, every
-- grant in section 5 becomes reachable from a customer's browser —
-- fix that before anything else in this file.
--
-- This reads the setting off the `authenticator` role. If it comes
-- back empty the setting lives in the dashboard instead:
--   Project Settings → API → Exposed schemas.
-- ─────────────────────────────────────────────────────────────
select rolname, unnest(rolconfig) as setting
from pg_roles
where rolname in ('authenticator','anon','authenticated')
  and rolconfig is not null;


-- ─────────────────────────────────────────────────────────────
-- 7. Where the space and the reads are going
--
-- seq_scan high with a large table is the signature of a missing
-- index. Compare against section 1.
--
-- n_dead_tup climbing on the event and audit tables is the retention
-- problem: logistics has a retention job, Grocery has none, so
-- public.logistics_status_event grows forever.
-- ─────────────────────────────────────────────────────────────
select
  schemaname as schema,
  relname    as table_name,
  n_live_tup as live_rows,
  n_dead_tup as dead_rows,
  seq_scan,
  idx_scan,
  case when seq_scan + coalesce(idx_scan, 0) = 0 then null
       else round(100.0 * seq_scan / (seq_scan + coalesce(idx_scan, 0)), 1)
  end as pct_seq_scans,
  pg_size_pretty(pg_total_relation_size(relid)) as total_size
from pg_stat_user_tables
where schemaname in ('public','alerting','catalog','insight','ledger','movement',
                     'partner','platform','stock','delivery','fleet','identity',
                     'integration','ops')
  and n_live_tup > 0
order by pg_total_relation_size(relid) desc
limit 40;


-- ─────────────────────────────────────────────────────────────
-- 8. Connection budget
--
-- Three applications now share one project's connection limit.
-- Inventory caps its pool at 3 on Vercel and 20 elsewhere; Logistics
-- defaults to PG_POOL_MAX=8 with no serverless awareness, so every
-- warm lambda holds up to eight. Grocery uses PostgREST and holds
-- none of its own.
--
-- If `used` approaches `max_connections`, move both direct-connection
-- apps to the transaction pooler on port 6543 and drop their pool
-- sizes — NOT db.<ref>.supabase.co:5432, which is IPv6-only and does
-- not resolve from a serverless function at all.
-- ─────────────────────────────────────────────────────────────
select
  (select setting::int from pg_settings where name = 'max_connections') as max_connections,
  (select count(*) from pg_stat_activity)                               as used,
  (select count(*) from pg_stat_activity where state = 'idle')          as idle,
  (select count(*) from pg_stat_activity
    where state = 'idle in transaction')                                as idle_in_transaction;

-- Who is holding them.
select
  coalesce(usename, '(none)') as db_user,
  coalesce(application_name, '(unset)') as application_name,
  state,
  count(*) as connections
from pg_stat_activity
group by 1, 2, 3
order by connections desc;
