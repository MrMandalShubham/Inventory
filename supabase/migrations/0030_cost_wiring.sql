-- ============================================================
-- 0030 — Wiring cost into the movement lifecycle
--
-- Two faults that only appear once there is money in the system.
--
-- ── 1. Receipts ignored the freight ──
--
-- receive_movement() posted at movement.line.unit_cost — the invoice
-- price — while landed_unit_cost sat beside it, calculated and
-- unused. Stock would have been valued at goods-only, and every
-- margin below it overstated by exactly the freight.
--
-- ── 2. A sale would have booked its SELLING price as COGS ──
--
-- dispatch_movement() passed l.unit_cost into the stock movement. On
-- an export that column holds what the customer pays. COGS would have
-- equalled revenue and every gross margin in the business would have
-- been zero — which is at least obvious. The dangerous version is a
-- part-priced order, where it is merely wrong.
--
-- Outbound movements now pass NULL and leave at the weighted average,
-- which is what "weighted average" means. The line's unit_cost stays
-- what it always was: the price on the invoice, for the revenue leg.
--
-- ── 3. Transfers must carry their value across ──
--
-- The transit legs need the source's average passed explicitly.
-- Letting them default would value stock entering transit at the
-- transit line's own average, which starts at zero — and value would
-- silently evaporate somewhere between two shops.
-- ============================================================

create or replace function movement.dispatch_movement(
  p_id    uuid,
  p_lines jsonb default null
) returns integer
language plpgsql security definer
set search_path = movement, stock, catalog, platform, public
as $$
declare
  m       movement.movement%rowtype;
  l       record;
  v_qty   integer;
  v_total integer := 0;
  v_doc   text;
  v_wac   numeric(18,6);
begin
  m := movement.assert_status(p_id, array['APPROVED','PICKED']);

  if m.type = 'IMPORT' then
    raise exception 'NOT_DISPATCHABLE: an import arrives, we do not send it'
      using errcode = '23514';
  end if;

  if not platform.can_access_location(m.source_location_id) then
    raise exception 'FORBIDDEN_LOCATION: caller may not dispatch from that location'
      using errcode = '42501';
  end if;

  for l in select * from movement.line where movement_id = p_id loop
    v_qty := coalesce(
      (select (e ->> 'qty')::integer from jsonb_array_elements(coalesce(p_lines,'[]'::jsonb)) e
        where (e ->> 'line_id')::uuid = l.id),
      l.qty_ordered);

    if v_qty < 0 or v_qty > l.qty_ordered then
      raise exception 'BAD_DISPATCH_QTY: % is not between 0 and the % ordered', v_qty, l.qty_ordered
        using errcode = '23514';
    end if;

    update movement.line set qty_dispatched = v_qty where id = l.id;
    if v_qty = 0 then continue; end if;

    -- What these units are actually worth, before they leave.
    select weighted_avg_cost into v_wac
      from stock.balance
     where product_id = l.product_id and location_id = m.source_location_id
       and batch_id is not distinct from l.batch_id;
    v_wac := coalesce(v_wac, 0);

    -- NULL unit cost: the goods leave at the weighted average. Passing
    -- l.unit_cost here would book the SELLING price as cost of sale.
    perform stock.post_movement(
      l.product_id, m.source_location_id, -v_qty,
      case when m.type = 'TRANSFER' then 'TRANSFER_OUT' else 'ISSUE' end,
      l.batch_id, 'dispatched on ' || m.ticket_no, p_id, null);

    -- The transit leg carries the source's value across explicitly.
    if m.type = 'TRANSFER' then
      perform stock.post_movement(
        l.product_id, movement.transit_location(), v_qty, 'TRANSFER_IN',
        l.batch_id, 'in transit on ' || m.ticket_no, p_id, round(v_wac)::bigint);
    end if;

    v_total := v_total + v_qty;
  end loop;

  v_doc := case m.type when 'TRANSFER' then 'DELIVERY_CHALLAN' else 'TAX_INVOICE' end;

  insert into movement.document (movement_id, kind, doc_no, goods_value_paise, tax_paise, issued_by)
  select p_id, v_doc,
         platform.next_number('doc_' || lower(v_doc),
           case v_doc when 'DELIVERY_CHALLAN' then 'DC' else 'INV' end),
         sum(coalesce(unit_cost,0) * coalesce(qty_dispatched,0)),
         -- INVARIANT 8: a challan carries no tax, because you cannot
         -- sell to yourself.
         case when v_doc = 'DELIVERY_CHALLAN' then null else m.tax_paise end,
         platform.current_user_id()
    from movement.line where movement_id = p_id;

  update movement.movement
     set status = case when m.type = 'TRANSFER' then 'IN_TRANSIT' else 'CLOSED' end,
         dispatched_by = platform.current_user_id(),
         dispatched_at = now(),
         closed_at = case when m.type = 'TRANSFER' then null else now() end
   where id = p_id;

  -- An export raises an invoice, so it raises the revenue with it.
  if m.type = 'EXPORT' then
    perform movement.post_sale_revenue(p_id);
  end if;

  return v_total;
end $$;

-- ─────────────── receipt at landed cost ───────────────

