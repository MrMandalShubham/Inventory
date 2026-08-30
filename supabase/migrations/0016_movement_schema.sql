-- ============================================================
-- 0016 — Movement tickets
--
-- Three kinds of movement, one state machine:
--   IMPORT    goods arrive from outside the business
--   EXPORT    goods leave the business
--   TRANSFER  goods move between our own locations
--
-- ── The decision this migration turns on ──
--
-- INVARIANT 4: GOODS IN TRANSIT BELONG TO NOBODY.
--
-- The obvious implementation is an `in_transit` column on the
-- destination's balance row. It is wrong, for a reason that only
-- shows up later: that column is not derived from the ledger, so
-- rebuild_balances() would wipe it, and the Phase 2 gate would start
-- lying about a number it never rebuilt.
--
-- Instead transit is a real VIRTUAL LOCATION holding real ledger
-- entries. Dispatch moves stock from the source into TRANSIT;
-- receipt moves it from TRANSIT into the destination. It is then
-- sellable from neither end — not because a flag says so, but
-- because it is physically somewhere else in the model — and it
-- rebuilds from the ledger like everything else.
--
-- The 3 units that never arrive are simply still sitting in TRANSIT,
-- visibly, until somebody explains them.
-- ============================================================

create schema if not exists movement;

-- ─────────────────── the transit location ───────────────────

insert into platform.location (code, name, type)
values ('TRANSIT', 'In transit — owned by nobody', 'VIRTUAL');

-- Virtual locations hold no sellable stock and are reachable only
-- through the movement functions, which check the REAL source and
-- destination before they touch transit. Without this, a shop
-- manager could not dispatch their own goods, because the transit
-- leg of their own transfer would be refused.
create or replace function platform.can_access_location(p_location uuid)
returns boolean language sql stable as $$
  select platform.has_global_scope()
      or p_location = any (platform.current_location_ids())
      or exists (select 1 from platform.location
                  where id = p_location and type = 'VIRTUAL')
$$;

-- ─────────── in_transit as a column is now superseded ───────────
--
-- Dropped rather than left at zero: a column that looks like an
-- answer and is never maintained is worse than no column, because
-- somebody will eventually read it.

alter table stock.balance drop column in_transit;

-- ─────────── the rebuild must not destroy claims ───────────
--
-- Phase 2's rebuild deleted every row and reinserted on_hand from
-- the ledger. That was correct while reserved/allocated/damaged were
-- always zero. From Phase 3 rejected goods land in `damaged`, and
-- Phase 4 adds reservations — so the rebuild has to recompute what
-- the ledger owns and preserve what it does not.

create or replace function stock.rebuild_balances()
returns integer
language plpgsql
security definer
set search_path = stock, public, extensions
as $$
-- @no-scope-check: a maintenance operation over the whole projection,
-- restricted to admin below.
declare v_rows integer;
begin
  if platform.current_role_name() <> 'admin' then
    raise exception 'FORBIDDEN_ROLE: only an admin may rebuild the projection'
      using errcode = '42501';
  end if;

  -- on_hand is owned by the ledger. reserved, allocated and damaged
  -- are not, so they survive.
  with truth as (
    select product_id, location_id, batch_id, sum(qty_delta)::integer as on_hand
      from stock.ledger group by 1, 2, 3
  ),
  upserted as (
    insert into stock.balance (product_id, location_id, batch_id, on_hand)
    select product_id, location_id, batch_id, on_hand from truth
    on conflict (product_id, location_id, batch_id) do update
       set on_hand = excluded.on_hand, updated_at = now()
    returning 1
  )
  select count(*)::integer into v_rows from upserted;

  -- Lines the ledger has no opinion about are zeroed, then removed
  -- if nothing else is holding them open.
  update stock.balance b set on_hand = 0
   where not exists (
     select 1 from stock.ledger l
      where l.product_id = b.product_id
        and l.location_id = b.location_id
        and l.batch_id is not distinct from b.batch_id);

  delete from stock.balance
   where on_hand = 0 and reserved = 0 and allocated = 0 and damaged = 0;

  return v_rows;
end $$;

-- ─────────────────────── the ticket ───────────────────────

