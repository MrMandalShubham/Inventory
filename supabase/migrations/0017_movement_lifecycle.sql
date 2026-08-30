-- ============================================================
-- 0017 — The movement state machine
--
--   DRAFT → APPROVED → PICKED → DISPATCHED → IN_TRANSIT → RECEIVED
--                                                            │
--                                        ┌───────────────────┴──────────┐
--                                   counts match                 counts differ
--                                        │                             │
--                                   RECONCILED                    DISCREPANCY
--                                        │                    reason + approver
--                                        │                             │
--                                        │                         RESOLVED
--                                        └──────────┬──────────────────┘
--                                                CLOSED
--
--   CANCELLED — available up to DISPATCHED, and never after. Once
--   goods have physically moved the only way back is a reverse
--   movement, which leaves its own trail.
--
-- IMPORT skips picking and dispatch (the goods arrive; we did not
-- send them). EXPORT ends at DISPATCHED (the customer receives them,
-- not us). TRANSFER runs the whole path.
--
-- ── INVARIANT 5 ──
-- There is no path from a variance to CLOSED that skips a reason
-- code, an approver and a posted adjustment. That single rule is
-- what makes a closed ticket mean anything.
-- ============================================================

create or replace function movement.transit_location()
returns uuid language sql stable as $$
  select id from platform.location where code = 'TRANSIT'
$$;

create or replace function movement.assert_status(p_id uuid, p_expected text[])
returns movement.movement
language plpgsql as $$
declare m movement.movement%rowtype;
begin
  select * into m from movement.movement where id = p_id;
  if not found then
    raise exception 'NO_SUCH_MOVEMENT' using errcode = 'P0002';
  end if;
  if not (m.status = any (p_expected)) then
    raise exception 'WRONG_STATUS: ticket % is %, expected one of %',
      m.ticket_no, m.status, array_to_string(p_expected, ', ')
      using errcode = '23514';
  end if;
  return m;
end $$;

-- ─────────────────────── raise a ticket ───────────────────────

create or replace function movement.create_movement(
  p_type      text,
  p_source    uuid,
  p_dest      uuid,
  p_partner   uuid,
  p_lines     jsonb,              -- [{product_id, qty, batch_id?, unit_cost?}]
  p_note      text default null,
  p_expected  timestamptz default null
) returns uuid
language plpgsql security definer
set search_path = movement, stock, catalog, platform, public
as $$
declare
  v_id     uuid;
  v_prefix text;
  r        jsonb;
begin
  -- Role first, deliberately. "You are an operator and may not raise
  -- movements" is a more useful refusal than "you cannot reach that
  -- location", and it does not depend on which locations happen to
  -- be named in the request.
  if platform.current_role_name() not in ('shop_manager','planner','admin') then
    raise exception 'FORBIDDEN_ROLE: % may not raise a movement', platform.current_role_name()
      using errcode = '42501';
  end if;

  -- Then the caller must hold whichever end of this movement they own.
  if p_source is not null and not platform.can_access_location(p_source) then
    raise exception 'FORBIDDEN_LOCATION: caller may not dispatch from that location'
      using errcode = '42501';
  end if;
  if p_dest is not null and not platform.can_access_location(p_dest) then
    raise exception 'FORBIDDEN_LOCATION: caller may not receive at that location'
      using errcode = '42501';
  end if;

  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    raise exception 'NO_LINES: a movement of nothing is not a movement' using errcode = '23514';
  end if;

  v_prefix := case upper(p_type) when 'TRANSFER' then 'TRF'
                                 when 'IMPORT'   then 'IMP'
                                 else 'EXP' end;

  insert into movement.movement
    (ticket_no, type, source_location_id, dest_location_id, partner_id,
     note, expected_at, raised_by)
  values
    (platform.next_number('movement_' || lower(v_prefix), v_prefix),
     upper(p_type), p_source, p_dest, p_partner, p_note, p_expected,
     platform.current_user_id())
  returning id into v_id;

  for r in select * from jsonb_array_elements(p_lines) loop
    insert into movement.line (movement_id, product_id, batch_id, qty_ordered, unit_cost)
    values (v_id,
            (r ->> 'product_id')::uuid,
            nullif(r ->> 'batch_id','')::uuid,
            (r ->> 'qty')::integer,
            nullif(r ->> 'unit_cost','')::bigint);
  end loop;

  return v_id;
end $$;

-- ─────────────────────── approve ───────────────────────

