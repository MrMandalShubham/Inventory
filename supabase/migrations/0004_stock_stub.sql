-- ============================================================
-- 0004 — Stock, minimal
--
-- Phase 0 builds only enough of the stock schema to prove the
-- isolation model against something real. Phase 2 builds the
-- append-only ledger and makes this table a projection of it.
--
-- What IS final here: the constraints. Invariant 7 says negative
-- stock is a database constraint, not a validation — application
-- guards race, a CHECK does not. These ship now and never move.
-- ============================================================

create schema if not exists stock;

create table stock.balance (
  id          uuid primary key default gen_random_uuid(),

  product_id  uuid not null,          -- catalog.product arrives in Phase 1
  location_id uuid not null references platform.location(id),

  on_hand     integer not null default 0,
  reserved    integer not null default 0,   -- held by a checkout in progress
  allocated   integer not null default 0,   -- promised to a named customer
  in_transit  integer not null default 0,   -- left the source, not yet received
  damaged     integer not null default 0,   -- present but not sellable

  -- What may actually be sold. Generated, so it cannot drift.
  available   integer generated always as
                (on_hand - reserved - allocated - damaged) stored,

  updated_at  timestamptz not null default now(),

  unique (product_id, location_id),

  -- Invariant 7, mechanised. No bug in any application, present or
  -- future, in any language, can breach these.
  constraint on_hand_non_negative     check (on_hand    >= 0),
  constraint reserved_non_negative    check (reserved   >= 0),
  constraint allocated_non_negative   check (allocated  >= 0),
  constraint in_transit_non_negative  check (in_transit >= 0),
  constraint damaged_non_negative     check (damaged    >= 0),

  -- The oversell condition. Everything held must actually exist.
  constraint claims_within_stock
    check (reserved + allocated + damaged <= on_hand)
);

create index balance_location_idx on stock.balance (location_id, product_id);
create index balance_product_idx  on stock.balance (product_id);

comment on table stock.balance is
  'Phase 0 stub. In Phase 2 this becomes a projection of stock.ledger, rebuildable from zero.';

-- ─────────────────────────── RLS ───────────────────────────
--
-- The location boundary, expressed once. A shop sees its own stock;
-- planner, finance and admin see everything.

alter table stock.balance enable row level security;

create policy balance_location_read on stock.balance
  for select using (platform.can_access_location(location_id));

create policy balance_location_write on stock.balance
  for all
  using      (platform.can_access_location(location_id))
  with check (platform.can_access_location(location_id));
