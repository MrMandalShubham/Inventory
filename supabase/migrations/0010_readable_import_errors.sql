-- ============================================================
-- 0010 — Readable import errors
--
-- The Phase 1 working UI showed the import report saying:
--
--   new row for relation "product" violates check constraint
--   "shelf_life_needs_batch"
--
-- That is accurate and useless. The error report is the entire
-- reason the import screen exists — a person with a spreadsheet has
-- to be able to read a line, understand it, fix that row, and
-- re-run. A constraint name is not a sentence they can act on.
--
-- Constraint names are translated here rather than in the UI so
-- every caller gets the same wording: the CSV screen, the product
-- form, and the API in Phase 4.
--
-- Forward-only: this replaces the function body, it does not edit
-- migration 0008.
-- ============================================================

create or replace function catalog.explain_error(
  p_constraint text,
  p_fallback   text
) returns text
language sql immutable as $$
  select case p_constraint
    when 'shelf_life_needs_batch'
      then 'a product with a shelf life must be tracked by batch or serial, or the expiry has nowhere to live'
    when 'product_sku_code_key'
      then 'that product code already belongs to another product'
    when 'product_barcode_barcode_key'
      then 'that barcode already belongs to another product'
    when 'product_tax_rate_check'
      then 'tax rate must be between 0 and 100'
    when 'product_shelf_life_days_check'
      then 'shelf life must be a positive number of days'
    when 'product_min_order_qty_check'
      then 'minimum order quantity must be greater than zero'
    when 'product_tracking_mode_check'
      then 'tracking must be one of NONE, BATCH or SERIAL'
    when 'on_hand_non_negative'
      then 'stock cannot go below zero'
    when 'claims_within_stock'
      then 'more stock is reserved or damaged than is on hand'
    else coalesce(p_fallback, 'the row was refused')
  end
$$;

create or replace function catalog.import_products(p_rows jsonb)
returns table (
  row_number integer,
  sku_code   text,
  status     text,
  message    text
)
language plpgsql
security definer
set search_path = catalog, platform, public, extensions
as $$
-- @no-scope-check: the catalogue is global by invariant 3 and has no
-- location dimension. The role check below is the whole guard.
declare
  r            jsonb;
  i            integer := 0;
  v_uom        uuid;
  v_sku        text;
  v_id         uuid;
  v_exists     boolean;
  v_constraint text;
begin
  if platform.current_role_name() not in ('planner','admin') then
    raise exception 'FORBIDDEN_ROLE: % may not import products', platform.current_role_name()
      using errcode = '42501';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      if coalesce(btrim(r ->> 'name'), '') = '' then
        raise exception 'a name is required';
      end if;

      select id into v_uom from catalog.uom
       where code = upper(coalesce(r ->> 'base_uom', 'PCS'));
      if v_uom is null then
        raise exception 'unknown unit of measure "%" — use one of the codes in the unit list',
          r ->> 'base_uom';
      end if;

      v_sku    := nullif(btrim(coalesce(r ->> 'sku_code', '')), '');
      v_exists := v_sku is not null
                  and exists (select 1 from catalog.product where product.sku_code = v_sku);

      if v_exists then
        update catalog.product p set
          name            = r ->> 'name',
          description     = r ->> 'description',
          category        = r ->> 'category',
          base_uom_id     = v_uom,
          tracking_mode   = upper(coalesce(r ->> 'tracking_mode', p.tracking_mode)),
          is_weighed      = coalesce((r ->> 'is_weighed')::boolean, p.is_weighed),
          hsn_code        = coalesce(r ->> 'hsn_code', p.hsn_code),
          tax_rate        = coalesce((r ->> 'tax_rate')::numeric, p.tax_rate),
          shelf_life_days = coalesce((r ->> 'shelf_life_days')::integer, p.shelf_life_days),
          updated_at      = now()
        where p.sku_code = v_sku
        returning p.id, p.sku_code into v_id, v_sku;

        row_number := i; sku_code := v_sku; status := 'UPDATED'; message := null;
      else
        insert into catalog.product
          (sku_code, name, description, category, base_uom_id,
           tracking_mode, is_weighed, hsn_code, tax_rate, shelf_life_days)
        values
          (v_sku, r ->> 'name', r ->> 'description', r ->> 'category', v_uom,
           upper(coalesce(r ->> 'tracking_mode', 'NONE')),
           coalesce((r ->> 'is_weighed')::boolean, false),
           r ->> 'hsn_code',
           (r ->> 'tax_rate')::numeric,
           (r ->> 'shelf_life_days')::integer)
        returning product.id, product.sku_code into v_id, v_sku;

        row_number := i; sku_code := v_sku; status := 'CREATED'; message := null;
      end if;

      if coalesce(btrim(r ->> 'barcode'), '') <> '' then
        insert into catalog.product_barcode (product_id, barcode, kind, is_primary)
        values (v_id, btrim(r ->> 'barcode'),
                upper(coalesce(r ->> 'barcode_kind', 'EAN')), true)
        on conflict (barcode) do nothing;
      end if;

      return next;

    exception when others then
      -- CONSTRAINT_NAME is empty for a plain RAISE, in which case
      -- explain_error falls through to the message we wrote ourselves.
      get stacked diagnostics v_constraint = constraint_name;

      row_number := i;
      sku_code   := coalesce(nullif(btrim(coalesce(r ->> 'sku_code','')), ''), r ->> 'name');
      status     := 'FAILED';
      message    := catalog.explain_error(v_constraint, sqlerrm);
      return next;
    end;
  end loop;
end $$;
