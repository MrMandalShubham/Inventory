-- ============================================================
-- 0011 — The stock ledger
--
-- INVARIANT 1: STOCK IS A SUM, NOT A NUMBER.
--
-- Until now stock.balance was a table somebody wrote to. From here
-- it is a projection: every change is an immutable row in this
-- ledger, and the balance is what those rows add up to. Delete the
-- balance table and it can be rebuilt exactly. That is the whole
-- guarantee, and the Phase 2 gate is a test that performs it.
--
-- ── Partitioned from the start, deliberately ──
--
-- At 5,000 products across 5 locations this grows 2–4 million rows a
-- year and never shrinks — invariant 2 means nothing is ever deleted.
-- Partitioning a large table AFTER the fact means an exclusive lock
-- and a full rewrite of the busiest table in the system. Doing it at
-- creation costs one DO block.
-- ============================================================

-- ─────────────────────── reason codes ───────────────────────
--
-- A lookup rather than a CHECK: each reason carries rules about who
-- may use it and whether it needs approval, and those differ.

create table stock.reason (
  code              text primary key,
  label             text not null,
  direction         text not null check (direction in ('IN','OUT','EITHER')),
  -- Roles permitted to post it. Empty means the posting function's
  -- own rule decides (used for system-generated entries).
  allowed_roles     text[] not null default '{}',
  requires_approval boolean not null default false,
  is_wastage        boolean not null default false,
  note              text
);

insert into stock.reason (code, label, direction, allowed_roles, requires_approval, is_wastage, note) values
  ('OPENING',   'Opening balance',      'EITHER', array['planner','admin'],                    false, false, 'Day-one position loaded at go-live'),
  ('RECEIPT',   'Goods received',       'IN',     array['operator','shop_manager','planner','admin'], false, false, 'Arrived from outside the business'),
  ('ISSUE',     'Sold or issued',       'OUT',    array['operator','shop_manager','planner','admin'], false, false, 'Left the business'),
  ('TRANSFER_OUT','Dispatched',         'OUT',    array['operator','shop_manager','planner','admin'], false, false, 'Left this location for another of ours'),
  ('TRANSFER_IN', 'Received in transfer','IN',    array['operator','shop_manager','planner','admin'], false, false, 'Arrived from another of our locations'),
  ('RETURN',    'Returned',             'EITHER', array['operator','shop_manager','planner','admin'], false, false, 'Customer or supplier return'),
  ('WASTAGE',   'Wastage',              'OUT',    array['operator','shop_manager','planner','admin'], false, true,  'Damaged, expired or spoiled — posted daily, never a month-end plug'),
  ('COUNT',     'Count variance',       'EITHER', array['shop_manager','planner','admin'],     true,  false, 'Physical count disagreed with the system'),
  ('ADJUST',    'Manual adjustment',    'EITHER', array['shop_manager','planner','admin'],     true,  false, 'Correction with a named cause and an approver'),
  ('CORRECTION','Reversal',             'EITHER', array['planner','admin'],                    true,  false, 'Compensating entry that cancels an earlier one');

alter table stock.reason enable row level security;
create policy reason_read on stock.reason
  for select using (platform.current_role_name() <> '');

-- ─────────────────────── the ledger ───────────────────────

create table stock.ledger (
  id            bigint generated always as identity,

  product_id    uuid not null references catalog.product(id),
  location_id   uuid not null references platform.location(id),
  batch_id      uuid,          -- set for BATCH-tracked products
  serial_id     uuid,          -- set for SERIAL-tracked products

  qty_delta     integer not null check (qty_delta <> 0),
  -- What the line became. Reading "stock now" is then an index
  -- lookup rather than an aggregate over millions of rows, and every
  -- row carries its own self-check.
  balance_after integer not null check (balance_after >= 0),

  reason_code   text not null references stock.reason(code),
  movement_id   uuid,          -- the Phase 3 ticket that caused it
  note          text,

  unit_cost     bigint,        -- paise; valuation rides with quantity
  total_value   bigint,

  actor_id      uuid not null,
  actor_app_id  uuid,

  -- When it happened, vs when we heard about it. A delivery received
  -- at 6am and entered at 11am is ONE event with TWO timestamps.
  -- Collapsing them makes yesterday's late entry look like today's
  -- activity and corrupts every sell-through figure in Phase 6.
  occurred_at   timestamptz not null default now(),
  recorded_at   timestamptz not null default now(),

  -- Retry safety. A network timeout is indistinguishable from a
  -- failure, so clients retry — and without this the retry takes a
  -- second unit off the shelf.
  idempotency_key text,

  primary key (id, occurred_at)   -- partition key must be in the PK
) partition by range (occurred_at);

