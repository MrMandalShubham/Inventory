-- ============================================================
-- 0006 — Catalogue
--
-- Invariant 3: one product identity, globally. Locations hold
-- stock; they do not own identity. So nothing in this schema is
-- location-scoped — a product code means the same thing in every
-- shop and every consuming app, which is the only reason
-- "how much of this across all locations" is answerable at all.
--
-- ── The decision that shapes everything here ──
--
-- QUANTITIES ARE INTEGERS IN THE SMALLEST UNIT.
--
-- Fruit sold by weight is stored in GRAMS, not fractional kilos.
-- Liquid in MILLILITRES. Same reasoning as money in paise: a
-- floating-point kilo introduces rounding error into the one number
-- the whole system exists to keep exact, and a numeric column makes
-- every sum slower for no benefit.
--
-- Base UoM is therefore always the smallest unit. Conversions go
-- upward (1 KG = 1000 G) and exist for display and for purchasing.
-- ============================================================

create extension if not exists pg_trgm;

create schema if not exists catalog;

-- ─────────────────────────── units of measure ───────────────────────────

create table catalog.uom (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  name       text not null,
  kind       text not null check (kind in ('COUNT','WEIGHT','VOLUME','LENGTH')),
  -- The smallest unit of its kind. Stock is always stored in one of these.
  is_base    boolean not null default false,
  created_at timestamptz not null default now()
);

insert into catalog.uom (code, name, kind, is_base) values
  ('PCS', 'Piece',      'COUNT',  true),
  ('G',   'Gram',       'WEIGHT', true),
  ('ML',  'Millilitre', 'VOLUME', true),
  ('MM',  'Millimetre', 'LENGTH', true),
  ('KG',  'Kilogram',   'WEIGHT', false),
  ('L',   'Litre',      'VOLUME', false),
  ('DOZ', 'Dozen',      'COUNT',  false),
  ('CTN', 'Carton',     'COUNT',  false),
  ('BOX', 'Box',        'COUNT',  false),
  ('BAG', 'Bag',        'COUNT',  false);

-- ─────────────────────────── product groups ───────────────────────────
--
-- "Toor Dal" is a group; "Toor Dal 1kg" and "Toor Dal 5kg" are the
-- products. You count products, never groups — which is why the
-- group carries no stock and no code that appears on a label.

create table catalog.product_group (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  category   text,
  created_at timestamptz not null default now()
);

-- ─────────────────────────── products ───────────────────────────

