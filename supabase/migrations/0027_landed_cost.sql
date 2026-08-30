-- ============================================================
-- 0027 — Landed cost and weighted average valuation
--
-- ── The rule everything downstream inherits ──
--
-- LANDED COST IS FIXED AT RECEIPT, AND IT IS NOT THE INVOICE PRICE.
--
-- If ₹20,000 of goods arrive with ₹500 of freight, the stock is worth
-- ₹20,500 from that moment on. Every margin figure in the business —
-- gross margin, contribution, per-customer profitability, the P&L —
-- inherits its accuracy from this one step. A sloppy goods receipt
-- makes every report downstream a guess.
--
-- ── Weighted average, decided once ──
--
-- Simpler than FIFO, robust to the constant small purchases this
-- business makes, and standard for grocery distribution. FIFO is more
-- precise for fruit and veg and is not worth the complexity at this
-- scale.
--
-- Change this casually later and every historic margin figure becomes
-- incomparable. It is written down here so that changing it is a
-- decision somebody has to argue for.
--
-- ── Where the average is maintained ──
--
-- Inside post_movement(), in the same statement set as the quantity.
-- A valuation kept anywhere else eventually disagrees with the stock
-- it values, and then nobody can say which is wrong.
-- ============================================================

alter table stock.balance
  add column weighted_avg_cost numeric(18,6) not null default 0;

comment on column stock.balance.weighted_avg_cost is
  'Landed cost per unit, in paise, carried to six decimals. Fractions matter: rounding per movement compounds into a visibly wrong valuation.';

-- Charges that arrive with the goods but not on the goods lines.
alter table movement.movement
  add column freight_paise        bigint not null default 0 check (freight_paise >= 0),
  add column other_charges_paise  bigint not null default 0 check (other_charges_paise >= 0),
  add column tax_paise            bigint not null default 0 check (tax_paise >= 0);

-- What each line actually cost us, once the charges were spread.
alter table movement.line
  add column landed_unit_cost numeric(18,6);

comment on column movement.line.landed_unit_cost is
  'unit_cost plus this line''s share of freight and charges. Frozen at receipt — see migration 0027.';

-- ─────────────── spreading the charges ───────────────

/**
 * Allocate freight and other charges across a movement's lines.
 *
 * Pro-rata by goods value, because a ₹500 delivery charge belongs
 * mostly to the expensive pallet. Where no line carries a price —
 * a mandi run where everything was cash and the prices are on a
 * scrap of paper — it falls back to quantity, which is at least
 * defensible rather than arbitrary.
 */
create or replace function movement.allocate_landed_cost(p_movement uuid)
returns integer
language plpgsql
security definer
set search_path = movement, platform, public
as $$
-- @no-scope-check: costing a movement the caller already reached
-- through receive_movement(), which checks the destination.
declare
  m           movement.movement%rowtype;
  v_charges   bigint;
  v_value     numeric;
  v_units     numeric;
  v_rows      integer;
begin
  select * into m from movement.movement where id = p_movement;
  if not found then raise exception 'NO_SUCH_MOVEMENT' using errcode = 'P0002'; end if;

  v_charges := m.freight_paise + m.other_charges_paise;

  select coalesce(sum(coalesce(unit_cost,0) * coalesce(qty_received, qty_dispatched, qty_ordered)), 0),
         coalesce(sum(coalesce(qty_received, qty_dispatched, qty_ordered)), 0)
    into v_value, v_units
    from movement.line where movement_id = p_movement;

  update movement.line l
     set landed_unit_cost =
           coalesce(l.unit_cost, 0)
           + case
               when v_charges = 0 then 0
               -- by value, when there are values to go by
               when v_value > 0 then
                 (v_charges * (coalesce(l.unit_cost,0)
                               * coalesce(l.qty_received, l.qty_dispatched, l.qty_ordered))
                  / v_value)
                 / nullif(coalesce(l.qty_received, l.qty_dispatched, l.qty_ordered), 0)
               -- otherwise by quantity, which is at least defensible
               when v_units > 0 then v_charges / v_units
               else 0
             end
   where l.movement_id = p_movement;

  get diagnostics v_rows = row_count;
  return v_rows;
end $$;

-- ─────────────── the average, maintained atomically ───────────────
--
-- Replaces post_movement so that quantity and value can never come
-- apart. Every other function in the system already goes through it.

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
set search_path = stock, catalog, platform, public
as $$
declare
  v_reason   stock.reason%rowtype;
  v_after    integer;
  v_id       bigint;
  v_existing bigint;
  v_tracking text;
  v_before   integer;
  v_wac      numeric(18,6);
  v_unit     numeric(18,6);
