-- ============================================================
-- 0054 — Give the lot-tracked stock a lot
--
-- ── The state this fixes ──
--
-- 89 active products are lot-tracked (86 BATCH, 3 SERIAL) and every
-- one of them carries a real `shelf_life_days` — spinach 3 days,
-- bread 4, milk 5. The `shelf_life_needs_batch` constraint requires
-- exactly that pairing, so the flags are not an import accident: they
-- are somebody correctly describing perishable groceries.
--
-- What was missing is the other half. `stock.batch` had zero rows,
-- `stock.serial` had zero rows, and all 445 balance rows carried
-- `batch_id = null`. The stock was loaded by an OPENING movement,
-- which `post_movement` deliberately exempts from the batch rule:
--
--   if v_tracking = 'BATCH' and p_batch is null
--      and v_reason.code <> 'OPENING' then raise BATCH_REQUIRED
--
-- So the goods went in without lots, legitimately — and then could
-- never come out, because `consume_reservation` has no such exemption.
-- Checkout succeeded, the customer paid, the rider delivered, and only
-- then did commit refuse with `batch_required`. Order 7e0cdc64 is the
-- one in the live data: delivered, commit_status `failed`, stock
-- RELEASED, sale never booked.
--
-- This migration closes the gap the way a stock system does when lot
-- tracking is switched on mid-life: it declares one opening lot per
-- product and moves the existing on-hand into it.
--
-- ── Why it goes through the ledger and not through UPDATE ──
--
-- The obvious fix is `update stock.balance set batch_id = …`. It is
-- wrong, and quietly so.
--
-- `stock.rebuild_balances()` and `stock.verify_balances()` both group
-- by `(product_id, location_id, batch_id)`. Move the projection to a
-- lot while the ledger still says null and the two disagree on every
-- line: verify_balances reports 335 discrepancies, and the next
-- rebuild silently recreates the batch-less rows and deletes the lot
-- ones. Phase 2's gate — "the balance table rebuilt from the ledger
-- alone, reproducing every number" — would stop holding.
--
-- So the reclassification is posted as movements, and the ledger and
-- its projection stay the same shape:
--
--   OPENING  −on_hand  at (product, location, null)
--   OPENING  +on_hand  at (product, location, lot)
--
-- Net zero units, net zero value. `OPENING` is direction EITHER, so
-- both legs are legal, and it is the one reason exempt from the batch
-- rule — which is what makes the outbound leg postable at all. No
-- change to post_movement is needed.
--
-- ── The valuation trap ──
--
-- The inbound leg MUST carry the line's existing weighted average.
-- post_movement values an inbound at the stated cost and an inbound
-- with a null cost at the TARGET line's average — and a brand-new lot
-- row has an average of zero. Passing null would move five million
-- units into lots valued at nothing and take the stock valuation to
-- zero for three quarters of the catalogue, with debits and credits
-- still balancing so nothing would complain.
--
-- ── What the expiry dates mean ──
--
-- An opening lot has no real manufacturing date; nobody recorded one.
-- `expiry_date` is therefore an ESTIMATE — today plus the product's
-- shelf life — and the lot number says so. It is better than null,
-- which would exclude this stock from expiry ageing entirely, and it
-- is honest about being a starting point rather than a fact. Real
-- lots arrive with real dates through receiving.
-- ============================================================

do $$
declare
  v_batches  integer;
  v_serials  integer;
  v_blocked  integer;
  v_lot      uuid;
  v_rows     integer := 0;
  v_lots     integer := 0;
  prod       record;
  line       record;
