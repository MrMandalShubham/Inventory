-- ============================================================
-- estate.order_journey — one order, all three systems, one row
--
-- Run once against the shared Supabase project, as the project owner.
-- Safe to re-run.
--
-- ── What this is for ──
--
-- Today, answering "what happened to order 4f2a?" means three
-- separate lookups against three systems that share no identifier a
-- person can carry between them: Grocery knows it as `orders.id`,
-- Inventory as `reservation.order_ref`, Logistics as
-- `delivery.external_order_id`. They are the same uuid wearing three
-- names, and nothing joins them.
--
-- Being in one Postgres is the one thing that makes joining them
-- free. This is the payoff for co-tenancy, and as far as this file
-- goes it is the ONLY one worth taking.
--
-- ── What this deliberately is NOT ──
--
-- Not a way for one system to read another's tables at runtime. The
-- applications keep talking over signed HTTP, because that is what
-- keeps them independently deployable and what enforces scopes,
-- idempotency and rate limits. Nothing in any of the three codebases
-- should ever select from this view.
--
-- It is an OPERATOR's view: for the estate health page, for a support
-- question, and for the reconciliation queries at the bottom that
-- find orders which fell between two systems.
--
-- ── Why the grants are what they are ──
--
-- A view is evaluated with its OWNER's privileges unless created with
-- security_invoker, so this reads all three systems regardless of who
-- selects from it. That makes the grant the whole security boundary:
-- service_role only. `authenticated` is every signed-in Grocery
-- customer and must never hold it — the view joins rider names,
-- delivery addresses and stock positions across every order in the
-- business.
-- ============================================================

create schema if not exists estate;

comment on schema estate is
  'Read-only cross-system views for operators. No application reads from here — the three systems talk over signed HTTP. Service role only.';

revoke all on schema estate from public;

-- Guarded, so this file also runs against a plain Postgres (a local
-- container, a test project) where Supabase's roles do not exist.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema estate from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema estate from authenticated';
  end if;
  -- Without USAGE on the schema, a grant on the view inside it is
  -- unreachable: the select fails with "permission denied for schema
  -- estate", which reads like the view is missing.
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema estate to service_role';
  end if;
end $$;


-- ─────────────────────────────────────────────────────────────
-- The join
--
-- Grocery owns the uuid. Inventory and Logistics both store it as
-- text, so the cast happens once, here, rather than in every query
-- somebody writes at three in the morning.
--
-- LEFT joins throughout, because the interesting rows are the ones
-- where a system is MISSING: an order Inventory never heard of, a
-- paid order with no delivery.
--
-- Inventory is aggregated because a hold is per line and this view is
-- per order — the same collapse `stock.order_status()` does, kept
-- consistent with it on purpose.
-- ─────────────────────────────────────────────────────────────
create or replace view estate.order_journey as
with hold as (
  select
    r.order_ref,
    count(*)                                        as lines,
    min(r.expires_at) filter (where r.status in ('HELD','CONFIRMED'))
                                                    as hold_expires_at,
    count(*) filter (where r.status = 'HELD')       as lines_held,
    count(*) filter (where r.status = 'CONFIRMED')  as lines_confirmed,
    count(*) filter (where r.status = 'CONSUMED')   as lines_consumed,
    count(*) filter (where r.status = 'RELEASED')   as lines_released,
    -- The same one-word answer the storefront API gives, so the view
    -- and the endpoint cannot disagree about what "held" means.
    case
      when count(*) filter (where r.status in ('HELD','CONFIRMED')) > 0 then 'held'
      when count(*) filter (where r.status = 'CONSUMED') > 0           then 'delivered'
      else 'released'
    end as inventory_status
  from stock.reservation r
  where r.order_ref is not null
  group by r.order_ref
)
select
  -- ── identity ──
  o.id                          as order_id,
  d.tracking_id                 as tracking_id,
  o.created_at                  as placed_at,

  -- ── Grocery: the commercial state ──
  o.status                      as grocery_status,
  o.delivery_step               as grocery_pipeline_step,
  o.delivery_status_sequence    as grocery_sequence,
  o.final_amount                as grocery_total,
  o.fulfilment_location_code    as pickup_location,

  -- ── Inventory: the stock ──
  h.inventory_status,
  h.lines,
  h.lines_held,
  h.lines_confirmed,
  h.lines_consumed,
  h.lines_released,
  h.hold_expires_at,

  -- ── Logistics: the parcel ──
  d.status                      as delivery_status,
  d.hold_status                 as delivery_hold_view,
  d.hold_confirmed,
  d.commit_status,
  d.release_status,
  d.delivered_at,
  d.failed_reason_code,

  -- ── the three questions an operator actually asks ──
  --
  -- Each is a fact the three systems can only answer together, which
  -- is the entire reason this view exists.

  -- 1. Is this order lost between Grocery and Logistics?
  (o.status = 'PAID'
   and o.logistics_tracking_id is null
   and d.id is null)                                as never_reached_logistics,

  -- 2. Is a hold about to lapse under a live delivery?
  --    Until something calls confirm, this is every slow delivery in
  --    the estate — see integration plan G1.
  (h.inventory_status = 'held'
   and h.hold_expires_at is not null
   and h.hold_expires_at < now() + interval '10 minutes'
   and d.status is not null
   and d.status not in ('DELIVERED','CANCELLED','RETURNED'))
                                                    as hold_expiring_under_delivery,

  -- 3. Did the parcel leave without the ledger being told?
  --    The discrepancy that costs real money: stock physically gone,
  --    never recorded as sold.
  (d.status = 'DELIVERED'
   and h.inventory_status is distinct from 'delivered')
                                                    as delivered_but_not_committed

