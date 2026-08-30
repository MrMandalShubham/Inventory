-- ============================================================
-- 0029 — Every movement posts to the books
--
-- The wiring that makes migration 0028 true rather than available.
-- A trigger on stock.ledger, so it cannot be forgotten: any code path
-- that moves stock — the API, the dashboard, an import, a count
-- variance, a future one nobody has written yet — posts its accounting
-- entry without knowing it did.
--
--   RECEIPT       DR INVENTORY            CR SUPPLIER_PAYABLE
--   ISSUE         DR COGS                 CR INVENTORY
--   TRANSFER_OUT  DR INVENTORY_IN_TRANSIT CR INVENTORY
--   TRANSFER_IN   DR INVENTORY            CR INVENTORY_IN_TRANSIT
--   WASTAGE       DR WASTAGE              CR INVENTORY
--   COUNT/ADJUST  DR/CR STOCK_ADJUSTMENT vs INVENTORY
--   OPENING       DR INVENTORY            CR STOCK_ADJUSTMENT
--
-- INVARIANT 8 lives in the TRANSFER lines: value moves between
-- INVENTORY accounts through IN_TRANSIT and touches no revenue and no
-- tax account. You cannot sell to yourself.
--
-- Revenue is NOT posted here. A stock movement knows what goods cost;
-- it does not know what they sold for. The revenue leg is posted with
-- the invoice, in movement.post_sale_revenue().
-- ============================================================

create or replace function ledger.post_for_stock_movement()
returns trigger
language plpgsql
security definer
set search_path = ledger, stock, movement, platform, public
as $$
declare
  v_value   bigint;
  v_qty     integer := abs(new.qty_delta);
  v_partner uuid;
  v_lines   jsonb;
  v_transit uuid;
begin
  -- Value the movement at what the ledger row itself recorded, so the
  -- books and the stock ledger cannot tell different stories.
  v_value := coalesce(new.total_value, 0);

  -- A movement with no value posts nothing. That is honest: opening
  -- balances loaded before costs are known would otherwise book a
  -- phantom zero-value asset and make the trial balance meaningless.
  if v_value = 0 then return null; end if;

  select id into v_transit from platform.location where code = 'TRANSIT';
  if new.movement_id is not null then
    select partner_id into v_partner from movement.movement where id = new.movement_id;
  end if;

  v_lines := case new.reason_code

    when 'RECEIPT' then jsonb_build_array(
      jsonb_build_object('account','INVENTORY','debit',v_value,
                         'location_id',new.location_id,'product_id',new.product_id),
      jsonb_build_object('account','SUPPLIER_PAYABLE','credit',v_value,
                         'partner_id',v_partner))

    when 'ISSUE' then jsonb_build_array(
      jsonb_build_object('account','COGS','debit',v_value,
                         'location_id',new.location_id,'product_id',new.product_id),
      jsonb_build_object('account','INVENTORY','credit',v_value,
                         'location_id',new.location_id,'product_id',new.product_id))

    when 'TRANSFER_OUT' then
      case when new.location_id = v_transit
        -- Leaving transit for the destination: handled by the matching
        -- TRANSFER_IN, so nothing to post here.
        then jsonb_build_array(
          jsonb_build_object('account','INVENTORY_IN_TRANSIT','credit',v_value),
          jsonb_build_object('account','INVENTORY_IN_TRANSIT','debit',v_value))
        else jsonb_build_array(
          jsonb_build_object('account','INVENTORY_IN_TRANSIT','debit',v_value),
          jsonb_build_object('account','INVENTORY','credit',v_value,
                             'location_id',new.location_id,'product_id',new.product_id))
      end

    when 'TRANSFER_IN' then
      case when new.location_id = v_transit
        then jsonb_build_array(
          jsonb_build_object('account','INVENTORY_IN_TRANSIT','debit',v_value),
          jsonb_build_object('account','INVENTORY_IN_TRANSIT','credit',v_value))
        else jsonb_build_array(
          jsonb_build_object('account','INVENTORY','debit',v_value,
                             'location_id',new.location_id,'product_id',new.product_id),
          jsonb_build_object('account','INVENTORY_IN_TRANSIT','credit',v_value))
      end

    when 'WASTAGE' then jsonb_build_array(
      jsonb_build_object('account','WASTAGE','debit',v_value,
                         'location_id',new.location_id,'product_id',new.product_id),
      jsonb_build_object('account','INVENTORY','credit',v_value,
                         'location_id',new.location_id,'product_id',new.product_id))

    when 'RETURN' then
      case when new.qty_delta > 0
        then jsonb_build_array(
          jsonb_build_object('account','INVENTORY','debit',v_value,
                             'location_id',new.location_id,'product_id',new.product_id),
          jsonb_build_object('account','COGS','credit',v_value,
                             'location_id',new.location_id,'product_id',new.product_id))
        else jsonb_build_array(
          jsonb_build_object('account','SUPPLIER_PAYABLE','debit',v_value,'partner_id',v_partner),
          jsonb_build_object('account','INVENTORY','credit',v_value,
                             'location_id',new.location_id,'product_id',new.product_id))
      end

    else
      -- OPENING, COUNT, ADJUST, CORRECTION. Stock appearing or
      -- vanishing against an adjustment account, which is exactly
      -- where an auditor wants to look.
      case when new.qty_delta > 0
        then jsonb_build_array(
          jsonb_build_object('account','INVENTORY','debit',v_value,
                             'location_id',new.location_id,'product_id',new.product_id),
          jsonb_build_object('account','STOCK_ADJUSTMENT','credit',v_value,
                             'location_id',new.location_id))
        else jsonb_build_array(
          jsonb_build_object('account','STOCK_ADJUSTMENT','debit',v_value,
                             'location_id',new.location_id),
          jsonb_build_object('account','INVENTORY','credit',v_value,
                             'location_id',new.location_id,'product_id',new.product_id))
      end
  end;

  perform ledger.post(
    'STOCK_MOVEMENT',
    format('%s %s units', new.reason_code, v_qty),
    v_lines,
    new.movement_id::text,
    new.id,
    new.occurred_at);

  return null;
