-- ============================================================
-- 0051 — Categories have to keep existing
--
-- 0049 backfilled catalog.category from the distinct category text on
-- existing products. On a database that already had products that
-- works. On a FRESH one — migrate, then seed — there are no products
-- when the migration runs, so it backfills nothing, and every product
-- created afterwards names a category that does not exist.
--
-- A one-shot backfill for data that keeps arriving is not a backfill,
-- it is a coincidence that held once.
--
-- Same shape as the slug trigger beside it: the product declares a
-- category by name, and the category is created if it is new. The
-- storefront gets an id it can filter and link by without anybody
-- maintaining a second list.
-- ============================================================

create or replace function catalog.ensure_category()
returns trigger
language plpgsql
security definer
set search_path = catalog, public, extensions
as $$
-- @no-scope-check: the catalogue is global (docs/09). This runs as a
-- trigger on a row the caller was already allowed to write.
declare v_slug text;
begin
  if new.category is null or btrim(new.category) = '' then
    new.category_id := null;
    return new;
  end if;

  v_slug := catalog.slugify(new.category);
  if v_slug is null then
    new.category_id := null;
    return new;
  end if;

  -- The display name comes from the FIRST product to use it and is
  -- then left alone: renaming a category is a deliberate act on the
  -- category, not a side effect of typing it differently on one
  -- product.
  insert into catalog.category (id, name, position)
       values (v_slug, new.category,
               coalesce((select max(position) + 1 from catalog.category), 1))
  on conflict (id) do nothing;

  new.category_id := v_slug;
  return new;
end $$;

create trigger product_category
  before insert or update of category on catalog.product
  for each row execute function catalog.ensure_category();

-- Catch up anything that already exists.
update catalog.product set category = category
 where category is not null and category_id is null;