from public.orders o
left join hold h on h.order_ref = o.id::text
left join delivery.delivery d on d.external_order_id = o.id::text;

comment on view estate.order_journey is
  'One row per Grocery order, joined to its Inventory hold and its Logistics delivery. Operators and the estate health page only — no application code reads this.';

-- The boundary. Everything above runs with the owner's rights, so
-- this grant is the only thing deciding who sees it.
revoke all on estate.order_journey from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on estate.order_journey from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on estate.order_journey from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select on estate.order_journey to service_role';
  end if;
end $$;


-- ─────────────────────────────────────────────────────────────
-- The reconciliation queries
--
-- These are the point. Each returns nothing when the estate is
-- healthy, and each is currently unanswerable without this view.
--
-- Run them from the estate health page, or on a schedule, or by hand
-- when something looks wrong.
-- ─────────────────────────────────────────────────────────────

-- 1. Paid, stock held, and Logistics has never heard of it.
--    `republishMissedOrders` exists to fix exactly this and has no way
--    to confirm it worked, because it cannot see Logistics.
--
--   select order_id, placed_at, grocery_total, inventory_status
--     from estate.order_journey
--    where never_reached_logistics
--      and placed_at < now() - interval '5 minutes'
--    order by placed_at;

-- 2. A rider is carrying a parcel whose stock hold is about to lapse.
--    Today this is the normal state of every delivery over half an
--    hour old. After integration-plan Phase 1 it should be empty, and
--    a row here means confirm failed rather than that nobody calls it.
--
--   select order_id, tracking_id, delivery_status, hold_expires_at
--     from estate.order_journey
--    where hold_expiring_under_delivery
--    order by hold_expires_at;

-- 3. Delivered, and the ledger does not know.
--    The one worth a pager. Logistics raises INVENTORY_HOLD_LOST for
--    the cases it can see; this catches the ones where the commit was
--    never enqueued at all.
--
--   select order_id, tracking_id, delivered_at, commit_status,
--          inventory_status
--     from estate.order_journey
--    where delivered_but_not_committed
--      and delivered_at < now() - interval '15 minutes'
--    order by delivered_at;

-- 4. The whole journey of one order, for a support question.
--
--   select * from estate.order_journey where order_id = '…';