create table movement.movement (
  id            uuid primary key default gen_random_uuid(),
  ticket_no     text not null unique,

  type          text not null check (type in ('IMPORT','EXPORT','TRANSFER')),

  status        text not null default 'DRAFT' check (status in (
                  'DRAFT','APPROVED','PICKED','DISPATCHED','IN_TRANSIT',
                  'RECEIVED','RECONCILED','DISCREPANCY','RESOLVED',
                  'CLOSED','CANCELLED')),

  source_location_id uuid references platform.location(id),
  dest_location_id   uuid references platform.location(id),
  partner_id         uuid references partner.partner(id),

  note          text,
  expected_at   timestamptz,

  -- Who did what. Every transition is attributable.
  raised_by     uuid not null,
  approved_by   uuid,
  dispatched_by uuid,
  received_by   uuid,
  resolved_by   uuid,

  raised_at     timestamptz not null default now(),
  approved_at   timestamptz,
  dispatched_at timestamptz,
  received_at   timestamptz,
  resolved_at   timestamptz,
  closed_at     timestamptz,

  cancel_reason text,

  -- The three types are genuinely different shapes, and getting this
  -- wrong is how an internal transfer accidentally becomes a sale.
  constraint import_shape check (
    type <> 'IMPORT' or (dest_location_id is not null
                         and source_location_id is null
                         and partner_id is not null)),
  constraint export_shape check (
    type <> 'EXPORT' or (source_location_id is not null
                         and dest_location_id is null
                         and partner_id is not null)),
  constraint transfer_shape check (
    type <> 'TRANSFER' or (source_location_id is not null
                           and dest_location_id is not null
                           and partner_id is null
                           and source_location_id <> dest_location_id)),

  -- Separation of duties: not your own approval.
  constraint approver_is_not_raiser
    check (approved_by is null or approved_by <> raised_by)
);

-- ─────────────────────── the lines ───────────────────────
--
-- Five quantities, because they genuinely differ:
--
--   Ordered 100. The hub dispatched 98 — two were already damaged on
--   the shelf. The shop counted 97 arriving; one lost in transit.
--   Of those, 3 were crushed, so 94 accepted and 3 rejected.
--
-- Every gap has a different owner and a different financial
-- consequence, and one `quantity` column tells you none of it.

create table movement.line (
  id             uuid primary key default gen_random_uuid(),
  movement_id    uuid not null references movement.movement(id) on delete cascade,

  product_id     uuid not null references catalog.product(id),
  batch_id       uuid references stock.batch(id),

  qty_ordered    integer not null check (qty_ordered > 0),
  qty_dispatched integer check (qty_dispatched >= 0),
  qty_received   integer check (qty_received >= 0),
  qty_rejected   integer check (qty_rejected >= 0),

  -- What actually joined usable stock at the destination.
  qty_accepted   integer generated always as (qty_received - coalesce(qty_rejected, 0)) stored,
  -- What left and never arrived.
  qty_lost       integer generated always as (qty_dispatched - coalesce(qty_received, 0)) stored,

  unit_cost      bigint,
  reject_reason  text,
  loss_reason    text,

  constraint rejected_within_received
    check (qty_rejected is null or qty_received is null or qty_rejected <= qty_received),

  unique nulls not distinct (movement_id, product_id, batch_id)
);

create table movement.document (
  id          uuid primary key default gen_random_uuid(),
  movement_id uuid not null references movement.movement(id) on delete cascade,

  -- INVARIANT 8: an internal transfer is not a sale.
  --   TRANSFER → DELIVERY_CHALLAN. No tax, no revenue.
  --   EXPORT   → TAX_INVOICE.
  --   IMPORT   → GRN (goods received note).
  kind        text not null check (kind in
                ('DELIVERY_CHALLAN','TAX_INVOICE','GRN','CREDIT_NOTE')),
  doc_no      text not null unique,

  -- Nullable on a challan by design: a challan carries no tax
  -- because you cannot sell to yourself.
  goods_value_paise bigint,
  tax_paise         bigint,

  -- Fields an e-way bill needs, carried from day one so enabling it
  -- later is an API call rather than a redesign. See docs/08 §6 —
  -- this is an OPEN item, not a solved one.
  transport   jsonb not null default '{}',

  issued_at   timestamptz not null default now(),
  issued_by   uuid not null
);

create index movement_status_idx  on movement.movement (status, raised_at desc);
create index movement_source_idx  on movement.movement (source_location_id, status);
create index movement_dest_idx    on movement.movement (dest_location_id, status);
create index movement_partner_idx on movement.movement (partner_id) where partner_id is not null;
create index line_movement_idx    on movement.line (movement_id);
create index document_movement_idx on movement.document (movement_id);

-- ─────────────────────── RLS ───────────────────────
--
-- A ticket is visible from either end. A shop sees what is coming to
-- it and what it sent, and nothing else.

alter table movement.movement enable row level security;
alter table movement.line     enable row level security;
alter table movement.document enable row level security;

create policy movement_read on movement.movement
  for select using (
    (source_location_id is not null and platform.can_access_location(source_location_id))
    or (dest_location_id is not null and platform.can_access_location(dest_location_id))
  );

create policy line_read on movement.line
  for select using (exists (
    select 1 from movement.movement m where m.id = line.movement_id));

create policy document_read on movement.document
  for select using (exists (
    select 1 from movement.movement m where m.id = document.movement_id));

-- Tickets are written only through the state-machine functions in
-- 0017, which run as definer. No write policies here on purpose.

create trigger movement_audit
  after insert or update or delete on movement.movement
  for each row execute function platform.record_audit();