create table catalog.product (
  id           uuid primary key default gen_random_uuid(),

  -- Minted at creation by the trigger below. Gapless, human-readable,
  -- printed on labels and read out on the phone.
  sku_code     text not null unique,

  name         text not null,
  description  text,
  category     text,
  group_id     uuid references catalog.product_group(id) on delete set null,

  -- Always the smallest unit. See the header note.
  base_uom_id  uuid not null references catalog.uom(id),

  -- The three levels of detail from docs/09 §8, chosen per product
  -- so control matches the value and risk of the item.
  tracking_mode text not null default 'NONE'
                check (tracking_mode in ('NONE','BATCH','SERIAL')),

  -- Sold by weight rather than by the piece. Affects how the UI
  -- captures a quantity, never how it is stored.
  is_weighed   boolean not null default false,

  -- Statutory. Carried from day one so a second country is additive.
  hsn_code     text,
  tax_rate     numeric(5,2) check (tax_rate >= 0 and tax_rate <= 100),

  -- Planning inputs. Used from Phase 6; harmless until then.
  shelf_life_days integer check (shelf_life_days > 0),
  min_order_qty   integer check (min_order_qty > 0),

  status       text not null default 'ACTIVE' check (status in ('ACTIVE','ARCHIVED')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on column catalog.product.tracking_mode is
  'NONE = count only. BATCH = lot and expiry, enables oldest-first picking. SERIAL = every individual unit.';

-- A product that expires must be tracked by batch, or the expiry has
-- nowhere to live. Caught here rather than discovered in Phase 2.
alter table catalog.product add constraint shelf_life_needs_batch
  check (shelf_life_days is null or tracking_mode in ('BATCH','SERIAL'));

-- ─────────────────────────── SKU minting ───────────────────────────

create or replace function catalog.assign_sku_code()
returns trigger language plpgsql as $$
begin
  if new.sku_code is null or btrim(new.sku_code) = '' then
    new.sku_code := platform.next_number('product', 'PRD');
  end if;
  return new;
end $$;

create trigger product_assign_sku
  before insert on catalog.product
  for each row execute function catalog.assign_sku_code();

-- ─────────────────────────── barcodes ───────────────────────────
--
-- A product may carry several: the manufacturer's EAN, a supplier's
-- own code, and one we generate for goods that arrive unlabelled.

create table catalog.product_barcode (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references catalog.product(id) on delete cascade,
  barcode    text not null unique,
  kind       text not null check (kind in ('EAN','UPC','INTERNAL','SUPPLIER')),
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);

-- One primary per product: the scanner needs an unambiguous answer.
create unique index product_barcode_one_primary
  on catalog.product_barcode (product_id) where is_primary;

-- ─────────────────────────── UoM conversions ───────────────────────────
--
-- Buy a carton, stock a piece, sell by weight. Retrofitting this
-- would mean rewriting every quantity in the ledger, so it ships now,
-- before there are any quantities.

create table catalog.product_uom (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references catalog.product(id) on delete cascade,
  uom_id     uuid not null references catalog.uom(id),

  -- How many BASE units one of these is. A 12-piece carton = 12.
  -- A 1kg bag of a product based in grams = 1000.
  factor     numeric(18,6) not null check (factor > 0),

  purpose    text check (purpose in ('PURCHASE','SALE','DISPLAY')),

  unique (product_id, uom_id)
);

-- ─────────────────────────── search ───────────────────────────
--
-- A scan hits the exact path; a human typing "toor" hits the fuzzy one.

create index product_name_trgm    on catalog.product using gin (name gin_trgm_ops);
create index product_sku_idx      on catalog.product (sku_code);
create index product_status_idx   on catalog.product (status, category);
create index product_group_idx    on catalog.product (group_id) where group_id is not null;
create index product_tracking_idx on catalog.product (tracking_mode) where tracking_mode <> 'NONE';
create index barcode_lookup_idx   on catalog.product_barcode (barcode);
create index product_uom_prod_idx on catalog.product_uom (product_id);

-- ─────────────────────────── RLS ───────────────────────────
--
-- The catalogue is global by design. Everyone signed in reads it;
-- planner and admin write it. No location predicate anywhere —
-- that is invariant 3 expressed as a policy.

alter table catalog.uom             enable row level security;
alter table catalog.product_group   enable row level security;
alter table catalog.product         enable row level security;
alter table catalog.product_barcode enable row level security;
alter table catalog.product_uom     enable row level security;

create policy uom_read on catalog.uom
  for select using (platform.current_role_name() <> '');
create policy uom_write on catalog.uom
  for all using (platform.current_role_name() in ('planner','admin'))
  with check (platform.current_role_name() in ('planner','admin'));

create policy product_group_read on catalog.product_group
  for select using (platform.current_role_name() <> '');
create policy product_group_write on catalog.product_group
  for all using (platform.current_role_name() in ('planner','admin'))
  with check (platform.current_role_name() in ('planner','admin'));

create policy product_read on catalog.product
  for select using (platform.current_role_name() <> '');
create policy product_write on catalog.product
  for all using (platform.current_role_name() in ('planner','admin'))
  with check (platform.current_role_name() in ('planner','admin'));

create policy barcode_read on catalog.product_barcode
  for select using (platform.current_role_name() <> '');
create policy barcode_write on catalog.product_barcode
  for all using (platform.current_role_name() in ('planner','admin'))
  with check (platform.current_role_name() in ('planner','admin'));

create policy product_uom_read on catalog.product_uom
  for select using (platform.current_role_name() <> '');
create policy product_uom_write on catalog.product_uom
  for all using (platform.current_role_name() in ('planner','admin'))
  with check (platform.current_role_name() in ('planner','admin'));
