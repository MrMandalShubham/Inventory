-- ============================================================
-- 0049 — What a storefront needs that an inventory does not
--
-- This system has always tracked what goods COST. A shop that sells
-- them needs three things it has never had:
--
--   • a price to charge, which is not derived from cost
--   • categories as entities, not a free-text column
--   • a stable URL for a product
--
-- ── Why price is not cost plus a markup ──
--
-- Cost here is a weighted average that moves every time a delivery
-- arrives at a different price. Deriving the shelf price from it means
-- the price changes whenever you buy — customers see it move for no
-- reason they can observe, and nobody can answer "why is this 27
-- rupees today". A price is a decision somebody makes and holds.
--
-- It also keeps cost out of any response a browser can read. Publishing
-- landed cost publishes margin.
--
-- ── One price, with a per-location override ──
--
-- Almost every product costs the same at every shop, so a row per
-- product per location would be ten thousand rows to express one
-- decision. The base row (location_id null) is the price; a row with a
-- location is that shop disagreeing.
-- ============================================================

-- ─────────────────────── categories ───────────────────────

create table catalog.category (
  -- The slug IS the id. A storefront puts it in a URL and a filter,
  -- and a surrogate uuid would mean every client carrying a lookup
  -- table to turn "fruits-veggies" into something it can send back.
  id       text primary key check (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name     text not null,

  -- An emoji or an absolute image URL. Deliberately opaque: the
  -- storefront decides how to render it, and this system has no
  -- opinion about presentation.
  icon     text,

  position integer not null default 0,
  status   text not null default 'ACTIVE' check (status in ('ACTIVE','HIDDEN')),
  created_at timestamptz not null default now()
);

create index category_order_idx on catalog.category (status, position, name);

alter table catalog.product
  add column category_id text references catalog.category(id) on delete set null,

  -- What a customer reads on the shelf: "500 ml", "1 kg", "6 pack".
  -- NOT the base unit of measure. Stock is counted in millilitres;
  -- nobody buys 500 millilitres, they buy a bottle.
  add column pack_size text,

  -- Stable, unique, and generated once. A storefront that builds its
  -- own slug from the name breaks every link the day somebody fixes a
  -- typo in a product name.
  add column slug text unique;

create index product_slug_idx on catalog.product (slug) where slug is not null;

/** A URL-safe slug. Deterministic, so the same name gives the same one. */
create or replace function catalog.slugify(p_text text)
returns text
language sql
immutable
as $$
  select nullif(
    trim(both '-' from
      regexp_replace(
        regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]+', '-', 'g'),
        '-{2,}', '-', 'g')),
    '')
$$;

-- ── backfill: turn the free-text categories into real ones ──

insert into catalog.category (id, name, position)
select catalog.slugify(category), category,
       row_number() over (order by category)
  from (select distinct category from catalog.product
         where category is not null and btrim(category) <> '') c
 where catalog.slugify(category) is not null
on conflict (id) do nothing;

update catalog.product p
   set category_id = catalog.slugify(p.category)
 where p.category is not null
   and exists (select 1 from catalog.category c where c.id = catalog.slugify(p.category));

-- ── backfill: slugs, made unique by SKU where names collide ──
--
-- Two products can legitimately share a name ("Onions" loose and
-- packed). The slug must still be unique, and appending the code is
-- more useful to a human than appending a number.
update catalog.product p
   set slug = case
     when (select count(*) from catalog.product o
            where catalog.slugify(o.name) = catalog.slugify(p.name)) > 1
     then catalog.slugify(p.name) || '-' || lower(p.sku_code)
     else catalog.slugify(p.name)
   end
 where p.slug is null and catalog.slugify(p.name) is not null;

/** Keep the slug filled for products created later. */
create or replace function catalog.assign_slug()
returns trigger
language plpgsql
as $$
begin
  if new.slug is null then
    new.slug := catalog.slugify(new.name);
    -- A collision is rare enough to resolve by suffix rather than by
    -- refusing the insert.
    if exists (select 1 from catalog.product where slug = new.slug and id <> new.id) then
      new.slug := new.slug || '-' || lower(new.sku_code);
    end if;
  end if;
  return new;
end $$;

create trigger product_slug
  before insert on catalog.product
  for each row execute function catalog.assign_slug();

-- ─────────────────────── prices ───────────────────────

