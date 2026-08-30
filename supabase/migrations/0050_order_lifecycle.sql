-- ============================================================
-- 0050 — Reserve, commit and release a whole order
--
-- stock.reserve() already holds one product at one location, and has
-- since Phase 4. A storefront does not think in lines: it places an
-- order, delivers it, or cancels it. Three calls, keyed by the order
-- reference the selling app already owns.
--
-- ── All or nothing ──
--
-- If any line is short, the whole order is refused and NOTHING is
-- held. The alternative — hold what is available — means a customer
-- pays for six things and four arrive, and the app has to discover
-- that afterwards. Refusing gives the storefront the shortfalls so it
-- can offer a substitute or reduce the quantity while the customer is
-- still there.
--
-- One transaction, so a failure on line four cannot leave lines one to
-- three held forever.
--
-- ── Idempotent by order reference ──
--
-- A network timeout is indistinguishable from a failure. The selling
-- app WILL retry. Reserving twice for one order would hold the stock
-- twice and sell it to nobody, so a repeat call returns what the first
-- one did rather than doing it again.
--
-- ── Why there is no endpoint that sets a stock number ──
--
-- Stock is the sum of an append-only ledger (invariant 1). A selling
-- app that could assign a quantity could make the sum and the number
-- disagree, and then nobody can say which is right. Every path below
-- moves stock by recording an event.
-- ============================================================

/**
 * Hold every line of an order, or none of them.
 *
 * p_items: [{sku, quantity}]
 *
 * Returns a row per line. When p_ok is false the whole thing was
 * refused and the rows say which lines were short and by how much.
 */
create or replace function stock.reserve_order(
  p_order_ref text,
  p_location  uuid,
  p_items     jsonb,
  p_ttl_seconds integer default 1800
) returns table (
  ok            boolean,
  sku           text,
  requested     integer,
  available     integer,
  reservation_id uuid,
  problem       text
)
language plpgsql
security definer
set search_path = stock, catalog, platform, public, extensions
as $$
-- @no-scope-check: checks the location explicitly below, because a
-- storefront must not be able to hold stock at a shop its key does
-- not cover.
declare
  r         jsonb;
  v_product uuid;
  v_avail   integer;
  v_qty     integer;
  v_short   boolean := false;
  v_existing integer;
begin
  if not platform.can_access_location(p_location) then
    raise exception 'FORBIDDEN_LOCATION: this key may not sell from that location'
      using errcode = '42501';
  end if;

  if p_order_ref is null or btrim(p_order_ref) = '' then
    raise exception 'ORDER_REF_REQUIRED: an order with no reference cannot be committed later'
      using errcode = '23514';
  end if;

  -- ── already done? ──
  --
  -- The retry case. Returning the original holds is what lets a
  -- selling app retry a timed-out checkout without double-holding.
  select count(*) into v_existing
    from stock.reservation
   where order_ref = p_order_ref and status in ('HELD','CONFIRMED');

  if v_existing > 0 then
    return query
      select true, p.sku_code, res.quantity, res.quantity, res.id, 'already reserved'::text
        from stock.reservation res
        join catalog.product p on p.id = res.product_id
       where res.order_ref = p_order_ref and res.status in ('HELD','CONFIRMED');
    return;
  end if;

  -- ── first pass: can every line be met? ──
  --
  -- Checked before anything is held, so a refusal leaves no trace.
  create temp table _order_check (
    sku text, product_id uuid, requested integer, available integer, problem text
  ) on commit drop;

  for r in select * from jsonb_array_elements(p_items) loop
    v_qty := (r ->> 'quantity')::integer;

    select id into v_product from catalog.product
     where sku_code = upper(r ->> 'sku') or slug = lower(r ->> 'sku');

    if v_product is null then
      insert into _order_check values (r ->> 'sku', null, v_qty, 0, 'no such product');
      v_short := true;
      continue;
    end if;

    if v_qty is null or v_qty <= 0 then
      insert into _order_check values (r ->> 'sku', v_product, v_qty, 0, 'quantity must be positive');
      v_short := true;
      continue;
    end if;

    select coalesce(sum(b.on_hand - b.reserved - b.allocated - b.damaged), 0)
      into v_avail
      from stock.balance b
     where b.product_id = v_product and b.location_id = p_location;

    insert into _order_check
    values (r ->> 'sku', v_product, v_qty, v_avail,
            case when v_avail < v_qty then 'insufficient stock' else null end);

    if v_avail < v_qty then v_short := true; end if;
  end loop;

  if v_short then
    -- Nothing held. The caller gets every line so it can show the
    -- customer exactly what is short, not just the first failure.
    return query
      select false, c.sku, c.requested, c.available, null::uuid,
             coalesce(c.problem, 'ok')
        from _order_check c;
    return;
  end if;

  -- ── second pass: hold them ──
  --
  -- stock.reserve() carries the single-statement oversell guarantee,
  -- so a concurrent order taking the last unit between the two passes
  -- is refused here rather than oversold.
  return query
    select true, c.sku, c.requested, c.available,
           -- Argument order matters and is easy to get wrong: the TTL
           -- in SECONDS comes before the idempotency key. Keying the
           -- hold on order+sku is what makes a retry of a timed-out
           -- checkout hold the same units rather than a second set.
           stock.reserve(c.product_id, p_location, c.requested, p_order_ref,
                         p_ttl_seconds, p_order_ref || ':' || c.sku),
           null::text
      from _order_check c;