comment on table stock.ledger is
  'Append-only. The system of record. stock.balance is derived from this and can be rebuilt from zero.';

-- Monthly partitions across a generous window, plus a DEFAULT so a
-- write can never fail for want of a partition. Created before the
-- default has any rows, which is the only cheap time to do it.
do $$
declare
  d date := date '2025-01-01';
begin
  while d < date '2028-01-01' loop
    execute format(
      'create table stock.ledger_%s partition of stock.ledger for values from (%L) to (%L)',
      to_char(d, 'YYYY_MM'), d, d + interval '1 month');
    d := d + interval '1 month';
  end loop;
  execute 'create table stock.ledger_default partition of stock.ledger default';
end $$;

-- Creates next month's partition. Wire to pg_cron in production;
-- the DEFAULT partition means forgetting is untidy, not fatal.
create or replace function stock.ensure_next_partition()
returns text language plpgsql as $$
-- @no-scope-check: creates a partition and touches no stock data.
declare
  d    date := date_trunc('month', now() + interval '2 months')::date;
  name text := 'ledger_' || to_char(d, 'YYYY_MM');
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'stock' and c.relname = name) then
    return name || ' already exists';
  end if;
  execute format('create table stock.%I partition of stock.ledger for values from (%L) to (%L)',
                 name, d, d + interval '1 month');
  return 'created ' || name;
end $$;

-- ─────────────────── append-only, enforced ───────────────────

create trigger ledger_no_update
  before update on stock.ledger
  for each row execute function platform.refuse_mutation();

create trigger ledger_no_delete
  before delete on stock.ledger
  for each row execute function platform.refuse_mutation();

-- ─────────────────────── indexes ───────────────────────

create index ledger_line_idx    on stock.ledger (product_id, location_id, occurred_at desc, id desc);
create index ledger_location_idx on stock.ledger (location_id, occurred_at desc);
create index ledger_batch_idx   on stock.ledger (batch_id) where batch_id is not null;
create index ledger_serial_idx  on stock.ledger (serial_id) where serial_id is not null;
create index ledger_movement_idx on stock.ledger (movement_id) where movement_id is not null;
create index ledger_reason_idx  on stock.ledger (reason_code, occurred_at desc);

create index ledger_idempotency_lookup
  on stock.ledger (idempotency_key) where idempotency_key is not null;

-- ─────────────────── the idempotency register ───────────────────
--
-- The unique key CANNOT live on the ledger: a unique constraint on a
-- partitioned table must include the partition key, which would make
-- it unique per month rather than globally — and a retry landing a
-- day later would silently take a second unit off the shelf.
--
-- So it lives in its own unpartitioned table. That also separates
-- their lifetimes correctly: the ledger is kept forever, while a
-- retry key only matters for a few hours and can be pruned.

create table stock.idempotency (
  key        text primary key,
  ledger_id  bigint,
  created_at timestamptz not null default now()
);

create index idempotency_age_idx on stock.idempotency (created_at);

alter table stock.idempotency enable row level security;
-- Nobody reads or writes this directly; post_movement() is the only
-- door and it runs as definer.
create policy idempotency_admin on stock.idempotency
  for select using (platform.current_role_name() = 'admin');

-- ─────────────────────── RLS ───────────────────────

alter table stock.ledger enable row level security;

-- Read only, and scoped. Nobody writes the ledger through SQL — the
-- posting function in 0013 is the only door, and it runs as definer.
create policy ledger_read on stock.ledger
  for select using (platform.can_access_location(location_id));