create table catalog.price (
  product_id  uuid not null references catalog.product(id) on delete cascade,

  -- NULL means "everywhere". A row naming a location is that shop
  -- disagreeing with the base price.
  location_id uuid references platform.location(id) on delete cascade,

  -- Paise, like every other money column in this system. Rupees as a
  -- float would round differently in two places and the difference
  -- would surface as a customer being charged a paisa more than the
  -- receipt says.
  retail_paise    bigint not null check (retail_paise > 0),
  mrp_paise       bigint not null check (mrp_paise > 0),
  wholesale_paise bigint check (wholesale_paise > 0),

  -- Selling above the printed maximum retail price is illegal in
  -- India. Enforced here rather than trusted to whoever types it.
  constraint retail_within_mrp check (retail_paise <= mrp_paise),

  -- A B2B price above the retail price is a data-entry error, not a
  -- business model.
  constraint wholesale_below_retail check (
    wholesale_paise is null or wholesale_paise <= retail_paise),

  updated_at timestamptz not null default now(),
  updated_by uuid
);

-- NULLS NOT DISTINCT: without it Postgres treats every base row as
-- unique, and a product could accumulate a dozen contradictory base
-- prices with nothing to say which applies.
create unique index price_one_per_scope
  on catalog.price (product_id, location_id) nulls not distinct;

create index price_location_idx on catalog.price (location_id)
  where location_id is not null;

/**
 * The price that applies at one location.
 *
 * The override wins; otherwise the base row. Returns nothing when a
 * product has no price at all — which is deliberate: a product with no
 * price is not sellable, and inventing zero would put it on a shelf
 * for free.
 */
create or replace function catalog.price_for(
  p_product  uuid,
  p_location uuid default null
) returns table (
  retail_paise    bigint,
  mrp_paise       bigint,
  wholesale_paise bigint,
  is_override     boolean
)
language sql
stable
security definer
set search_path = catalog, public, extensions
as $$
  -- @no-scope-check: a price is not location-scoped data in the RLS
  -- sense — it is what a shop charges, which its customers can see on
  -- the shelf. Stock is the scoped thing, and it is not returned here.
  select p.retail_paise, p.mrp_paise, p.wholesale_paise,
         p.location_id is not null
    from catalog.price p
   where p.product_id = p_product
     and (p.location_id = p_location or p.location_id is null)
   -- The override first, so LIMIT 1 picks it over the base row.
   order by p.location_id nulls last
   limit 1;
$$;

/** Set a price. Base price when p_location is null. */
create or replace function catalog.set_price(
  p_product   uuid,
  p_retail    bigint,
  p_mrp       bigint,
  p_wholesale bigint default null,
  p_location  uuid default null
) returns void
language plpgsql
security definer
set search_path = catalog, platform, public, extensions
as $$
-- @no-scope-check: prices are catalogue data, global by design. The
-- role check below is the guard.
begin
  if platform.current_role_name() not in ('planner','admin','api_client') then
    raise exception 'FORBIDDEN_ROLE: % may not set prices', platform.current_role_name()
      using errcode = '42501';
  end if;

  if not exists (select 1 from catalog.product where id = p_product) then
    raise exception 'NO_SUCH_PRODUCT' using errcode = 'P0002';
  end if;

  insert into catalog.price (product_id, location_id, retail_paise, mrp_paise,
                             wholesale_paise, updated_by)
       values (p_product, p_location, p_retail, p_mrp, p_wholesale,
               platform.current_user_id())
  on conflict (product_id, location_id) do update
      set retail_paise = excluded.retail_paise,
          mrp_paise = excluded.mrp_paise,
          wholesale_paise = excluded.wholesale_paise,
          updated_at = now(),
          updated_by = excluded.updated_by;
end $$;

-- ─────────────────────── RLS ───────────────────────
--
-- The catalogue is global and readable by anyone signed in — including
-- an API client, which is the whole point. Writes belong to the roles
-- that own the catalogue.

alter table catalog.category enable row level security;
alter table catalog.price enable row level security;

create policy category_read on catalog.category
  for select using (platform.current_role_name() <> '');
create policy category_write on catalog.category
  for all using (platform.current_role_name() in ('planner','admin'))
  with check (platform.current_role_name() in ('planner','admin'));

create policy price_read on catalog.price
  for select using (platform.current_role_name() <> '');
create policy price_write on catalog.price
  for all using (platform.current_role_name() in ('planner','admin'))
  with check (platform.current_role_name() in ('planner','admin'));

comment on table catalog.price is
  'What a shop charges. Not derived from cost — see migration 0049 for why. Base row has location_id null; a row naming a location is that shop overriding it.';
