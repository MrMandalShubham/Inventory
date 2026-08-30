-- ============================================================
-- 0008 — Bulk import and search
--
-- No deployment starts without loading thousands of products and a
-- day-one stock position from a spreadsheet. Without this the system
-- cannot be adopted at all, which is why it is Phase 1 and not a
-- nice-to-have somewhere later.
--
-- ── The design point ──
--
-- ONE BAD ROW MUST NOT ABORT THE IMPORT.
--
-- A 5,000-row file will have bad rows — a missing unit, a duplicate
-- barcode, a typo in a number. An all-or-nothing import means the
-- user fixes one row, re-runs, and finds the next one, five thousand
-- times. Each row therefore runs in its own sub-block, and the
-- function returns a line-by-line report of what happened to each.
-- ============================================================

-- ─────────────────────── products ───────────────────────

create or replace function catalog.import_products(p_rows jsonb)
returns table (
  row_number integer,
  sku_code   text,
  status     text,     -- CREATED | UPDATED | FAILED
  message    text
)
language plpgsql
security definer
set search_path = catalog, platform, public, extensions
as $$
-- @no-scope-check: the catalogue is global by invariant 3 and has no
-- location dimension. The role check below is the whole guard.
declare
  r        jsonb;
  i        integer := 0;
  v_uom    uuid;
  v_sku    text;
  v_id     uuid;
  v_exists boolean;
begin
  if platform.current_role_name() not in ('planner','admin') then
    raise exception 'FORBIDDEN_ROLE: % may not import products', platform.current_role_name()
      using errcode = '42501';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      -- Each row gets its own sub-block. An exception here rolls back
      -- this row only; every other row still lands.

      if coalesce(btrim(r ->> 'name'), '') = '' then
        raise exception 'name is required';
      end if;

      select id into v_uom from catalog.uom
       where code = upper(coalesce(r ->> 'base_uom', 'PCS'));
      if v_uom is null then
        raise exception 'unknown unit of measure "%"', r ->> 'base_uom';
      end if;

      v_sku    := nullif(btrim(coalesce(r ->> 'sku_code', '')), '');
      v_exists := v_sku is not null
                  and exists (select 1 from catalog.product where product.sku_code = v_sku);

      if v_exists then
        update catalog.product p set
          name          = r ->> 'name',
          description   = r ->> 'description',
          category      = r ->> 'category',
          base_uom_id   = v_uom,
          tracking_mode = upper(coalesce(r ->> 'tracking_mode', p.tracking_mode)),
          is_weighed    = coalesce((r ->> 'is_weighed')::boolean, p.is_weighed),
          hsn_code      = coalesce(r ->> 'hsn_code', p.hsn_code),
          tax_rate      = coalesce((r ->> 'tax_rate')::numeric, p.tax_rate),
          shelf_life_days = coalesce((r ->> 'shelf_life_days')::integer, p.shelf_life_days),
          updated_at    = now()
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

      -- Optional barcode. A clash is the row's problem, not the file's.
      if coalesce(btrim(r ->> 'barcode'), '') <> '' then
        insert into catalog.product_barcode (product_id, barcode, kind, is_primary)
        values (v_id, btrim(r ->> 'barcode'),
                upper(coalesce(r ->> 'barcode_kind', 'EAN')), true)
        on conflict (barcode) do nothing;
      end if;

      return next;

    exception when others then
      row_number := i;
      sku_code   := coalesce(nullif(btrim(coalesce(r ->> 'sku_code','')), ''), r ->> 'name');
      status     := 'FAILED';
      message    := sqlerrm;
      return next;
    end;
  end loop;
end $$;

-- ─────────────────────── opening balances ───────────────────────
--
-- Unlike the catalogue, this one DOES touch locations — so it checks
-- can_access_location per row, and the definer-scope guard in CI
-- would fail the build if it did not.

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
begin
  if platform.current_role_name() not in ('planner','admin') then
    raise exception 'FORBIDDEN_ROLE: % may not set opening balances', platform.current_role_name()
      using errcode = '42501';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      select id into v_product from catalog.product where product.sku_code = r ->> 'sku_code';
      if v_product is null then
        raise exception 'unknown product "%"', r ->> 'sku_code';
      end if;

      select id into v_location from platform.location where code = r ->> 'location_code';
      if v_location is null then
        raise exception 'unknown location "%"', r ->> 'location_code';
      end if;

      -- The guard. RLS does not apply inside a definer function.
      if not platform.can_access_location(v_location) then
        raise exception 'FORBIDDEN_LOCATION: caller may not open stock at %', r ->> 'location_code'
          using errcode = '42501';
      end if;

      v_qty := (r ->> 'on_hand')::integer;
      if v_qty is null or v_qty < 0 then
        raise exception 'on_hand must be zero or greater, got "%"', r ->> 'on_hand';
      end if;

      insert into stock.balance (product_id, location_id, on_hand)
           values (v_product, v_location, v_qty)
      on conflict (product_id, location_id) do update
          set on_hand = excluded.on_hand, updated_at = now();

      row_number := i; sku_code := r ->> 'sku_code';
      location := r ->> 'location_code'; status := 'OK'; message := null;
      return next;

    exception when others then
      row_number := i; sku_code := r ->> 'sku_code';
      location := r ->> 'location_code'; status := 'FAILED'; message := sqlerrm;
      return next;
    end;
  end loop;
end $$;

-- ─────────────────────── search ───────────────────────
--
-- Two paths, deliberately. An exact match on code or barcode is what
-- a scanner produces and must come first; a fuzzy name match is what
-- a person typing "toor" produces.

create or replace function catalog.search_products(
  p_query text,
  p_limit integer default 25
)
returns table (
  id         uuid,
  sku_code   text,
  name       text,
  category   text,
  match_kind text,
  score      real
)
language sql stable
as $$
  with q as (select btrim(p_query) as term)
  -- exact: barcode or SKU, what a scan produces
  select p.id, p.sku_code, p.name, p.category, 'EXACT'::text, 1.0::real
    from catalog.product p, q
   where p.status = 'ACTIVE'
     and (p.sku_code = q.term
          or exists (select 1 from catalog.product_barcode b
                      where b.product_id = p.id and b.barcode = q.term))

  union all

  -- fuzzy: name, what a person types.
  -- word_similarity (<%), not similarity (%): a short term against a long
  -- name scores far below the whole-string threshold, so "Fruit" would
  -- find nothing in "Product 0421 Fruit & Veg". <% asks the right
  -- question — does the term match a WORD inside the name.
  select p.id, p.sku_code, p.name, p.category, 'NAME'::text,
         word_similarity(q.term, p.name)
    from catalog.product p, q
   where p.status = 'ACTIVE'
     and q.term <% p.name
     and p.sku_code <> q.term

   order by 5 desc, 6 desc
   limit p_limit;
$$;