create or replace function movement.receive_movement(
  p_id    uuid,
  p_lines jsonb
) returns text
language plpgsql security definer
set search_path = movement, stock, catalog, platform, public
as $$
declare
  m           movement.movement%rowtype;
  l           record;
  e           jsonb;
  v_recv      integer;
  v_rej       integer;
  v_reason    text;
  v_variance  integer := 0;
  v_status    text;
  v_cost      bigint;
  v_transit   numeric(18,6);
begin
  m := movement.assert_status(p_id, array['IN_TRANSIT','APPROVED']);

  if m.type = 'EXPORT' then
    raise exception 'NOT_RECEIVABLE: an export leaves the business; we do not receive it'
      using errcode = '23514';
  end if;
  if m.type = 'TRANSFER' and m.status <> 'IN_TRANSIT' then
    raise exception 'NOT_DISPATCHED: a transfer must be dispatched before it can arrive'
      using errcode = '23514';
  end if;

  if not platform.can_access_location(m.dest_location_id) then
    raise exception 'FORBIDDEN_LOCATION: caller may not receive at that location'
      using errcode = '42501';
  end if;

  -- Record the counts first, so the charge allocation is spread over
  -- what actually turned up rather than what was ordered.
  for l in select * from movement.line where movement_id = p_id loop
    select el into e from jsonb_array_elements(p_lines) el
     where (el ->> 'line_id')::uuid = l.id;

    if e is null then
      raise exception 'LINE_NOT_COUNTED: every line must be counted on arrival, % was not', l.id
        using errcode = '23514';
    end if;

    v_recv   := (e ->> 'qty_received')::integer;
    v_rej    := coalesce((e ->> 'qty_rejected')::integer, 0);
    v_reason := nullif(btrim(coalesce(e ->> 'reject_reason','')), '');

    if v_recv is null or v_recv < 0 then
      raise exception 'BAD_RECEIVED_QTY: %', e ->> 'qty_received' using errcode = '23514';
    end if;
    if v_rej > v_recv then
      raise exception 'REJECTED_EXCEEDS_RECEIVED: cannot reject % of % received', v_rej, v_recv
        using errcode = '23514';
    end if;
    if v_rej > 0 and v_reason is null then
      raise exception 'REJECT_REASON_REQUIRED: % unit(s) rejected with no reason given', v_rej
        using errcode = '23514';
    end if;

    update movement.line
       set qty_received = v_recv, qty_rejected = v_rej, reject_reason = v_reason,
           qty_dispatched = coalesce(qty_dispatched, v_recv)
     where id = l.id;
  end loop;

  -- LANDED COST, FIXED HERE. Freight and charges spread across the
  -- lines that actually arrived. Everything downstream inherits it.
  perform movement.allocate_landed_cost(p_id);

  for l in select * from movement.line where movement_id = p_id loop
    v_recv := coalesce(l.qty_received, 0);
    v_rej  := coalesce(l.qty_rejected, 0);

    if m.type = 'TRANSFER' then
      -- A transfer moves value at what it left with, not at a price.
      select weighted_avg_cost into v_transit
        from stock.balance
       where product_id = l.product_id and location_id = movement.transit_location()
         and batch_id is not distinct from l.batch_id;
      v_cost := round(coalesce(v_transit, 0))::bigint;
    else
      v_cost := round(coalesce(l.landed_unit_cost, l.unit_cost, 0))::bigint;
    end if;

    if m.type = 'TRANSFER' and v_recv > 0 then
      perform stock.post_movement(
        l.product_id, movement.transit_location(), -v_recv, 'TRANSFER_OUT',
        l.batch_id, 'arrived on ' || m.ticket_no, p_id, v_cost);
    end if;

    if v_recv - v_rej > 0 then
      perform stock.post_movement(
        l.product_id, m.dest_location_id, v_recv - v_rej,
        case when m.type = 'TRANSFER' then 'TRANSFER_IN' else 'RECEIPT' end,
        l.batch_id, 'received on ' || m.ticket_no, p_id, nullif(v_cost, 0));
    end if;

    if v_rej > 0 then
      perform stock.post_movement(
        l.product_id, m.dest_location_id, v_rej,
        case when m.type = 'TRANSFER' then 'TRANSFER_IN' else 'RECEIPT' end,
        l.batch_id, 'rejected on arrival: ' || l.reject_reason, p_id, nullif(v_cost, 0));

      update stock.balance
         set damaged = damaged + v_rej
       where product_id = l.product_id
         and location_id = m.dest_location_id
         and batch_id is not distinct from l.batch_id;
    end if;

    v_variance := v_variance
                + abs(coalesce(l.qty_dispatched, v_recv) - v_recv)
                + v_rej;
  end loop;

  v_status := case when v_variance = 0 then 'RECONCILED' else 'DISCREPANCY' end;

  update movement.movement
     set status = v_status, received_by = platform.current_user_id(), received_at = now()
   where id = p_id;

  if v_status = 'RECONCILED' then
    update movement.movement set status = 'CLOSED', closed_at = now() where id = p_id;
    return 'CLOSED';
  end if;

  return 'DISCREPANCY';
end $$;
