-- ============================================================
-- 0019 — Reservations
--
-- The buy/sell app is the demanding consumer of this system, because
-- it does something the dashboard never does: it takes stock away
-- from a customer who has not paid yet, concurrently with everyone
-- else.
--
--   HELD ──pays──> CONFIRMED ──ships──> CONSUMED
--     │                 │
--     │ expiry sweep    │ cancelled
--     └────────> RELEASED <┘
--
-- ── Held at CHECKOUT, not at add-to-cart ──
--
-- Holding at cart means one person browsing makes an item appear
-- sold out to everyone else. That is a worse failure than the one it
-- prevents, and it is the most common way this gets designed wrong.
--
-- ── Where the guarantee actually lives ──
--
-- One UPDATE statement, with the availability test in its WHERE
-- clause. Postgres serialises it, so no amount of concurrency can
-- oversell — and the claims_within_stock CHECK from migration 0004
-- sits underneath as the backstop that no code path can breach.
--
-- A read-then-write version would have a window between the check
-- and the decrement, and that window is exactly where overselling
-- lives.
-- ============================================================

create table stock.reservation (
  id            uuid primary key default gen_random_uuid(),

  product_id    uuid not null references catalog.product(id),
  location_id   uuid not null references platform.location(id),
  batch_id      uuid references stock.batch(id),

  quantity      integer not null check (quantity > 0),

  status        text not null default 'HELD'
                check (status in ('HELD','CONFIRMED','CONSUMED','RELEASED')),

  -- The consuming app's own order id. We know an order only as a
  -- reference — the app owns order state, we own stock (docs/09 §9).
  order_ref     text,
  api_client_id uuid references platform.api_client(id),

  -- Rule R4: every reserve, confirm and release carries a key, and a
  -- retry with the same key must not decrement twice.
  idempotency_key text,

  -- Nulled rather than left in the past once confirmed, so the
  -- sweeper's query needs no knowledge of status precedence:
  -- anything with an expiry that has passed is expired, full stop.
  expires_at    timestamptz,

  -- Why it ended, for the reconciliation nobody wants to do by hand.
  released_reason text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  consumed_at   timestamptz
);

-- The idempotency guarantee, enforced by the database rather than by
-- a check-then-insert that two concurrent retries would both pass.
create unique index reservation_idempotency
  on stock.reservation (idempotency_key) where idempotency_key is not null;

create index reservation_line_idx   on stock.reservation (product_id, location_id, status);
create index reservation_order_idx  on stock.reservation (order_ref) where order_ref is not null;
-- The sweeper's query: expired holds, oldest first.
create index reservation_expiry_idx on stock.reservation (status, expires_at)
  where status = 'HELD';

alter table stock.reservation enable row level security;

create policy reservation_read on stock.reservation
  for select using (platform.can_access_location(location_id));

-- ─────────────────────── reserve ───────────────────────

create or replace function stock.reserve(
  p_product         uuid,
  p_location        uuid,
  p_qty             integer,
  p_order_ref       text default null,
  p_ttl_seconds     integer default 900,
  p_idempotency_key text default null
) returns uuid
language plpgsql
security definer
set search_path = stock, catalog, platform, public
as $$
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
     and batch_id is null
     and on_hand - reserved - allocated - damaged >= p_qty;

  if not found then
    select coalesce(on_hand - reserved - allocated - damaged, 0) into v_available
      from stock.balance
     where product_id = p_product and location_id = p_location and batch_id is null;

    raise exception 'INSUFFICIENT_STOCK: % requested, % available', p_qty, coalesce(v_available, 0)
      using errcode = '23514';
  end if;

  insert into stock.reservation
    (product_id, location_id, quantity, order_ref, idempotency_key, expires_at)
  values
    (p_product, p_location, p_qty, p_order_ref, p_idempotency_key,
     now() + make_interval(secs => greatest(p_ttl_seconds, 30)))
  returning id into v_id;

  return v_id;
end $$;

comment on function stock.reserve is
  'Holds stock at checkout. The single UPDATE with the availability test in its WHERE clause is the oversell guarantee.';

-- ─────────────────────── confirm ───────────────────────
--
-- The customer paid. The hold stops expiring; the stock is still on
-- the shelf, still not sold. Nothing moves.

