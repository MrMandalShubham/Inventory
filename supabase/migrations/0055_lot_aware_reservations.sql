-- ============================================================
-- 0055 — Reservations that know which lot they hold
--
-- ** Apply together with 0054. Neither is safe alone. **
--
-- 0054 moves the on-hand of 88 lot-tracked products out of the
-- batch-less balance row and into an opening lot. Every function that
-- touches a hold currently ends its WHERE clause with
--
--   and batch_id is null
--
-- so after 0054 alone they would all be looking at a row holding
-- zero. The 86 perishables would stop failing at commit and start
-- failing at checkout with INSUFFICIENT_STOCK — worse, not better.
-- This migration is the other half.
--
-- ── The four places a hold moves ──
--
--   reserve                      takes the hold
--   consume_reservation          releases it, then posts the ISSUE
--   release_reservation          gives it back
--   sweep_expired_reservations   gives it back when the TTL lapses
--
-- Each is rewritten to act on the balance row the reservation
-- actually belongs to — `batch_id is not distinct from …` rather than
-- `batch_id is null`. `is not distinct from` because null is a real
-- value here: it is the row an untracked product lives in.
--
-- Getting one of these wrong and not the others is how stock leaks:
-- a hold taken against the lot row and released against the
-- batch-less row would decrement a counter that was never
-- incremented, and `reserved_non_negative` would fail on some
-- unrelated request hours later.
--
-- ── FEFO ──
--
-- reserve_order now allocates across lots in expiry order, oldest
-- first, so the stock that will spoil soonest is sold first. That is
-- the whole reason a grocery tracks lots.
--
-- A line may therefore produce MORE THAN ONE reservation — 10 units
-- taken as 4 from a lot expiring Friday and 6 from one expiring
-- Monday — and the function returns one row per reservation, with the
-- sku repeated. After 0054 every product has exactly one lot, so
-- nothing splits today. It will the first time receiving creates a
-- second lot, and **the storefront is not ready for that**: Grocery
-- maps the response into `holdBySku`, one reservation id per sku, and
-- `order_items.reservation_id` is a single uuid column. See the note
-- at the foot of this file.
--
-- ── The oversell guarantee is unchanged ──
--
-- Still one statement per lot, still with the availability test in
-- the WHERE clause. Two hundred concurrent callers against a hundred
-- units still produce exactly a hundred winners; they are now merely
-- counted per lot rather than per line.
-- ============================================================


-- ─────────────────────────────────────────────────────────────
-- 1. reserve() — against a named lot
--
-- Rule 7: adding an argument does not replace a function, it creates
-- a second one, and every existing 6-argument call would then be
-- ambiguous against the new 7-argument form with its default. The old
-- signature is dropped explicitly, in this migration, before the new
-- one is created.
-- ─────────────────────────────────────────────────────────────

drop function if exists stock.reserve(uuid, uuid, integer, text, integer, text);

create or replace function stock.reserve(
  p_product uuid,
  p_location uuid,
  p_qty integer,
  p_order_ref text default null,
  p_ttl_seconds integer default 900,
  p_idempotency_key text default null,
  p_batch uuid default null)
returns uuid
language plpgsql
security definer
set search_path to 'stock', 'catalog', 'platform', 'public', 'extensions'
as $function$
declare
  v_id        uuid;
  v_existing  uuid;
  v_available integer;
begin
  if not platform.can_access_location(p_location) then
    raise exception 'FORBIDDEN_LOCATION: caller may not reserve at that location'
      using errcode = '42501';
  end if;

  if p_qty is null or p_qty <= 0 then
    raise exception 'BAD_QUANTITY: a reservation of % is not a reservation', p_qty
      using errcode = '23514';
  end if;

  -- A retry returns the original reservation and moves nothing.
  if p_idempotency_key is not null then
    select id into v_existing from stock.reservation
     where idempotency_key = p_idempotency_key;
    if found then return v_existing; end if;
  end if;

  -- ── THE GUARANTEE ──
  -- One statement. The availability test is in the WHERE clause, so
  -- Postgres evaluates and updates atomically. Two hundred concurrent
  -- callers against a hundred units produce exactly a hundred winners.
  update stock.balance
     set reserved = reserved + p_qty,
         updated_at = now()
   where product_id = p_product
     and location_id = p_location
     and batch_id is not distinct from p_batch
     and on_hand - reserved - allocated - damaged >= p_qty;

  if not found then
    select coalesce(on_hand - reserved - allocated - damaged, 0) into v_available
      from stock.balance
     where product_id = p_product and location_id = p_location
       and batch_id is not distinct from p_batch;

    raise exception 'INSUFFICIENT_STOCK: % requested, % available%', p_qty,
      coalesce(v_available, 0),
      case when p_batch is null then '' else ' in that lot' end
      using errcode = '23514';
  end if;

  insert into stock.reservation
    (product_id, location_id, batch_id, quantity, order_ref, idempotency_key, expires_at)
  values
    (p_product, p_location, p_batch, p_qty, p_order_ref, p_idempotency_key,
     now() + make_interval(secs => greatest(p_ttl_seconds, 30)))
  returning id into v_id;

  return v_id;
