-- ============================================================
-- 0052 — The storefront's categories become the only categories
--
-- ── What was wrong ──
--
-- Categories arrived in 0049 as a backfill: whatever free text the
-- products happened to carry became a category. That produced
-- Staples, Dairy, Fruit & Veg, Beauty and Household — which is
-- nobody's list. Not the shelf layout, not the storefront's tiles,
-- not a supplier's. It was a list of the strings somebody typed.
--
-- A customer browsing a shop does not think "Staples". They think
-- "Atta, Rice & Dal", because that is what is written on the aisle.
-- The category is a shopping decision, so it belongs to the app doing
-- the shopping, and this migration adopts its ten.
--
-- ── Why the icons and positions are set here ──
--
-- catalog.ensure_category() creates a category the first time a
-- product names one, taking the display name from that product and
-- leaving icon and position at their defaults. That is right for a
-- category somebody invents while adding stock. It is wrong for these
-- ten, which have an order the storefront renders in and an icon per
-- tile — so they are inserted deliberately, BEFORE any product
-- references them, and the trigger's `on conflict do nothing` then
-- leaves them alone.
--
-- ── What happens to the old ones ──
--
-- Products move first, then the empty categories are hidden rather
-- than deleted. `on delete set null` means deleting a category
-- silently unfiles every product still in it, and a HIDDEN row is
-- recoverable while a deleted one is a decision nobody can review.
-- ============================================================

-- ─────────────── the ten, in the storefront's order ───────────────

insert into catalog.category (id, name, icon, position) values
  ('fruits-veggies',     'Fruits & Veggies',     '🥬',  1),
  ('dairy-bread-eggs',   'Dairy, Bread & Eggs',  '🥛',  2),
  ('atta-rice-dal',      'Atta, Rice & Dal',     '🌾',  3),
  ('oil-ghee-masala',    'Oil, Ghee & Masala',   '🛢️',  4),
  ('snacks-namkeen',     'Snacks & Namkeen',     '🍿',  5),
  ('cold-drinks',        'Cold Drinks',          '🥤',  6),
  ('instant-noodles',    'Instant & Noodles',    '🍜',  7),
  ('bakery-biscuits',    'Bakery & Biscuits',    '🍪',  8),
  ('cleaning-household', 'Cleaning & Household', '🧽',  9),
  ('personal-care',      'Personal Care',        '🧴', 10)
on conflict (id) do update
  set name     = excluded.name,
      icon     = excluded.icon,
      position = excluded.position,
      status   = 'ACTIVE';

-- ─────────────── move the products that already exist ───────────────
--
-- Written against the free-text `category` column rather than
-- category_id, because that column is what the ensure_category
-- trigger reads: updating it re-files the product AND resolves
-- category_id in one step. Setting category_id directly would leave
-- the two disagreeing, and the next edit to that product would
-- silently undo this.

update catalog.product set category = case category
    when 'Staples'     then 'Atta, Rice & Dal'
    when 'Dairy'       then 'Dairy, Bread & Eggs'
    when 'Fruit & Veg' then 'Fruits & Veggies'
    when 'Beauty'      then 'Personal Care'
    when 'Household'   then 'Cleaning & Household'
    else category
  end
 where category in ('Staples', 'Dairy', 'Fruit & Veg', 'Beauty', 'Household');

-- Anything else that was invented along the way and is not one of the
-- ten. Left in place and reported rather than guessed at: a product
-- filed under a category this migration does not know about is a
-- decision for whoever created it, and moving it somewhere plausible
-- would hide that.
do $$
declare v_orphans text;
begin
  select string_agg(distinct category, ', ')
    into v_orphans
    from catalog.product
   where category is not null
     and category not in (select name from catalog.category
                           where id in ('fruits-veggies','dairy-bread-eggs','atta-rice-dal',
                                        'oil-ghee-masala','snacks-namkeen','cold-drinks',
                                        'instant-noodles','bakery-biscuits',
                                        'cleaning-household','personal-care'));

  if v_orphans is not null then
    raise notice 'products remain in categories outside the ten: % — re-file them from the catalogue screen', v_orphans;
  end if;
end $$;

-- ─────────────── retire what is now empty ───────────────

update catalog.category c
   set status = 'HIDDEN'
 where c.id not in ('fruits-veggies','dairy-bread-eggs','atta-rice-dal',
                    'oil-ghee-masala','snacks-namkeen','cold-drinks',
                    'instant-noodles','bakery-biscuits',
                    'cleaning-household','personal-care')
   and not exists (select 1 from catalog.product p where p.category_id = c.id);

comment on table catalog.category is
  'The storefront''s ten tiles. Positions are the render order. A category outside the ten is one somebody invented on a product — see migration 0052.';
