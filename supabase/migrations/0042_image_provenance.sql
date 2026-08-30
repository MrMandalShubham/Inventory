-- ============================================================
-- 0042 — An API client is not a user
--
-- ── The bug ──
--
-- catalog.product_image.uploaded_by referenced platform.app_user, and
-- attach_product_image() filled it from platform.current_user_id() —
-- which for an API caller is the CLIENT id, because an API client's
-- claim carries the client in `sub` (migration 0020). No such row
-- exists in app_user, so the insert failed on a foreign key and the
-- API returned a bad_reference error nobody could act on.
--
-- The catalogue is exactly the place this was going to happen: it is
-- the surface a supplier feed or a product-management app writes to,
-- and the whole reason images live here is that OTHER APPLICATIONS
-- consume and maintain them.
--
-- ── The fix records who it really was ──
--
-- Two nullable columns, one for each kind of actor, each with its own
-- foreign key. "Who added this photograph" is an audit question, and
-- answering it with a uuid that might be a person or might be an
-- application — with no way to tell which — is not an answer.
--
-- A check constraint keeps it honest: never both.
-- ============================================================

alter table catalog.product_image
  drop constraint if exists product_image_uploaded_by_fkey;

alter table catalog.product_image
  rename column uploaded_by to uploaded_by_user;

alter table catalog.product_image
  add constraint product_image_uploaded_by_user_fkey
    foreign key (uploaded_by_user) references platform.app_user(id),
  add column uploaded_by_client uuid references platform.api_client(id),
  add constraint uploaded_by_one_actor check (
    uploaded_by_user is null or uploaded_by_client is null);

comment on column catalog.product_image.uploaded_by_client is
  'Set when an application added the photograph rather than a person. An API client is not a user — see migration 0042.';

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
  v_role    text := platform.current_role_name();
  v_actor   uuid := platform.current_user_id();
begin
  if v_role not in ('planner','admin','api_client') then
    raise exception 'FORBIDDEN_ROLE: % may not change the catalogue', v_role
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
    checksum, alt_text, position, is_primary,
    uploaded_by_user, uploaded_by_client)
  values (
    p_product, p_key, p_thumb_key, p_mime, p_bytes, p_width, p_height,
    coalesce(p_checksum, p_key), nullif(btrim(coalesce(p_alt, '')), ''),
    v_count, v_primary,
    -- Whichever it actually was. An API client's claim carries the
    -- client id in `sub`, so writing it to a user column was always
    -- going to fail — see the header.
    case when v_role = 'api_client' then null else v_actor end,
    case when v_role = 'api_client' then v_actor else null end)
  returning id into v_id;

  return v_id;
end $$;
