-- ============================================================
-- 0012 — Batches, serials, and the balance becomes a projection
--
-- Three levels of tracking, chosen per product (docs/09 §8):
--   NONE   — count only
--   BATCH  — which lot, and when it expires. Enables oldest-first
--            picking and lets a bad lot be traced to its buyers.
--   SERIAL — every individual unit, with its own history.
--
-- Also: stock.balance stops being writable. Its INSERT/UPDATE/DELETE
-- policies are dropped, so the ONLY way stock changes is through the
-- posting function in 0013. Invariant 1 becomes structural rather
-- than a rule people are asked to remember.
-- ============================================================

-- ─────────────────────────── batches ───────────────────────────

create table stock.batch (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references catalog.product(id),

  lot_no      text not null,     -- the code printed on the pack
  mfg_date    date,
  expiry_date date,

  -- ACTIVE | RECALLED | DEPLETED
  status      text not null default 'ACTIVE'
              check (status in ('ACTIVE','RECALLED','DEPLETED')),

  created_at  timestamptz not null default now(),

  -- The same lot arriving twice is the same lot. Two rows for it
  -- would split a recall in half.
  unique (product_id, lot_no),

  constraint batch_dates_ordered
    check (mfg_date is null or expiry_date is null or expiry_date >= mfg_date)
);

-- Oldest-expiry-first picking reads this on every picking list.
create index batch_fefo_idx on stock.batch (product_id, status, expiry_date nulls last);
create index batch_expiry_idx on stock.batch (expiry_date) where expiry_date is not null;

-- ─────────────────────────── serials ───────────────────────────

create table stock.serial (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references catalog.product(id),
  serial_no   text not null,

  batch_id    uuid references stock.batch(id),
  -- Where this exact unit is now. Null once it has left the business.
  location_id uuid references platform.location(id),

  status      text not null default 'IN_STOCK'
              check (status in ('IN_STOCK','IN_TRANSIT','SOLD','SCRAPPED','RETURNED')),

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (product_id, serial_no)
);

create index serial_location_idx on stock.serial (location_id, status);
create index serial_lookup_idx   on stock.serial (serial_no);

-- ──────────────── balance gains a batch dimension ────────────────

alter table stock.balance
  add column batch_id uuid references stock.batch(id);

-- One line per product × location × batch. NULLS NOT DISTINCT so an
-- untracked product (batch_id null) still gets exactly one line
-- rather than an unlimited number of them.
alter table stock.balance drop constraint balance_product_id_location_id_key;

alter table stock.balance
  add constraint balance_line_unique
  unique nulls not distinct (product_id, location_id, batch_id);

create index balance_batch_idx on stock.balance (batch_id) where batch_id is not null;

-- ──────────── the balance stops being writable by hand ────────────
--
-- This is the structural half of invariant 1. With no write policy,
-- row-level security refuses every INSERT, UPDATE and DELETE from
-- `authenticated`. The posting function runs as definer and bypasses
-- RLS — so it becomes the single door, not by convention but because
-- there is no other way in.

drop policy balance_location_write on stock.balance;
drop policy balance_location_read  on stock.balance;

create policy balance_read_only on stock.balance
  for select using (platform.can_access_location(location_id));

comment on table stock.balance is
  'Derived projection of stock.ledger. Read-only to clients; written only by stock.post_movement(). Rebuildable from zero — see stock.rebuild_balances().';

-- ─────────────────────────── RLS ───────────────────────────

alter table stock.batch  enable row level security;
alter table stock.serial enable row level security;

-- Batches are product-level facts, like the catalogue: everyone
-- signed in may read them, because an operator receiving goods needs
-- to record which lot arrived.
create policy batch_read on stock.batch
  for select using (platform.current_role_name() <> '');

create policy batch_write on stock.batch
  for all using (platform.current_role_name() in ('operator','shop_manager','planner','admin'))
  with check (platform.current_role_name() in ('operator','shop_manager','planner','admin'));

-- Serials ARE location-scoped: a serial is a physical unit sitting
-- somewhere. Units that have left the business (location null) stay
-- visible for warranty and traceability.
create policy serial_read on stock.serial
  for select using (location_id is null or platform.can_access_location(location_id));

create policy serial_write on stock.serial
  for all using (location_id is null or platform.can_access_location(location_id))
  with check (location_id is null or platform.can_access_location(location_id));
