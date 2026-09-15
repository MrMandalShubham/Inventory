-- ============================================================
-- 0053 — The index 0049 forgot
--
-- ── What is wrong ──
--
-- 0049 added `catalog.product.category_id` as a foreign key to the new
-- `catalog.category` table, and created no index on it. Postgres does
-- not create one for a foreign key.
--
-- The storefront's category browse — the second most-used page in a
-- grocery app after the home screen — filters on exactly that column:
--
--   where p.status = 'ACTIVE'
--     and ($2::text is null or p.category_id = $2)
--
-- so every category page is a sequential scan of the whole product
-- table. The catalogue is 5,000 rows today, which is fast enough to
-- hide the problem and not fast enough to stay hidden.
--
-- `product_status_idx (status, category)` looks like it should cover
-- this and does not: `category` is the legacy free-text column 0049
-- replaced, not `category_id`.
--
-- ── Why this shape ──
--
-- (category_id, name) rather than (category_id) alone, because the
-- query that uses it also carries `order by p.name`. With the sort
-- column in the index the browse returns in index order and skips the
-- sort step entirely.
--
-- Partial on ACTIVE, because that predicate is in every storefront
-- query and a HIDDEN product is never browsed. It keeps the index to
-- the rows that are actually read.
--
-- ── The other foreign key ──
--
-- catalog.category has no parent and product_image is already covered
-- by product_image_product_idx. This is the only one missing.
-- ============================================================

create index if not exists product_category_browse
  on catalog.product (category_id, name)
  where status = 'ACTIVE';

comment on index catalog.product_category_browse is
  'Storefront category browse: filters category_id, orders by name, both ACTIVE-only. Added in 0053 — 0049 created category_id without one.';

-- `product_status_idx (status, category)` is deliberately left alone.
-- It looks redundant now that category filtering has moved to
-- category_id, but the dead-stock and ABC reports still group by the
-- legacy text column with a status filter, which is exactly the shape
-- it serves. Narrowing it is a separate change that wants a measured
-- before and after, not a free rider on an index migration.

analyze catalog.product;
