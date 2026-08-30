-- ============================================================
-- 0041 — Product images
--
-- ── Why the bytes are not in here ──
--
-- A grocery catalogue is a few thousand products with two or three
-- photos each. As bytea that is several gigabytes inside the database:
-- every backup carries it, every restore waits for it, and no CDN can
-- ever cache it because every read is a query. The image would also be
-- subject to row-level security, which means a customer-facing app
-- could not render an <img> tag without a database round trip holding
-- a session.
--
-- So this table stores what the database is good at — identity,
-- ordering, dimensions, who changed it — and a KEY pointing at an
-- object store that is good at bytes. lib/storage.ts owns the bytes;
-- local disk in development, Supabase Storage in production.
--
-- ── Content-addressed keys ──
--
-- The key is the SHA-256 of the bytes. Three things follow, all of
-- which matter for a customer app:
--
--   • The same photo uploaded twice is stored once.
--   • A key can never come to mean different bytes, so the URL is
--     immutable and can be cached forever rather than revalidated.
--   • A key is unguessable, which is what makes it safe to serve
--     product photos without a session — see app/images.
--
-- ── One primary, always ──
--
-- A customer app asks for "the" image of a product and must get
-- exactly one. Enforced by a partial unique index rather than by
-- application code, because "somehow two rows are primary" is not a
-- bug anybody finds until the app renders the wrong photo.
-- ============================================================

create table catalog.product_image (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references catalog.product(id) on delete cascade,

  -- Where the bytes actually are. Content-addressed: sha256 + extension.
  storage_key text not null,
  -- A small rendition for lists and search results. Nullable: an image
  -- pushed through the API by another system may arrive without one,
  -- and a missing thumbnail must degrade to the full image rather than
  -- to a broken picture.
  thumb_key   text,

  mime        text not null check (mime in ('image/jpeg','image/png','image/webp','image/avif')),
  byte_size   integer not null check (byte_size > 0),
  width       integer check (width > 0),
  height      integer check (height > 0),
  checksum    text not null,

  -- Not decoration. A customer app renders this when the image fails
  -- to load, a screen reader reads it aloud, and search engines index
  -- it. Required in spirit; nullable so a bulk import is not blocked
  -- by it, and surfaced as a gap in the UI instead.
  alt_text    text,

  position    integer not null default 0,
  is_primary  boolean not null default false,

  uploaded_by uuid references platform.app_user(id),
  created_at  timestamptz not null default now(),

  -- The same file attached twice to one product is a mistake, not a
  -- gallery. Across DIFFERENT products it is legitimate — a supplier
  -- photo reused for two pack sizes — so this is scoped per product.
  unique (product_id, checksum)
);

create index product_image_product_idx on catalog.product_image (product_id, position);
create index product_image_key_idx     on catalog.product_image (storage_key);

-- Exactly one primary per product. Not "at most one" enforced in code.
create unique index product_image_one_primary
  on catalog.product_image (product_id) where is_primary;

-- ─────────────── attaching ───────────────

/**
 * Attach an image that has already been written to the object store.
 *
 * The bytes go to storage FIRST and the row is written second. That
 * order is deliberate: an orphaned object costs a few kilobytes and is
 * collectable, whereas a row pointing at bytes that were never written
 * is a broken image in a customer's app.
 */
create or replace function catalog.attach_product_image(
  p_product   uuid,
  p_key       text,
  p_thumb_key text,
  p_mime      text,
  p_bytes     integer,
  p_width     integer default null,
  p_height    integer default null,
  p_checksum  text default null,
  p_alt       text default null,
  p_primary   boolean default null
) returns uuid
language plpgsql
security definer
set search_path = catalog, platform, public
as $$
-- @no-scope-check: the catalogue is global — a product code means the
-- same thing at every location (docs/09). Role is checked below.
declare
  v_id      uuid;
  v_count   integer;
  v_primary boolean;
begin
  if platform.current_role_name() not in ('planner','admin','api_client') then
    raise exception 'FORBIDDEN_ROLE: % may not change the catalogue', platform.current_role_name()
      using errcode = '42501';
  end if;

  if not exists (select 1 from catalog.product where id = p_product) then
    raise exception 'NO_SUCH_PRODUCT' using errcode = 'P0002';
  end if;

  select count(*) into v_count from catalog.product_image where product_id = p_product;

  -- The first image a product ever gets is its primary, whatever the
  -- caller said. A product with photos and no primary would render as
  -- a blank tile in the customer app.
  v_primary := coalesce(p_primary, false) or v_count = 0;

  if v_primary then
    update catalog.product_image set is_primary = false
     where product_id = p_product and is_primary;
  end if;

  insert into catalog.product_image (
    product_id, storage_key, thumb_key, mime, byte_size, width, height,
    checksum, alt_text, position, is_primary, uploaded_by)
  values (
    p_product, p_key, p_thumb_key, p_mime, p_bytes, p_width, p_height,
    coalesce(p_checksum, p_key), nullif(btrim(coalesce(p_alt, '')), ''),
    v_count, v_primary, platform.current_user_id())
  returning id into v_id;

  return v_id;