end $function$;


-- ─────────────────────────────────────────────────────────────
-- 2. consume_reservation() — release from the row it was taken from
-- ─────────────────────────────────────────────────────────────

create or replace function stock.consume_reservation(p_id uuid)
returns bigint
language plpgsql
security definer
set search_path to 'stock', 'platform', 'public', 'extensions'
as $function$
declare
  r      stock.reservation%rowtype;
  v_led  bigint;
begin
  select * into r from stock.reservation where id = p_id;
  if not found then raise exception 'NO_SUCH_RESERVATION' using errcode = 'P0002'; end if;

  if not platform.can_access_location(r.location_id) then
    raise exception 'FORBIDDEN_LOCATION' using errcode = '42501';
  end if;

  if r.status = 'CONSUMED' then
    return (select id from stock.ledger
             where product_id = r.product_id and location_id = r.location_id
               and note = 'reservation ' || r.id::text limit 1);
  end if;

  if r.status not in ('HELD','CONFIRMED') then
    raise exception 'WRONG_STATUS: reservation is %, cannot consume', r.status
      using errcode = '23514';
  end if;

  -- Release the hold FIRST, then post. The other order breaks
  -- claims_within_stock whenever a line is fully reserved: posting
  -- would drop on_hand to zero while reserved still held the lot.
  --
  -- 0055: from the lot the hold was taken against, not from the
  -- batch-less row. Releasing the wrong row decrements a counter that
  -- was never incremented.
  update stock.balance
     set reserved = reserved - r.quantity, updated_at = now()
   where product_id = r.product_id and location_id = r.location_id
     and batch_id is not distinct from r.batch_id;

  v_led := stock.post_movement(
    r.product_id, r.location_id, -r.quantity, 'ISSUE', r.batch_id,
    'reservation ' || r.id::text);

  update stock.reservation
     set status = 'CONSUMED', consumed_at = now(), updated_at = now()
   where id = p_id;

  return v_led;
end $function$;


-- ─────────────────────────────────────────────────────────────
-- 3 and 4. release_reservation() and the expiry sweep
--
-- Same one-line correction, patched in place so the rest of each
-- function — the status guards, the audit, the return shape — is
-- whatever the latest migration made it, not whatever this file
-- happened to be written against.
-- ─────────────────────────────────────────────────────────────

do $$
declare
  fn   text;
  src  text;
  fixed text;
  n    integer;
begin
  foreach fn in array array['release_reservation', 'sweep_expired_reservations'] loop
    select pg_get_functiondef(p.oid) into src
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'stock' and p.proname = fn;

    if src is null then
      raise exception 'MISSING_FUNCTION: stock.% is not there to patch', fn;
    end if;

    fixed := replace(
      src,
      'where product_id = r.product_id and location_id = r.location_id and batch_id is null',
      'where product_id = r.product_id and location_id = r.location_id'
        || ' and batch_id is not distinct from r.batch_id');

    if fixed = src then
      raise exception
        'PATCH_MISSED: stock.% no longer contains the batch_id-is-null clause this '
        'migration expects. It has been changed since 0055 was written — re-read it '
        'and make the lot correction by hand rather than leaving a hold that is '
        'taken from one row and returned to another.', fn;
    end if;

    execute fixed;
    raise notice '0055: made stock.% lot-aware', fn;
  end loop;
end $$;


-- ─────────────────────────────────────────────────────────────
-- 5. reserve_order() — allocate FEFO across lots
-- ─────────────────────────────────────────────────────────────

create or replace function stock.reserve_order(
  p_order_ref text,
  p_location uuid,
  p_items jsonb,
  p_ttl_seconds integer default 1800)
returns table (ok boolean, sku text, requested integer, available integer,
               reservation_id uuid, problem text)