create or replace function stock.confirm_reservation(
  p_id uuid, p_order_ref text default null
) returns void
language plpgsql security definer
set search_path = stock, platform, public
as $$
declare r stock.reservation%rowtype;
begin
  select * into r from stock.reservation where id = p_id;
  if not found then raise exception 'NO_SUCH_RESERVATION' using errcode = 'P0002'; end if;

  if not platform.can_access_location(r.location_id) then
    raise exception 'FORBIDDEN_LOCATION' using errcode = '42501';
  end if;

  if r.status = 'CONFIRMED' then return; end if;    -- idempotent by nature
  if r.status <> 'HELD' then
    raise exception 'WRONG_STATUS: reservation is %, cannot confirm', r.status
      using errcode = '23514';
  end if;

  update stock.reservation
     set status = 'CONFIRMED',
         expires_at = null,                          -- a paid hold does not lapse
         order_ref = coalesce(p_order_ref, order_ref),
         updated_at = now()
   where id = p_id;
end $$;

-- ─────────────────────── consume ───────────────────────
--
-- The goods physically leave. This is the only step that writes to
-- the ledger — up to here nothing had moved.

create or replace function stock.consume_reservation(p_id uuid)
returns bigint
language plpgsql security definer
set search_path = stock, platform, public
as $$
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
  update stock.balance
     set reserved = reserved - r.quantity, updated_at = now()
   where product_id = r.product_id and location_id = r.location_id and batch_id is null;

  v_led := stock.post_movement(
    r.product_id, r.location_id, -r.quantity, 'ISSUE', r.batch_id,
    'reservation ' || r.id::text);

  update stock.reservation
     set status = 'CONSUMED', consumed_at = now(), updated_at = now()
   where id = p_id;

  return v_led;
end $$;

-- ─────────────────────── release ───────────────────────

create or replace function stock.release_reservation(
  p_id uuid, p_reason text default 'released'
) returns void
language plpgsql security definer
set search_path = stock, platform, public
as $$
declare r stock.reservation%rowtype;
begin
  select * into r from stock.reservation where id = p_id;
  if not found then raise exception 'NO_SUCH_RESERVATION' using errcode = 'P0002'; end if;

  if not platform.can_access_location(r.location_id) then
    raise exception 'FORBIDDEN_LOCATION' using errcode = '42501';
  end if;

  if r.status = 'RELEASED' then return; end if;     -- idempotent
  if r.status = 'CONSUMED' then
    raise exception 'ALREADY_CONSUMED: the goods have already gone' using errcode = '23514';
  end if;

  update stock.balance
     set reserved = reserved - r.quantity, updated_at = now()
   where product_id = r.product_id and location_id = r.location_id and batch_id is null;

  update stock.reservation
     set status = 'RELEASED', released_reason = p_reason,
         expires_at = null, updated_at = now()
   where id = p_id;
end $$;

-- ─────────────────── the expiry sweeper ───────────────────
--
-- MANDATORY, not an optimisation. Without it a wave of abandoned
-- carts freezes the catalogue, and the failure looks exactly like a
-- stockout — which is the worst possible way to discover it.
--
-- Runs every minute. In production: pg_cron inside Supabase, NOT
-- Vercel Cron, so the release and the counter move in one
-- transaction (docs/02 §1, constraint 3).

create or replace function stock.sweep_expired_reservations()
returns integer
language plpgsql
security definer
set search_path = stock, public
as $$
-- @no-scope-check: a scheduled sweep over every location. It releases
-- only holds that have already lapsed and reads no stock out.
declare
  r       record;
  v_count integer := 0;
begin
  for r in
    select id, product_id, location_id, quantity
      from stock.reservation
     where status = 'HELD' and expires_at is not null and expires_at < now()
     order by expires_at
     for update skip locked
  loop
    update stock.balance
       set reserved = reserved - r.quantity, updated_at = now()
     where product_id = r.product_id and location_id = r.location_id and batch_id is null;

    update stock.reservation
       set status = 'RELEASED', released_reason = 'expired', expires_at = null, updated_at = now()
     where id = r.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end $$;

comment on function stock.sweep_expired_reservations is
  'Run every minute. Without it, abandoned checkouts look identical to a stockout.';

-- ─────────────── health check: holds vs the counter ───────────────

/** stock.balance.reserved should equal the sum of live reservations. */
create or replace function stock.verify_reservations()
returns table (product_id uuid, location_id uuid, counter integer, live_holds integer)
language sql stable
security definer
set search_path = stock, public
as $$
  -- @no-scope-check: whole-system integrity check reporting only
  -- discrepancies, like stock.verify_balances().
  select coalesce(b.product_id, r.product_id),
         coalesce(b.location_id, r.location_id),
         coalesce(b.reserved, 0),
         coalesce(r.held, 0)
    from stock.balance b
    full outer join (
      select product_id, location_id, sum(quantity)::integer as held
        from stock.reservation
       where status in ('HELD','CONFIRMED')
       group by product_id, location_id
    ) r on r.product_id = b.product_id and r.location_id = b.location_id
   where coalesce(b.reserved, 0) <> coalesce(r.held, 0);
$$;
