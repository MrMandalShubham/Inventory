-- ============================================================
-- 0032 — Opening stock can state what it is worth
--
-- import_opening_balances() posts through the ledger already, which
-- is right. But it posts with no unit cost, so every opening line
-- lands at a weighted average of zero — and because migration 0029
-- deliberately posts nothing for a zero-value movement, the entire
-- opening stock of the business enters the system invisible to the
-- accounts.
--
-- That is the correct behaviour when the cost genuinely is not known:
-- booking a phantom zero-value asset would be worse than booking
-- nothing. But it must be possible to say what the stock cost when
-- you do know, and until now it was not.
--
-- Opening stock with a cost posts DR INVENTORY / CR STOCK_ADJUSTMENT.
-- The adjustment account is the honest place for it: stock that
-- appeared without a purchase document is exactly what an auditor
-- should be able to find in one query.
-- ============================================================

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
set search_path = stock, catalog, platform, public
as $$
declare
  r          jsonb;
  i          integer := 0;
  v_product  uuid;
  v_location uuid;
  v_qty      integer;
  v_current  integer;
  v_cost     bigint;
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

      -- The guard. RLS does not apply inside a definer function.
      if not platform.can_access_location(v_location) then
        raise exception 'FORBIDDEN_LOCATION: caller may not open stock at %', r ->> 'location_code'
          using errcode = '42501';
      end if;

      v_qty := (r ->> 'on_hand')::integer;
      if v_qty is null or v_qty < 0 then
        raise exception 'on_hand must be zero or greater, got "%"', r ->> 'on_hand';
      end if;

      -- Optional, and absent means absent — not zero. A line with no
      -- stated cost enters at no value and posts nothing to the books,
      -- which is the truth about it.
      v_cost := nullif(r ->> 'unit_cost_paise', '')::bigint;
      if v_cost is not null and v_cost < 0 then
        raise exception 'unit_cost_paise must be zero or greater, got "%"', r ->> 'unit_cost_paise';
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
          'opening balance import', null, v_cost);
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

comment on function stock.import_opening_balances is
  'Opening stock, posted as ledger events. unit_cost_paise is optional; omitting it means the cost is not known, and the line enters at no value rather than at a false zero.';
