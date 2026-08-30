-- ============================================================
-- 0033 — Opening stock is not a count variance
--
-- Migration 0029 sent OPENING through the same branch as COUNT and
-- ADJUST, so every gram of stock the business started with landed in
-- STOCK_ADJUSTMENT — an EXPENSE account. Two consequences, both bad:
--
--   • The finance screen reported the entire opening inventory as
--     "value that went somewhere nobody sold", which is the exact
--     opposite of what it is.
--
--   • The trial balance showed a ₹3.4 lakh expense that never
--     happened, so the profit and loss was meaningless from the first
--     day the system was used.
--
-- Opening stock is not a loss and not a gain. It is the balance the
-- business already had when it started keeping these books, and it
-- belongs in equity — the standard place for it, and the one an
-- accountant will expect to find it.
--
-- STOCK_ADJUSTMENT keeps its real job: count variances and
-- corrections, where a growing balance is a genuine finding.
--
-- ── Rewritten as a table, not a wall of branches ──
--
-- The posting rules are a mapping from a reason to two accounts. 0029
-- wrote that as nested CASE expressions building JSON, which is why
-- OPENING could be filed under "else" without anyone noticing. Naming
-- the two sides makes a wrong one visible.
-- ============================================================

insert into ledger.account (code, name, type, normal_side, by_location, by_partner, note)
values ('OPENING_BALANCE', 'Opening balance', 'EQUITY', 'CREDIT', true, false,
        'Stock the business already had when it began keeping these books. Not a purchase, not a gain — the starting point.')
on conflict (code) do nothing;

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
  v_transit uuid;
  v_in      boolean := new.qty_delta > 0;

  -- The two sides of the entry. INVENTORY is one of them for every
  -- reason there is; v_other is what it moved against.
  v_other   text;
  v_lines   jsonb;

  -- Tags. An account only carries the ones its definition says it
  -- does, so a payable is per-supplier and never per-shelf.
  v_stock   jsonb;
  v_side    jsonb;
begin
  v_value := coalesce(new.total_value, 0);

  -- A movement with no value posts nothing. That is honest: opening
  -- balances loaded before costs are known would otherwise book a
  -- phantom zero-value asset and make the trial balance meaningless.
  if v_value = 0 then return null; end if;

  select id into v_transit from platform.location where code = 'TRANSIT';
  if new.movement_id is not null then
    select partner_id into v_partner from movement.movement where id = new.movement_id;
  end if;

  v_stock := jsonb_build_object('location_id', new.location_id, 'product_id', new.product_id);

  -- ── Which account the stock moved against ──
  --
  -- INVARIANT 8 is the TRANSFER lines: value moves between INVENTORY
  -- accounts through IN_TRANSIT and touches no revenue and no tax
  -- account. You cannot sell to yourself.
  v_other := case new.reason_code
    when 'RECEIPT'      then 'SUPPLIER_PAYABLE'
    when 'ISSUE'        then 'COGS'
    when 'TRANSFER_OUT' then 'INVENTORY_IN_TRANSIT'
    when 'TRANSFER_IN'  then 'INVENTORY_IN_TRANSIT'
    when 'WASTAGE'      then 'WASTAGE'
    when 'RETURN'       then case when v_in then 'COGS' else 'SUPPLIER_PAYABLE' end
    -- Stock the business already had. Equity, not expense — see the
    -- header of this migration for what filing it as expense did.
    when 'OPENING'      then 'OPENING_BALANCE'
    -- COUNT, ADJUST, CORRECTION. A real finding, and the one place an
    -- auditor should look first.
    else 'STOCK_ADJUSTMENT'
  end;

  v_side := case v_other
    when 'SUPPLIER_PAYABLE'    then jsonb_build_object('partner_id', v_partner)
    when 'CUSTOMER_RECEIVABLE' then jsonb_build_object('partner_id', v_partner)
    when 'INVENTORY_IN_TRANSIT' then '{}'::jsonb     -- belongs to nobody, by design
    when 'STOCK_ADJUSTMENT'    then jsonb_build_object('location_id', new.location_id)
    when 'OPENING_BALANCE'     then jsonb_build_object('location_id', new.location_id)
    else v_stock
  end;

  -- Both legs of a transfer's transit hop are the same account, so
  -- the journal is a self-cancelling pair rather than a real entry.
  -- Written out rather than skipped, so every stock row has a journal
  -- and "no journal" always means something went wrong.
  if new.location_id = v_transit then
    v_lines := jsonb_build_array(
      jsonb_build_object('account','INVENTORY_IN_TRANSIT','debit', v_value),
      jsonb_build_object('account','INVENTORY_IN_TRANSIT','credit', v_value));
  elsif v_in then
    -- Stock arriving: inventory up, the other side down.
    v_lines := jsonb_build_array(
      jsonb_build_object('account','INVENTORY','debit', v_value) || v_stock,
      jsonb_build_object('account', v_other, 'credit', v_value) || v_side);
  else
    -- Stock leaving: inventory down, the other side up.
    v_lines := jsonb_build_array(
      jsonb_build_object('account', v_other, 'debit', v_value) || v_side,
      jsonb_build_object('account','INVENTORY','credit', v_value) || v_stock);
  end if;

  perform ledger.post(
    'STOCK_MOVEMENT',
    format('%s %s units', new.reason_code, v_qty),
    v_lines,
    new.movement_id::text,
    new.id,
    new.occurred_at);

  return null;
end $$;