language plpgsql
security definer
set search_path to 'stock', 'catalog', 'platform', 'public', 'extensions'
as $function$
-- @no-scope-check: checks the location explicitly below, because a
-- storefront must not be able to hold stock at a shop its key does
-- not cover.
declare
  r          jsonb;
  v_product  uuid;
  v_avail    integer;
  v_qty      integer;
  v_short    boolean := false;
  v_existing integer;
  v_tracking text;
  chk        record;
  lot        record;
  v_left     integer;
  v_take     integer;
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
  -- `on commit drop` means this survives until the transaction ends,
  -- so a SECOND call to reserve_order in the same transaction used to
  -- fail with "relation _order_check already exists". Each API request
  -- is its own transaction, which is why nobody ever hit it — but a
  -- caller batching two orders would, and the error names nothing
  -- useful. Pre-existing; fixed here because this migration is
  -- rewriting the function anyway.
  drop table if exists _order_check;
  create temp table _order_check (
    sku text, product_id uuid, requested integer, available integer, problem text
  ) on commit drop;

  for r in select * from jsonb_array_elements(p_items) loop
    v_qty := (r ->> 'quantity')::integer;

    select id, tracking_mode into v_product, v_tracking
      from catalog.product
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

    -- What can genuinely be sold, which for a lot-tracked product
    -- means what sits in an identified lot. Stock in a batch-less row
    -- for such a product is real on the shelf and unsellable through
    -- this system, because post_movement will not issue it without a
    -- lot to name — so it must not be promised to a customer.
    select coalesce(sum(b.on_hand - b.reserved - b.allocated - b.damaged), 0)
      into v_avail
      from stock.balance b
     where b.product_id = v_product
       and b.location_id = p_location
       and (v_tracking = 'NONE' or b.batch_id is not null);

    insert into _order_check
    values (r ->> 'sku', v_product, v_qty, v_avail,
            case when v_avail < v_qty then
              case when v_tracking = 'NONE' then 'insufficient stock'
                   else 'insufficient stock in any identified lot' end
            end);

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

  -- ── second pass: hold them, oldest lot first ──
  for chk in select * from _order_check loop
    select tracking_mode into v_tracking from catalog.product where id = chk.product_id;

    if v_tracking = 'NONE' then
      -- One row, no lot. Same idempotency key as before 0055, so a
      -- retry of a checkout that was in flight across the upgrade
      -- still matches.
      ok := true; sku := chk.sku; requested := chk.requested;
      available := chk.available; problem := null;
      reservation_id := stock.reserve(
        chk.product_id, p_location, chk.requested, p_order_ref,
        p_ttl_seconds, p_order_ref || ':' || chk.sku, null);
      return next;
      continue;
    end if;

    -- FEFO: soonest expiry first, so what spoils first sells first.
    -- nulls last — a lot with no expiry is not urgent, and putting it
    -- first would leave dated stock to rot behind it.
    v_left := chk.requested;

    for lot in
      select b.batch_id,
             (b.on_hand - b.reserved - b.allocated - b.damaged) as free
        from stock.balance b
        join stock.batch bt on bt.id = b.batch_id
       where b.product_id = chk.product_id
         and b.location_id = p_location
         and b.batch_id is not null
         and bt.status = 'ACTIVE'
         and (b.on_hand - b.reserved - b.allocated - b.damaged) > 0
       order by bt.expiry_date nulls last, bt.created_at, b.batch_id
    loop
      exit when v_left <= 0;

      v_take := least(v_left, lot.free);

      ok := true; sku := chk.sku; requested := chk.requested;
      available := chk.available; problem := null;
      -- The key carries the lot: one line can produce several
      -- reservations, and two of them must not collide on it.
      reservation_id := stock.reserve(
        chk.product_id, p_location, v_take, p_order_ref,
        p_ttl_seconds, p_order_ref || ':' || chk.sku || ':' || lot.batch_id,
        lot.batch_id);
      return next;

      v_left := v_left - v_take;
    end loop;

    if v_left > 0 then
      -- Pass one said there was enough and pass two could not find
      -- it, so somebody else took it in between. Raising unwinds the
      -- whole transaction, which is what all-or-nothing means: the
      -- holds already placed for this order disappear with it.
      raise exception
        'INSUFFICIENT_STOCK: % short by % after lot allocation — another order took '
        'it between the check and the hold', chk.sku, v_left
        using errcode = '23514';
    end if;
  end loop;
end $function$;

comment on function stock.reserve_order(text, uuid, jsonb, integer) is
  'Hold a whole order or none of it, allocating lot-tracked lines FEFO across lots. Since 0055 a single line can return more than one row, one per lot it was filled from.';

comment on function stock.reserve(uuid, uuid, integer, text, integer, text, uuid) is
  'Hold stock in one balance row, optionally a named lot. Since 0055 the seventh argument selects the lot; the 6-argument form was dropped in the same migration to avoid an ambiguous overload.';


-- ─────────────────────────────────────────────────────────────
-- FOLLOW-UP, not done here
--
-- When receiving creates a second lot for a product, a single order
-- line can be filled from two of them and reserve_order will return
-- two rows for one sku. Two things downstream assume one:
--
--   Grocery src/app/checkout/page.tsx   builds `holdBySku`, a Map
--     keyed by sku — a second row silently overwrites the first
--   Grocery public.order_items.reservation_id   a single uuid column
--
-- The effect would be a hold that nothing records, so nothing
-- confirms it and nothing tells logistics about it. It cannot happen
-- until a second lot exists, which is why it is not fixed in this
-- migration — but it must be fixed before receiving is used in
-- anger. The shape wanted is a reservation_ids uuid[] on order_items,
-- or a line-to-reservation join table.
-- ─────────────────────────────────────────────────────────────
