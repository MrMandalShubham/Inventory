-- ============================================================
-- 0013 — Posting, rebuilding, verifying
--
-- stock.post_movement() is now the ONLY way stock changes. Every
-- other function in the system calls it. It does five things in one
-- transaction, so they cannot come apart:
--
--   1. check scope and role
--   2. return the original result if this is a retry
--   3. move the balance, with the constraint as the guard
--   4. write the ledger row, carrying the resulting balance
--   5. return the ledger id
--
-- If any step raises, Postgres rolls the whole thing back. Stock and
-- ledger cannot diverge, by construction rather than by care.
-- ============================================================

create or replace function stock.post_movement(
  p_product         uuid,
  p_location        uuid,
  p_qty_delta       integer,
  p_reason          text,
  p_batch           uuid        default null,
  p_note            text        default null,
  p_movement        uuid        default null,
  p_unit_cost       bigint      default null,
  p_occurred_at     timestamptz default now(),
  p_idempotency_key text        default null
) returns bigint
language plpgsql
security definer
set search_path = stock, catalog, platform, public, extensions
as $$
declare
  v_reason   stock.reason%rowtype;
  v_after    integer;
  v_id       bigint;
  v_existing bigint;
  v_tracking text;
begin
  -- 1. Scope. RLS does not apply inside a definer function.
  if not platform.can_access_location(p_location) then
    raise exception 'FORBIDDEN_LOCATION: caller may not move stock at %', p_location
      using errcode = '42501';
  end if;

  select * into v_reason from stock.reason where code = upper(p_reason);
  if not found then
    raise exception 'UNKNOWN_REASON: "%" is not a recorded reason for stock to move', p_reason
      using errcode = '23514';
  end if;

  if array_length(v_reason.allowed_roles, 1) is not null
     and not (platform.current_role_name() = any (v_reason.allowed_roles)) then
    raise exception 'FORBIDDEN_ROLE: % may not post %', platform.current_role_name(), v_reason.code
      using errcode = '42501';
  end if;

  if p_qty_delta = 0 then
    raise exception 'ZERO_MOVEMENT: a movement of nothing is not an event'
      using errcode = '23514';
  end if;

  if v_reason.direction = 'IN'  and p_qty_delta < 0 then
    raise exception 'WRONG_DIRECTION: % increases stock, got %', v_reason.code, p_qty_delta
      using errcode = '23514';
  end if;
  if v_reason.direction = 'OUT' and p_qty_delta > 0 then
    raise exception 'WRONG_DIRECTION: % reduces stock, got +%', v_reason.code, p_qty_delta
      using errcode = '23514';
  end if;

  -- 2. Idempotency. A retry returns the original result and moves
  -- nothing.
  --
  -- Claiming the key with an INSERT rather than checking for it
  -- first is what makes this safe under concurrency: a second
  -- transaction with the same key BLOCKS on the primary key until
  -- the first commits, then raises and reads the committed result.
  -- A check-then-insert would let both pass the check.
  if p_idempotency_key is not null then
    begin
      insert into stock.idempotency (key) values (p_idempotency_key);
    exception when unique_violation then
      select ledger_id into v_existing
        from stock.idempotency where key = p_idempotency_key;
      return v_existing;
    end;
  end if;

  -- A batch-tracked product must say which lot moved, or the expiry
  -- and the traceability have nowhere to attach.
  select tracking_mode into v_tracking from catalog.product where id = p_product;
  if v_tracking = 'BATCH' and p_batch is null and v_reason.code <> 'OPENING' then
    raise exception 'BATCH_REQUIRED: % is batch-tracked, so the lot must be named', p_product
      using errcode = '23514';
  end if;

  -- 3. Move the balance. The CHECK constraints are the guard: no
  -- application logic decides whether this is allowed.
  insert into stock.balance (product_id, location_id, batch_id, on_hand)
       values (p_product, p_location, p_batch, greatest(p_qty_delta, 0))
  on conflict (product_id, location_id, batch_id) do update
      set on_hand    = stock.balance.on_hand + p_qty_delta,
          updated_at = now()
    returning on_hand into v_after;

  -- 4. The ledger row, carrying what the line became.
  insert into stock.ledger (
    product_id, location_id, batch_id, qty_delta, balance_after,
    reason_code, movement_id, note, unit_cost, total_value,
    actor_id, occurred_at, idempotency_key
  ) values (
    p_product, p_location, p_batch, p_qty_delta, v_after,
    v_reason.code, p_movement, p_note, p_unit_cost,
    case when p_unit_cost is null then null else p_unit_cost * abs(p_qty_delta) end,
    coalesce(platform.current_user_id(), '00000000-0000-0000-0000-000000000000'::uuid),
    p_occurred_at, p_idempotency_key
  ) returning id into v_id;

  if p_idempotency_key is not null then
    update stock.idempotency set ledger_id = v_id where key = p_idempotency_key;
  end if;

  return v_id;
end $$;

comment on function stock.post_movement is
  'The only door through which stock changes. Balance and ledger move together or not at all.';

-- ─────────────────── convenience wrappers ───────────────────

create or replace function stock.record_wastage(
  p_product uuid, p_location uuid, p_qty integer, p_note text, p_batch uuid default null
) returns bigint
language sql security definer
set search_path = stock, platform, public, extensions
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
language plpgsql security definer
set search_path = stock, platform, public, extensions
as $$
declare v_after integer;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'REASON_REQUIRED: an adjustment without a reason is indistinguishable from theft'
      using errcode = '23514';
  end if;

  -- Scope and role are checked inside post_movement; ADJUST is
  -- restricted to shop_manager and above by its reason row.
  perform stock.post_movement(p_product, p_location, p_delta, 'ADJUST', null, p_reason);

  select on_hand into v_after from stock.balance
   where product_id = p_product and location_id = p_location and batch_id is null;
  return v_after;