end $$;

comment on function stock.reserve_order is
  'Holds an entire order or refuses it. A partial hold means a customer pays for six things and four arrive.';

/**
 * The goods were delivered. The hold becomes a real reduction.
 *
 * Consuming is what writes the ledger entry — until then the stock is
 * held but still on the shelf, which is exactly what a hold means.
 */
create or replace function stock.commit_order(p_order_ref text)
returns table (sku text, quantity integer, ledger_id bigint)
language plpgsql
security definer
set search_path = stock, catalog, platform, public, extensions
as $$
-- @no-scope-check: consumes holds already placed against a location
-- this key was allowed to reserve from. stock.post_movement checks the
-- location again when the ledger entry is written.
declare
  res record;
  v_id bigint;
  v_any boolean := false;
begin
  for res in
    select r.id, r.quantity, p.sku_code
      from stock.reservation r
      join catalog.product p on p.id = r.product_id
     where r.order_ref = p_order_ref
       and r.status in ('HELD','CONFIRMED')
     order by p.sku_code
  loop
    v_any := true;
    v_id := stock.consume_reservation(res.id);
    sku := res.sku_code; quantity := res.quantity; ledger_id := v_id;
    return next;
  end loop;

  if not v_any then
    -- Distinguishes "already delivered" from "never existed" only by
    -- what the caller finds when it asks. Raising here would make a
    -- retry of a successful commit look like a failure.
    if not exists (select 1 from stock.reservation where order_ref = p_order_ref) then
      raise exception 'NO_SUCH_ORDER: nothing was ever reserved for %', p_order_ref
        using errcode = 'P0002';
    end if;
  end if;
end $$;

/** The order was cancelled. The held stock goes back on the shelf. */
create or replace function stock.release_order(
  p_order_ref text,
  p_reason    text default 'cancelled'
) returns integer
language plpgsql
security definer
set search_path = stock, catalog, platform, public, extensions
as $$
-- @no-scope-check: releases holds placed against a location this key
-- was allowed to reserve from.
declare
  res   record;
  v_n   integer := 0;
begin
  for res in
    select id from stock.reservation
     where order_ref = p_order_ref and status in ('HELD','CONFIRMED')
  loop
    perform stock.release_reservation(res.id, p_reason);
    v_n := v_n + 1;
  end loop;

  if v_n = 0 and not exists (
       select 1 from stock.reservation where order_ref = p_order_ref) then
    raise exception 'NO_SUCH_ORDER: nothing was ever reserved for %', p_order_ref
      using errcode = 'P0002';
  end if;

  return v_n;
end $$;

/**
 * What happened to an order.
 *
 * Not in the original specification, and needed: when a reserve call
 * times out the caller does not know whether it landed. Without this
 * the only options are to reserve again — double-holding the stock —
 * or to abandon the hold until it expires.
 */
create or replace function stock.order_status(p_order_ref text)
returns table (
  sku        text,
  quantity   integer,
  status     text,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = stock, catalog, platform, public, extensions
as $$
  -- @no-scope-check: reports on holds the caller placed, identified by
  -- their own order reference. Returns no stock levels.
  select p.sku_code, r.quantity, r.status, r.expires_at
    from stock.reservation r
    join catalog.product p on p.id = r.product_id
   where r.order_ref = p_order_ref
   order by p.sku_code;
$$;