begin
  -- ── 1. Has lot tracking already started? ──
  --
  -- If it has, the assumption this migration rests on is gone and
  -- flattening real lot history would be the worst outcome available.
  select count(*) into v_batches from stock.batch;
  select count(*) into v_serials from stock.serial;

  if v_batches > 0 or v_serials > 0 then
    raise exception
      'REFUSING: % batches and % serials already exist. This migration '
      'assumes none do — lot tracking has started since it was written. '
      'Reconcile by hand rather than declaring opening lots over real ones.',
      v_batches, v_serials;
  end if;

  -- ── 2. Claims ──
  --
  -- post_movement checks the caller's role and location through
  -- auth.jwt(). A migration has no JWT, so current_role_name() returns
  -- '' and can_access_location() returns false — every post would be
  -- refused. Set the claims for this transaction only; `true` is the
  -- is_local flag, so they are gone at COMMIT.
  perform set_config('request.jwt.claims', '{"role":"admin"}', true);

  -- ── 3. Anything we must not touch ──
  --
  -- Moving on_hand out of a line that has stock claimed against it
  -- would violate `claims_within_stock` (reserved + allocated +
  -- damaged <= on_hand). Rather than fail halfway, find them first.
  select count(*) into v_blocked
    from stock.balance b
    join catalog.product p on p.id = b.product_id
   where p.tracking_mode <> 'NONE'
     and b.batch_id is null
     and b.on_hand > 0
     and (b.reserved > 0 or b.allocated > 0 or b.damaged > 0);

  if v_blocked > 0 then
    raise exception
      'REFUSING: % lot-tracked lines have stock reserved, allocated or damaged '
      'against the batch-less row. Let those holds settle (or release them) '
      'and run this again — moving the stock out from under a live claim '
      'would breach claims_within_stock.', v_blocked;
  end if;

  -- ── 4. One opening lot per product, then move the stock into it ──
  --
  -- Per product, not per location: stock.batch is product-scoped and
  -- has no location, because a lot is something a manufacturer made,
  -- not something a shop holds. Each location's on-hand moves into the
  -- same opening lot, which is the honest reading of "this is what was
  -- on the shelves the day we started tracking lots".
  for prod in
    select p.id as product_id, p.sku_code, p.shelf_life_days
      from catalog.product p
     where p.tracking_mode <> 'NONE'
       and exists (select 1 from stock.balance b
                    where b.product_id = p.id and b.batch_id is null and b.on_hand > 0)
     order by p.sku_code
  loop
    insert into stock.batch (product_id, lot_no, mfg_date, expiry_date, status)
    values (
      prod.product_id,
      -- Names itself as an estimate. Anyone reading a picking list or
      -- an expiry report can see this lot was declared, not received.
      'OPEN-' || to_char(current_date, 'YYYYMMDD') || '-' || prod.sku_code,
      null,
      case when prod.shelf_life_days is not null
           then current_date + prod.shelf_life_days
           else null end,
      'ACTIVE')
    returning id into v_lot;

    v_lots := v_lots + 1;

    for line in
      select b.location_id, b.on_hand, b.weighted_avg_cost, b.product_id
        from stock.balance b
       where b.product_id = prod.product_id
         and b.batch_id is null
         and b.on_hand > 0
    loop
      -- Out of the batch-less line, at the average (rule 6: an
      -- outbound passes null and takes the average).
      perform stock.post_movement(
        line.product_id, line.location_id, -line.on_hand, 'OPENING',
        null, 'lot assignment: out of the unlotted opening position',
        null, null, now(),
        'lot-open:' || line.product_id || ':' || line.location_id || ':out');

      -- Into the lot, carrying the SAME unit value across. Null here
      -- would value the new lot at zero.
      perform stock.post_movement(
        line.product_id, line.location_id, line.on_hand, 'OPENING',
        v_lot, 'lot assignment: into opening lot',
        null, round(line.weighted_avg_cost)::bigint, now(),
        'lot-open:' || line.product_id || ':' || line.location_id || ':in');

      v_rows := v_rows + 1;
    end loop;
  end loop;

  raise notice '0054: declared % opening lots across % balance lines', v_lots, v_rows;
end $$;

comment on table stock.batch is
  'Manufacturing lots. Rows named OPEN-<date>-<sku> were declared by migration 0054 over stock that was received before lot tracking worked; their expiry is an estimate from shelf life, not a recorded fact.';