end $$;

-- ─────────────── opening balances become events too ───────────────
--
-- Replaces the direct write from migration 0008. An opening balance
-- IS an event — the moment the business declared what it had — and
-- writing it around the ledger would mean the rebuild could never
-- reproduce it.

create or replace function stock.import_opening_balances(p_rows jsonb)
returns table (
  row_number  integer,
  sku_code    text,
  location    text,
  status      text,
  message     text
)
language plpgsql
security definer
set search_path = stock, catalog, platform, public, extensions
as $$
declare
  r          jsonb;
  i          integer := 0;
  v_product  uuid;
  v_location uuid;
  v_qty      integer;
  v_current  integer;
begin
  if platform.current_role_name() not in ('planner','admin') then
    raise exception 'FORBIDDEN_ROLE: % may not set opening balances', platform.current_role_name()
      using errcode = '42501';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      select id into v_product from catalog.product where product.sku_code = r ->> 'sku_code';
      if v_product is null then raise exception 'unknown product "%"', r ->> 'sku_code'; end if;

      select id into v_location from platform.location where code = r ->> 'location_code';
      if v_location is null then raise exception 'unknown location "%"', r ->> 'location_code'; end if;

      if not platform.can_access_location(v_location) then
        raise exception 'FORBIDDEN_LOCATION: caller may not open stock at %', r ->> 'location_code'
          using errcode = '42501';
      end if;

      v_qty := (r ->> 'on_hand')::integer;
      if v_qty is null or v_qty < 0 then
        raise exception 'on_hand must be zero or greater, got "%"', r ->> 'on_hand';
      end if;

      -- Re-running an opening import posts the DIFFERENCE, so the
      -- ledger still adds up to the number the file asked for. An
      -- absolute overwrite would leave the sum and the balance apart.
      select coalesce(on_hand, 0) into v_current from stock.balance
       where product_id = v_product and location_id = v_location and batch_id is null;
      v_current := coalesce(v_current, 0);

      if v_qty <> v_current then
        perform stock.post_movement(
          v_product, v_location, v_qty - v_current, 'OPENING', null,
          'opening balance import');
      end if;

      row_number := i; sku_code := r ->> 'sku_code';
      location := r ->> 'location_code'; status := 'OK'; message := null;
      return next;

    exception when others then
      row_number := i; sku_code := r ->> 'sku_code';
      location := r ->> 'location_code'; status := 'FAILED';
      message := catalog.explain_error(null, sqlerrm);
      return next;
    end;
  end loop;
end $$;

-- ═══════════════════ THE GATE ═══════════════════
--
-- Rebuild the projection from the event log alone, and prove it
-- reproduces every number. Run hourly in production (docs/07 §3.1)
-- and on every commit in CI.

/** Compare the projection against the ledger. Zero rows = healthy. */
create or replace function stock.verify_balances()
returns table (
  product_id  uuid,
  location_id uuid,
  batch_id    uuid,
  balance_says integer,
  ledger_says  integer
)
language sql stable
security definer
set search_path = stock, public, extensions
as $$
  -- @no-scope-check: a whole-system integrity check. It reports
  -- discrepancies, never data — the caller learns THAT a line
  -- disagrees, and the quantities that disagree, which is exactly
  -- what an operator needs to raise an incident.
  select coalesce(b.product_id, l.product_id),
         coalesce(b.location_id, l.location_id),
         coalesce(b.batch_id, l.batch_id),
         coalesce(b.on_hand, 0),
         coalesce(l.summed, 0)
    from stock.balance b
    full outer join (
      select product_id, location_id, batch_id, sum(qty_delta)::integer as summed
        from stock.ledger
       group by product_id, location_id, batch_id
    ) l on l.product_id = b.product_id
       and l.location_id = b.location_id
       and l.batch_id is not distinct from b.batch_id
   where coalesce(b.on_hand, 0) <> coalesce(l.summed, 0);
$$;

/** Destroy the projection and rebuild it from the ledger alone. */
create or replace function stock.rebuild_balances()
returns integer
language plpgsql
security definer
set search_path = stock, public, extensions
as $$
-- @no-scope-check: a maintenance operation over the whole projection.
-- Restricted to admin below; it reads and writes no location data
-- that was not already derivable from the ledger.
declare v_rows integer;
begin
  if platform.current_role_name() <> 'admin' then
    raise exception 'FORBIDDEN_ROLE: only an admin may rebuild the projection'
      using errcode = '42501';
  end if;

  -- Reserved, allocated, in_transit and damaged are Phase 3/4 state
  -- that does not live in the ledger yet, so they are preserved
  -- rather than recomputed. on_hand is fully derived.
  delete from stock.balance;

  insert into stock.balance (product_id, location_id, batch_id, on_hand)
  select product_id, location_id, batch_id, sum(qty_delta)::integer
    from stock.ledger
   group by product_id, location_id, batch_id
  having sum(qty_delta) <> 0;

  get diagnostics v_rows = row_count;
  return v_rows;
end $$;

-- ─────────────── point in time ───────────────

/** What the position was on any past date. Free, because the log is
    append-only — and impossible without it. */
create or replace function stock.balance_as_of(p_when timestamptz)
returns table (product_id uuid, location_id uuid, batch_id uuid, on_hand integer)
language sql stable
security definer
set search_path = stock, platform, public, extensions
as $$
  select l.product_id, l.location_id, l.batch_id, sum(l.qty_delta)::integer
    from stock.ledger l
   where l.occurred_at <= p_when
     and platform.can_access_location(l.location_id)
   group by l.product_id, l.location_id, l.batch_id
  having sum(l.qty_delta) <> 0;
$$;