begin
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
    raise exception 'ZERO_MOVEMENT: a movement of nothing is not an event' using errcode = '23514';
  end if;
  if v_reason.direction = 'IN'  and p_qty_delta < 0 then
    raise exception 'WRONG_DIRECTION: % increases stock, got %', v_reason.code, p_qty_delta
      using errcode = '23514';
  end if;
  if v_reason.direction = 'OUT' and p_qty_delta > 0 then
    raise exception 'WRONG_DIRECTION: % reduces stock, got +%', v_reason.code, p_qty_delta
      using errcode = '23514';
  end if;

  if p_idempotency_key is not null then
    begin
      insert into stock.idempotency (key) values (p_idempotency_key);
    exception when unique_violation then
      select ledger_id into v_existing from stock.idempotency where key = p_idempotency_key;
      return v_existing;
    end;
  end if;

  select tracking_mode into v_tracking from catalog.product where id = p_product;
  if v_tracking = 'BATCH' and p_batch is null and v_reason.code <> 'OPENING' then
    raise exception 'BATCH_REQUIRED: % is batch-tracked, so the lot must be named', p_product
      using errcode = '23514';
  end if;

  -- What the line was worth before this movement.
  select on_hand, weighted_avg_cost into v_before, v_wac
    from stock.balance
   where product_id = p_product and location_id = p_location
     and batch_id is not distinct from p_batch;
  v_before := coalesce(v_before, 0);
  v_wac    := coalesce(v_wac, 0);

  -- ── The valuation rule ──
  --
  -- Stock coming IN at a stated cost moves the average. Stock going
  -- OUT leaves at the average and does not change it — that is what
  -- "weighted average" means, and it is why COGS on a sale needs no
  -- decision at the time of the sale.
  if p_qty_delta > 0 and p_unit_cost is not null then
    v_unit := case
      when v_before + p_qty_delta = 0 then 0
      else ((v_before * v_wac) + (p_qty_delta * p_unit_cost))
           / (v_before + p_qty_delta)
    end;
  else
    v_unit := v_wac;
  end if;

  insert into stock.balance (product_id, location_id, batch_id, on_hand, weighted_avg_cost)
       values (p_product, p_location, p_batch, greatest(p_qty_delta, 0),
               case when p_qty_delta > 0 and p_unit_cost is not null
                    then p_unit_cost else 0 end)
  on conflict (product_id, location_id, batch_id) do update
      set on_hand           = stock.balance.on_hand + p_qty_delta,
          weighted_avg_cost = v_unit,
          updated_at        = now()
    returning on_hand into v_after;

  insert into stock.ledger (
    product_id, location_id, batch_id, qty_delta, balance_after,
    reason_code, movement_id, note, unit_cost, total_value,
    actor_id, occurred_at, idempotency_key
  ) values (
    p_product, p_location, p_batch, p_qty_delta, v_after,
    v_reason.code, p_movement, p_note,
    -- Outbound carries the average it left at, so COGS is settled
    -- here rather than reconstructed later from a price list.
    coalesce(p_unit_cost, round(v_wac)::bigint),
    round(coalesce(p_unit_cost, v_wac) * abs(p_qty_delta))::bigint,
    coalesce(platform.current_user_id(), '00000000-0000-0000-0000-000000000000'::uuid),
    p_occurred_at, p_idempotency_key
  ) returning id into v_id;

  if p_idempotency_key is not null then
    update stock.idempotency set ledger_id = v_id where key = p_idempotency_key;
  end if;

  return v_id;
end $$;

-- ─────────────── what the shelf is worth ───────────────

create or replace function stock.valuation(p_location uuid default null)
returns table (
  location_id uuid,
  location_code text,
  lines integer,
  units bigint,
  value_paise bigint
)
language sql stable
security definer
set search_path = stock, platform, public
as $$
  -- @no-scope-check: aggregates stock.balance, whose own policy is
  -- location-scoped; the filter below repeats it for the same effect.
  select b.location_id, l.code,
         count(*)::integer,
         coalesce(sum(b.on_hand), 0)::bigint,
         round(coalesce(sum(b.on_hand * b.weighted_avg_cost), 0))::bigint
    from stock.balance b
    join platform.location l on l.id = b.location_id
   where l.type <> 'VIRTUAL'
     and platform.can_access_location(b.location_id)
     and (p_location is null or b.location_id = p_location)
   group by b.location_id, l.code
   order by l.code;
$$;
