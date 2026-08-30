-- ============================================================
-- 0015 — Two holes the CI guards found in 0011–0013
--
-- ── 1. Partitions do not inherit RLS when queried directly ──
--
-- Enabling row-level security on a partitioned parent protects reads
-- that go THROUGH the parent. It does nothing for a query aimed at a
-- partition by name:
--
--     select * from stock.ledger_2026_08;   -- no policy applied
--
-- And 99-grants hands `authenticated` SELECT on every table in the
-- schema, partitions included. So a shop manager who knows the naming
-- convention could read every location's movements. Nothing would
-- error; the rows would simply arrive.
--
-- The rls-coverage check flagged all 37 partitions. It was right.
--
-- ── 2. Delegating a scope check is not the same as making one ──
--
-- record_wastage() and post_adjustment() were SECURITY DEFINER but
-- relied on post_movement() to check location and role. That reads
-- fine today and breaks silently the day someone changes the callee.
--
-- They do not need elevated privilege at all — post_movement has it.
-- Dropping them to SECURITY INVOKER shrinks the definer surface,
-- which is the set of functions where the guard steps aside.
-- ============================================================

-- ─────────── every partition gets the parent's policy ───────────

do $$
declare p record;
begin
  for p in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_inherits i on i.inhrelid = c.oid
      join pg_class parent on parent.oid = i.inhparent
     where n.nspname = 'stock' and parent.relname = 'ledger'
  loop
    execute format('alter table stock.%I enable row level security', p.relname);
    execute format(
      'create policy ledger_read on stock.%I for select using (platform.can_access_location(location_id))',
      p.relname);
  end loop;
end $$;

-- New partitions must arrive protected, not be protected afterwards.
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
  execute format('alter table stock.%I enable row level security', name);
  execute format(
    'create policy ledger_read on stock.%I for select using (platform.can_access_location(location_id))',
    name);

  return 'created ' || name;
end $$;

-- ─────────── shrink the definer surface ───────────

drop function if exists stock.record_wastage(uuid, uuid, integer, text, uuid);
drop function if exists stock.post_adjustment(uuid, uuid, integer, text);

-- SECURITY INVOKER (the default). These are conveniences over
-- post_movement, which is where the guard actually lives.
create or replace function stock.record_wastage(
  p_product uuid, p_location uuid, p_qty integer, p_note text, p_batch uuid default null
) returns bigint
language sql
set search_path = stock, platform, public
as $$
  -- Wastage is posted daily, per location, per category — never
  -- discovered as a month-end plug. F&V runs 8–15% against a 12–25%
  -- margin, so wastage decides whether the category earns anything.
  select stock.post_movement(
    p_product, p_location, -abs(p_qty), 'WASTAGE', p_batch, p_note);
$$;

create or replace function stock.post_adjustment(
  p_product uuid, p_location uuid, p_delta integer, p_reason text
) returns integer
language plpgsql
set search_path = stock, platform, public
as $$
declare v_after integer;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'REASON_REQUIRED: an adjustment without a reason is indistinguishable from theft'
      using errcode = '23514';
  end if;

  -- Location and role are checked inside post_movement, which is the
  -- definer. This function has no elevated privilege of its own.
  perform stock.post_movement(p_product, p_location, p_delta, 'ADJUST', null, p_reason);

  select on_hand into v_after from stock.balance
   where product_id = p_product and location_id = p_location and batch_id is null;
  return v_after;
end $$;

-- ─────────── keep the guard honest about partitions ───────────
--
-- The rls-coverage check counts partitions as tables, which is what
-- caught this. Leave it that way: a future partition created by hand
-- without a policy should fail the build exactly as these did.
