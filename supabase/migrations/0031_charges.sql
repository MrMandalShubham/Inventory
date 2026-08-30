-- ============================================================
-- 0031 — Recording charges, and two definer functions that were
--        not carrying their scope note
--
-- ── There was no way to enter the freight ──
--
-- movement.movement has no UPDATE policy. That is deliberate: a
-- movement changes only by living through its lifecycle, never by
-- somebody writing to a column. But 0027 added freight_paise with no
-- function to set it, so the field was unreachable — and a charge
-- nobody can record is a charge that silently reads as zero, which is
-- the exact failure landed cost exists to prevent.
--
-- ── Charges close when the goods land ──
--
-- The supplier's invoice usually arrives with, or just before, the
-- delivery. So charges may be entered right up until the receipt is
-- counted, and never afterwards: once landed cost is fixed it has
-- already flowed into the weighted average and into the books, and
-- editing it behind them would make the two disagree. A charge that
-- turns up late is a new document, not a correction to an old one.
-- ============================================================

create or replace function movement.set_charges(
  p_id                  uuid,
  p_freight_paise       bigint default null,
  p_other_charges_paise bigint default null,
  p_tax_paise           bigint default null
) returns void
language plpgsql
security definer
set search_path = movement, platform, public, extensions
as $$
declare
  m       movement.movement%rowtype;
  v_scope uuid;
begin
  select * into m from movement.movement where id = p_id;
  if not found then raise exception 'NO_SUCH_MOVEMENT' using errcode = 'P0002'; end if;

  -- An import has no source of ours; an export has no destination.
  -- Check whichever end we actually own.
  v_scope := coalesce(m.dest_location_id, m.source_location_id);
  if not platform.can_access_location(v_scope) then
    raise exception 'FORBIDDEN_LOCATION: caller may not price that movement'
      using errcode = '42501';
  end if;

  if platform.current_role_name() not in ('planner','finance','admin') then
    raise exception 'FORBIDDEN_ROLE: % may not set charges', platform.current_role_name()
      using errcode = '42501';
  end if;

  -- Once the goods have been counted in, landed cost is fixed and has
  -- already reached the average and the books.
  if m.received_at is not null or m.status in ('CLOSED','RECONCILED','CANCELLED') then
    raise exception 'COST_ALREADY_FIXED: % was costed when it was received; raise a new document instead',
      m.ticket_no using errcode = '23514';
  end if;

  if coalesce(p_freight_paise, 0) < 0
     or coalesce(p_other_charges_paise, 0) < 0
     or coalesce(p_tax_paise, 0) < 0 then
    raise exception 'NEGATIVE_CHARGE: a charge is not a discount' using errcode = '23514';
  end if;

  update movement.movement
     set freight_paise       = coalesce(p_freight_paise,       freight_paise),
         other_charges_paise = coalesce(p_other_charges_paise, other_charges_paise),
         tax_paise           = coalesce(p_tax_paise,           tax_paise)
   where id = p_id;
end $$;

comment on function movement.set_charges is
  'Freight, charges and tax on a movement. Refused once the goods have been received, because landed cost is fixed at that moment.';

-- ─────────────── the two missing scope notes ───────────────
--
-- Both were caught by supabase/checks/definer-scope.sql, which is
-- exactly what it is for. Neither is a hole — but "it is fine, I
-- checked" has to be written down where the next person reads it,
-- otherwise the guard is training people to ignore it.

create or replace function ledger.post_for_stock_movement()
returns trigger
language plpgsql
security definer
set search_path = ledger, stock, movement, platform, public, extensions
as $$
-- @no-scope-check: a trigger on stock.ledger. Nothing reaches this
-- function without having already passed stock.post_movement(), which
-- checks the location before a single row moves. Re-checking here
-- would mean a movement could succeed while its accounting entry
-- refused — stock and books apart, which 0028 exists to prevent.
declare
  v_value   bigint;
  v_qty     integer := abs(new.qty_delta);
  v_partner uuid;
  v_lines   jsonb;
  v_transit uuid;
begin
  v_value := coalesce(new.total_value, 0);
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

create or replace function movement.post_sale_revenue(p_movement uuid)
returns uuid
language plpgsql
security definer
set search_path = movement, ledger, platform, public, extensions
as $$
-- @no-scope-check: reached only from dispatch_movement(), which has
-- already checked the source location. Called directly it refuses
-- anything that is not an EXPORT, and posts figures taken from the
-- movement's own lines rather than from the caller.
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