create or replace function movement.approve_movement(p_id uuid)
returns void
language plpgsql security definer
set search_path = movement, platform, public
as $$
declare m movement.movement%rowtype;
begin
  m := movement.assert_status(p_id, array['DRAFT']);

  if not (platform.can_access_location(coalesce(m.source_location_id, m.dest_location_id))) then
    raise exception 'FORBIDDEN_LOCATION' using errcode = '42501';
  end if;

  if platform.current_role_name() not in ('shop_manager','planner','admin') then
    raise exception 'FORBIDDEN_ROLE: % may not approve a movement', platform.current_role_name()
      using errcode = '42501';
  end if;

  -- Nobody approves their own request.
  if m.raised_by = platform.current_user_id() then
    raise exception 'SELF_APPROVAL: the person who raised a movement may not approve it'
      using errcode = '42501';
  end if;

  update movement.movement
     set status = 'APPROVED', approved_by = platform.current_user_id(), approved_at = now()
   where id = p_id;
end $$;

-- ─────────────────────── dispatch ───────────────────────
--
-- Stock leaves the source and enters TRANSIT. Two ledger entries,
-- one transaction: the units are never in both places and never in
-- neither.

create or replace function movement.dispatch_movement(
  p_id    uuid,
  p_lines jsonb default null      -- [{line_id, qty}] — defaults to ordered
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

    -- Out of the source...
    perform stock.post_movement(
      l.product_id, m.source_location_id, -v_qty,
      case when m.type = 'TRANSFER' then 'TRANSFER_OUT' else 'ISSUE' end,
      l.batch_id, 'dispatched on ' || m.ticket_no, p_id, l.unit_cost);

    -- ...and into transit, but only for an internal transfer. An
    -- export leaves the business entirely; there is nothing of ours
    -- left in transit to account for.
    if m.type = 'TRANSFER' then
      perform stock.post_movement(
        l.product_id, movement.transit_location(), v_qty, 'TRANSFER_IN',
        l.batch_id, 'in transit on ' || m.ticket_no, p_id, l.unit_cost);
    end if;

    v_total := v_total + v_qty;
  end loop;

  -- INVARIANT 8. A transfer produces a delivery challan and no tax;
  -- only a movement to an outside party produces a tax invoice.
  v_doc := case m.type when 'TRANSFER' then 'DELIVERY_CHALLAN' else 'TAX_INVOICE' end;

  insert into movement.document (movement_id, kind, doc_no, goods_value_paise, tax_paise, issued_by)
  select p_id, v_doc,
         platform.next_number('doc_' || lower(v_doc),
           case v_doc when 'DELIVERY_CHALLAN' then 'DC' else 'INV' end),
         sum(coalesce(unit_cost,0) * coalesce(qty_dispatched,0)),
         case when v_doc = 'DELIVERY_CHALLAN' then null else 0 end,
         platform.current_user_id()
    from movement.line where movement_id = p_id;

  update movement.movement
     set status = case when m.type = 'TRANSFER' then 'IN_TRANSIT' else 'CLOSED' end,
         dispatched_by = platform.current_user_id(),
         dispatched_at = now(),
         closed_at = case when m.type = 'TRANSFER' then null else now() end
   where id = p_id;

  return v_total;
end $$;

-- ─────────────────────── receive ───────────────────────

create or replace function movement.receive_movement(
  p_id    uuid,
  p_lines jsonb        -- [{line_id, qty_received, qty_rejected?, reject_reason?}]
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
    -- Every rejected unit carries a reason. Without one, "3 rejected"
    -- is a number nobody can act on or dispute.
    if v_rej > 0 and v_reason is null then
      raise exception 'REJECT_REASON_REQUIRED: % unit(s) rejected with no reason given', v_rej
        using errcode = '23514';
    end if;

    update movement.line
       set qty_received = v_recv, qty_rejected = v_rej, reject_reason = v_reason,
           -- An import was never dispatched by us, so "lost in
           -- transit" is meaningless: what arrived is what there is.
           qty_dispatched = coalesce(qty_dispatched, v_recv)
     where id = l.id;

    -- Out of transit (transfers only — an import was never in ours).
    if m.type = 'TRANSFER' and v_recv > 0 then
      perform stock.post_movement(
        l.product_id, movement.transit_location(), -v_recv, 'TRANSFER_OUT',
        l.batch_id, 'arrived on ' || m.ticket_no, p_id, l.unit_cost);
    end if;

    -- Accepted units join usable stock.
    if v_recv - v_rej > 0 then
      perform stock.post_movement(
        l.product_id, m.dest_location_id, v_recv - v_rej,
        case when m.type = 'TRANSFER' then 'TRANSFER_IN' else 'RECEIPT' end,
        l.batch_id, 'received on ' || m.ticket_no, p_id, l.unit_cost);
    end if;

    -- Rejected units physically arrived but are not sellable. They
    -- go on the shelf as damaged so the shelf count stays true.
    if v_rej > 0 then
      perform stock.post_movement(
        l.product_id, m.dest_location_id, v_rej,
        case when m.type = 'TRANSFER' then 'TRANSFER_IN' else 'RECEIPT' end,
        l.batch_id, 'rejected on arrival: ' || v_reason, p_id, l.unit_cost);

      update stock.balance
         set damaged = damaged + v_rej
       where product_id = l.product_id
         and location_id = m.dest_location_id
         and batch_id is not distinct from l.batch_id;
    end if;

    v_variance := v_variance + abs(coalesce(l.qty_dispatched, v_recv) - v_recv) + v_rej;
  end loop;

  v_status := case when v_variance = 0 then 'RECONCILED' else 'DISCREPANCY' end;

  update movement.movement
     set status = v_status, received_by = platform.current_user_id(), received_at = now()
   where id = p_id;

  -- Clean arrivals close themselves. Nobody has to do anything.
  if v_status = 'RECONCILED' then
    update movement.movement set status = 'CLOSED', closed_at = now() where id = p_id;
    return 'CLOSED';
  end if;

  return 'DISCREPANCY';
end $$;

-- ─────────────────── resolve a discrepancy ───────────────────
--
-- The only route from a variance to CLOSED.

create or replace function movement.resolve_discrepancy(
  p_id uuid,
  p_reason text
) returns integer
language plpgsql security definer
set search_path = movement, stock, catalog, platform, public
as $$
declare
  m      movement.movement%rowtype;
  l      record;
  v_lost integer;
  v_written integer := 0;
begin
  m := movement.assert_status(p_id, array['DISCREPANCY']);

  if not platform.can_access_location(coalesce(m.dest_location_id, m.source_location_id)) then
    raise exception 'FORBIDDEN_LOCATION' using errcode = '42501';
  end if;

  if platform.current_role_name() not in ('shop_manager','planner','admin') then
    raise exception 'FORBIDDEN_ROLE: % may not resolve a discrepancy', platform.current_role_name()
      using errcode = '42501';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'REASON_REQUIRED: a discrepancy closed without a reason explains nothing'
      using errcode = '23514';
  end if;

  -- The person who received the goods does not get to explain the
  -- shortage on their own.
  if m.received_by = platform.current_user_id() then
    raise exception 'SELF_APPROVAL: the receiver may not approve their own variance'
      using errcode = '42501';
  end if;

  for l in select * from movement.line where movement_id = p_id loop
    v_lost := coalesce(l.qty_dispatched, 0) - coalesce(l.qty_received, 0);
    if v_lost > 0 then
      -- The units left the source and never arrived. They are still
      -- sitting in TRANSIT, which is exactly why the transit balance
      -- is not yet empty. Writing them off there is what empties it.
      perform stock.post_movement(
        l.product_id, movement.transit_location(), -v_lost, 'WASTAGE',
        l.batch_id, 'lost in transit on ' || m.ticket_no || ': ' || p_reason, p_id);
      update movement.line set loss_reason = p_reason where id = l.id;
      v_written := v_written + v_lost;
    end if;
  end loop;

  update movement.movement
     set status = 'CLOSED', resolved_by = platform.current_user_id(),
         resolved_at = now(), closed_at = now()
   where id = p_id;

  return v_written;
end $$;

-- ─────────────────────── cancel ───────────────────────

create or replace function movement.cancel_movement(p_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = movement, platform, public
as $$
declare m movement.movement%rowtype;
begin
  m := movement.assert_status(p_id, array['DRAFT','APPROVED','PICKED']);

  if not platform.can_access_location(coalesce(m.source_location_id, m.dest_location_id)) then
    raise exception 'FORBIDDEN_LOCATION' using errcode = '42501';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'REASON_REQUIRED' using errcode = '23514';
  end if;

  update movement.movement
     set status = 'CANCELLED', cancel_reason = p_reason, closed_at = now()
   where id = p_id;
end $$;

-- ─────────────── the health check from docs/07 §3.2 ───────────────

/** Transit should hold exactly what open transfers say is on the road. */
create or replace function movement.verify_transit()
returns table (product_id uuid, transit_balance integer, open_tickets integer)
language sql stable
security definer
set search_path = movement, stock, platform, public
as $$
  -- @no-scope-check: a whole-system integrity check reporting only
  -- discrepancies, like stock.verify_balances().
  select coalesce(t.product_id, o.product_id),
         coalesce(t.on_hand, 0),
         coalesce(o.outstanding, 0)
    from (select product_id, sum(on_hand)::integer as on_hand
            from stock.balance
           where location_id = movement.transit_location()
           group by product_id) t
    full outer join (
      select l.product_id,
             sum(coalesce(l.qty_dispatched,0) - coalesce(l.qty_received,0))::integer as outstanding
        from movement.line l
        join movement.movement m on m.id = l.movement_id
       where m.type = 'TRANSFER' and m.status in ('IN_TRANSIT','DISCREPANCY')
       group by l.product_id) o on o.product_id = t.product_id
   where coalesce(t.on_hand, 0) <> coalesce(o.outstanding, 0);
$$;