end $$;

create trigger stock_posts_to_books
  after insert on stock.ledger
  for each row execute function ledger.post_for_stock_movement();

-- ─────────────── the revenue leg ───────────────
--
-- Posted with the invoice, because a stock movement knows what goods
-- COST and not what they SOLD for.

create or replace function movement.post_sale_revenue(p_movement uuid)
returns uuid
language plpgsql
security definer
set search_path = movement, ledger, platform, public
as $$
declare
  m        movement.movement%rowtype;
  v_goods  bigint;
  v_tax    bigint;
  v_lines  jsonb;
begin
  select * into m from movement.movement where id = p_movement;
  if not found then raise exception 'NO_SUCH_MOVEMENT' using errcode = 'P0002'; end if;

  if m.type <> 'EXPORT' then
    raise exception 'NOT_A_SALE: only an export produces revenue — a transfer is not a sale'
      using errcode = '23514';
  end if;

  if exists (select 1 from ledger.journal
              where source_kind = 'SALE' and source_id = p_movement::text) then
    return null;                              -- already posted; idempotent
  end if;

  select coalesce(sum(coalesce(l.unit_cost,0) * coalesce(l.qty_dispatched, l.qty_ordered)), 0)
    into v_goods from movement.line l where l.movement_id = p_movement;

  v_tax := m.tax_paise;
  if v_goods = 0 then return null; end if;

  v_lines := jsonb_build_array(
    jsonb_build_object('account','CUSTOMER_RECEIVABLE','debit', v_goods + v_tax,
                       'partner_id', m.partner_id),
    jsonb_build_object('account','REVENUE','credit', v_goods,
                       'location_id', m.source_location_id));

  if v_tax > 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account','GST_OUTPUT_TAX','credit', v_tax));
  end if;

  return ledger.post('SALE', 'Sale on ' || m.ticket_no, v_lines, p_movement::text, null, now());
end $$;

-- Dispatching an export raises the invoice, so it raises the revenue.
create or replace function movement.dispatch_and_invoice(p_movement uuid, p_lines jsonb default null)
returns integer
language plpgsql
security definer
set search_path = movement, platform, public
as $$
-- @no-scope-check: delegates to dispatch_movement, which checks the
-- source location before anything moves.
declare v_qty integer; v_type text;
begin
  select type into v_type from movement.movement where id = p_movement;
  v_qty := movement.dispatch_movement(p_movement, p_lines);
  if v_type = 'EXPORT' then
    perform movement.post_sale_revenue(p_movement);
  end if;
  return v_qty;
end $$;

-- ─────────────── margin ───────────────
--
-- THE PHASE 7 GATE. Gross margin on a dispatched order, computed from
-- the ledger — not from a price list, not from a report that
-- recalculates it, but from the same balanced entries the books are
-- made of.

create or replace function movement.order_margin(p_movement uuid)
returns table (
  ticket_no      text,
  revenue_paise  bigint,
  cogs_paise     bigint,
  margin_paise   bigint,
  margin_pct     numeric(6,2),
  tax_paise      bigint
)
language sql stable
security definer
set search_path = movement, ledger, platform, public
as $$
  -- @no-scope-check: restricted to finance and admin below. Money is
  -- role-restricted, not location-restricted — an operator never sees
  -- margin anywhere (docs/08 §1).
  with guard as (
    select 1 where platform.current_role_name() in ('finance','admin','planner')
  ),
  amounts as (
    select m.ticket_no,
           coalesce(sum(e.credit_paise) filter (where e.account_code = 'REVENUE'), 0)::bigint as revenue,
           coalesce(sum(e.debit_paise)  filter (where e.account_code = 'COGS'), 0)::bigint    as cogs,
           coalesce(sum(e.credit_paise) filter (where e.account_code = 'GST_OUTPUT_TAX'), 0)::bigint as tax
      from movement.movement m
      join ledger.journal j on j.source_id = m.id::text
      join ledger.entry e on e.journal_id = j.id
     where m.id = p_movement
     group by m.ticket_no
  )
  select a.ticket_no, a.revenue, a.cogs,
         (a.revenue - a.cogs)::bigint,
         case when a.revenue > 0
              then round((a.revenue - a.cogs) * 100.0 / a.revenue, 2)
              else null end,
         a.tax
    from amounts a, guard;
$$;

comment on function movement.order_margin is
  'Gross margin from the accounting entries themselves. If this disagrees with a hand calculation, the books are wrong — not the report.';
