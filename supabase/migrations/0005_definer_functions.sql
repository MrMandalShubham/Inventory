-- ============================================================
-- 0005 — SECURITY DEFINER functions
--
-- ⚠ READ THIS BEFORE ADDING ONE ⚠
--
-- A SECURITY DEFINER function runs with the powers of its owner, so
-- ROW-LEVEL SECURITY DOES NOT APPLY INSIDE IT. The guard steps aside.
--
-- That is the point — these functions need to do things the caller
-- cannot do directly. It is also the single most likely place for a
-- privilege leak in this codebase, and the leak is SILENT: no error,
-- no crash, just one shop quietly changing stock it does not own,
-- discovered later by the shop that lost it.
--
-- Therefore: every function here checks location and role IN ITS OWN
-- BODY, via platform.can_access_location(). This is enforced
-- mechanically by supabase/checks/definer-scope.sql, which fails the
-- build on any definer function that neither calls it nor carries an
-- explicit `-- @no-scope-check: <reason>` exemption.
-- ============================================================

-- ───────────────── read one balance ─────────────────

create or replace function stock.get_balance(
  p_product  uuid,
  p_location uuid
) returns integer
language plpgsql
security definer
set search_path = stock, platform, public, extensions
as $$
declare v_on_hand integer;
begin
  -- RLS is off in here. Do the guard's job.
  if not platform.can_access_location(p_location) then
    raise exception 'FORBIDDEN_LOCATION: caller may not access location %', p_location
      using errcode = '42501';
  end if;

  select on_hand into v_on_hand
    from stock.balance
   where product_id = p_product and location_id = p_location;

  return coalesce(v_on_hand, 0);
end $$;

-- ───────────────── post a stock adjustment ─────────────────
--
-- Separation of duties (docs/08 §1): operators record counts, they
-- never adjust stock. The variance flows through an approver.

create or replace function stock.post_adjustment(
  p_product  uuid,
  p_location uuid,
  p_delta    integer,
  p_reason   text
) returns integer
language plpgsql
security definer
set search_path = stock, platform, public, extensions
as $$
declare v_after integer;
begin
  if not platform.can_access_location(p_location) then
    raise exception 'FORBIDDEN_LOCATION: caller may not access location %', p_location
      using errcode = '42501';
  end if;

  if platform.current_role_name() not in ('shop_manager','planner','finance','admin') then
    raise exception 'FORBIDDEN_ROLE: % may not post an adjustment', platform.current_role_name()
      using errcode = '42501';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'REASON_REQUIRED: an adjustment without a reason is indistinguishable from theft'
      using errcode = '23514';
  end if;

  update stock.balance
     set on_hand = on_hand + p_delta,
         updated_at = now()
   where product_id = p_product and location_id = p_location
  returning on_hand into v_after;

  if not found then
    raise exception 'NO_SUCH_BALANCE: no stock row for product % at location %', p_product, p_location
      using errcode = 'P0002';
  end if;

  -- Phase 2 writes the ledger entry here. Until then the CHECK
  -- constraints are what keep this honest.
  return v_after;
end $$;

-- ───────────────── seed a balance row ─────────────────
--
-- Phase 1 replaces this with proper opening-balance import.

create or replace function stock.ensure_balance(
  p_product  uuid,
  p_location uuid,
  p_on_hand  integer default 0
) returns uuid
language plpgsql
security definer
set search_path = stock, platform, public, extensions
as $$
declare v_id uuid;
begin
  if not platform.can_access_location(p_location) then
    raise exception 'FORBIDDEN_LOCATION: caller may not access location %', p_location
      using errcode = '42501';
  end if;

  if platform.current_role_name() not in ('planner','admin') then
    raise exception 'FORBIDDEN_ROLE: % may not open a stock line', platform.current_role_name()
      using errcode = '42501';
  end if;

  insert into stock.balance (product_id, location_id, on_hand)
       values (p_product, p_location, p_on_hand)
  on conflict (product_id, location_id) do update
      set updated_at = now()
    returning id into v_id;

  return v_id;
end $$;

-- ───────────────── deliberately exempt ─────────────────
--
-- A definer function that touches no location data declares why.
-- The check reads this marker; it is an auditable escape hatch,
-- not a way to skip the rule quietly.

create or replace function platform.whoami()
returns jsonb
language sql
security definer
stable
as $$
  -- @no-scope-check: reports the caller's own claims and reads no stock.
  select jsonb_build_object(
    'user_id',      platform.current_user_id(),
    'role',         platform.current_role_name(),
    'locations',    platform.current_location_ids(),
    'global_scope', platform.has_global_scope()
  )
$$;