end $$;

/** Promote one image to primary. */
create or replace function catalog.set_primary_image(p_image uuid)
returns void
language plpgsql
security definer
set search_path = catalog, platform, public
as $$
-- @no-scope-check: catalogue-wide by design; role checked below.
declare v_product uuid;
begin
  if platform.current_role_name() not in ('planner','admin') then
    raise exception 'FORBIDDEN_ROLE: % may not change the catalogue', platform.current_role_name()
      using errcode = '42501';
  end if;

  select product_id into v_product from catalog.product_image where id = p_image;
  if not found then raise exception 'NO_SUCH_IMAGE' using errcode = 'P0002'; end if;

  -- Clear first, then set. The partial unique index would refuse the
  -- other order, which is exactly the protection it exists to give.
  update catalog.product_image set is_primary = false
   where product_id = v_product and is_primary;
  update catalog.product_image set is_primary = true where id = p_image;
end $$;

/**
 * Detach an image.
 *
 * Returns the storage key so the caller can decide about the bytes.
 * They are NOT deleted here: the same content-addressed object may be
 * attached to another product, and deleting it would blank that
 * product's photo too. Unreferenced objects are collected separately.
 */
create or replace function catalog.remove_product_image(p_image uuid)
returns text
language plpgsql
security definer
set search_path = catalog, platform, public
as $$
-- @no-scope-check: catalogue-wide by design; role checked below.
declare
  img       catalog.product_image%rowtype;
  v_next    uuid;
begin
  if platform.current_role_name() not in ('planner','admin') then
    raise exception 'FORBIDDEN_ROLE: % may not change the catalogue', platform.current_role_name()
      using errcode = '42501';
  end if;

  select * into img from catalog.product_image where id = p_image;
  if not found then raise exception 'NO_SUCH_IMAGE' using errcode = 'P0002'; end if;

  delete from catalog.product_image where id = p_image;

  -- Removing the primary must promote another, or the product silently
  -- loses its picture in every listing that asks for the primary one.
  if img.is_primary then
    select id into v_next from catalog.product_image
     where product_id = img.product_id order by position, created_at limit 1;
    if v_next is not null then
      update catalog.product_image set is_primary = true where id = v_next;
    end if;
  end if;

  return img.storage_key;
end $$;

/** Reorder a product's gallery. Ids in the order they should appear. */
create or replace function catalog.reorder_product_images(
  p_product uuid,
  p_images  uuid[]
) returns integer
language plpgsql
security definer
set search_path = catalog, platform, public
as $$
-- @no-scope-check: catalogue-wide by design; role checked below.
declare v_n integer := 0;
begin
  if platform.current_role_name() not in ('planner','admin') then
    raise exception 'FORBIDDEN_ROLE: % may not change the catalogue', platform.current_role_name()
      using errcode = '42501';
  end if;

  update catalog.product_image i
     set position = o.ord - 1
    from unnest(p_images) with ordinality as o(id, ord)
   where i.id = o.id and i.product_id = p_product;

  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ─────────────── which objects are still needed ───────────────

/**
 * Is this object still needed?
 *
 * Working out which objects in the bucket are unreferenced requires
 * LISTING the bucket, which is the storage driver's job and not
 * something SQL can see. So the sweep lives in scripts/storage-gc.mjs,
 * which lists the bucket and asks this one question per key.
 *
 * Deleting bytes is always a separate, deliberate step — never a side
 * effect of removing a row, because the same content-addressed object
 * may be shared between products.
 */
create or replace function catalog.image_key_referenced(p_key text)
returns boolean
language sql
stable
security definer
set search_path = catalog, public
as $$
  -- @no-scope-check: answers one yes/no about an opaque storage key.
  select exists (
    select 1 from catalog.product_image
     where storage_key = p_key or thumb_key = p_key);
$$;

-- ─────────────── RLS ───────────────
--
-- Readable by anyone signed in AND by API clients holding
-- catalog:read, because serving the catalogue to a customer app is the
-- whole point. Writable by the same roles that own the catalogue.

alter table catalog.product_image enable row level security;

create policy product_image_read on catalog.product_image
  for select using (platform.current_role_name() <> '');

create policy product_image_write on catalog.product_image
  for all using (platform.current_role_name() in ('planner','admin'))
  with check (platform.current_role_name() in ('planner','admin'));

comment on table catalog.product_image is
  'Image metadata and a storage key. The bytes live in an object store — see lib/storage.ts and migration 0041.';
