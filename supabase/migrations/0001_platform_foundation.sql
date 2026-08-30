-- ============================================================
-- 0001 — Platform foundation
--
-- Roles, locations, the user↔location grant, and the helper
-- functions every row-level security policy is built from.
--
-- Isolation model: one deployment per business (docs/02 §3).
-- There is no organisation column anywhere, because there is
-- never more than one organisation in this database. The
-- boundary that remains is LOCATION and ROLE.
-- ============================================================

create schema if not exists platform;

-- ─────────────────────────── locations ───────────────────────────

create table platform.location (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null,
  type        text not null check (type in ('HUB','STORE','WAREHOUSE','VIRTUAL')),
  status      text not null default 'ACTIVE' check (status in ('ACTIVE','CLOSED')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table platform.location is
  'Every place stock can sit. VIRTUAL covers holding areas such as quarantine and in-transit.';

-- ─────────────────────────── users ───────────────────────────

-- The five roles from docs/08 §1. Kept as a CHECK rather than an
-- enum so adding a role later is a migration, not a type rewrite.
create table platform.app_user (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  full_name   text not null,
  role        text not null check (role in ('operator','shop_manager','planner','finance','admin')),
  status      text not null default 'ACTIVE' check (status in ('ACTIVE','SUSPENDED')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Which locations a user may act at. Ignored for the globally
-- scoped roles (planner, finance, admin) — see has_global_scope().
create table platform.user_location (
  user_id     uuid not null references platform.app_user(id) on delete cascade,
  location_id uuid not null references platform.location(id) on delete cascade,
  primary key (user_id, location_id)
);

-- ─────────────────────────── API clients ───────────────────────────

-- Consuming applications. Not users: a key resolves to a scope set,
-- never to an interactive session. Keys are hashed like passwords —
-- a database read must not yield a usable key (docs/08 §5).
create table platform.api_client (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  key_hash     text not null unique,
  scopes       text[] not null default '{}',
  location_ids uuid[] not null default '{}',
  status       text not null default 'ACTIVE' check (status in ('ACTIVE','REVOKED')),
  last_used_at timestamptz,
  expires_at   timestamptz,
  created_at   timestamptz not null default now()
);

-- ─────────────────── the caller's identity, from the JWT ───────────────────
--
-- These read Supabase's auth.jwt(). Every RLS policy and every
-- SECURITY DEFINER body goes through them rather than reading the
-- claim directly, so the shape of a claim changes in one place.

create or replace function platform.current_user_id()
returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

create or replace function platform.current_role_name()
returns text language sql stable as $$
  select coalesce(auth.jwt() ->> 'role', '')
$$;

create or replace function platform.current_location_ids()
returns uuid[] language sql stable as $$
  select coalesce(
    string_to_array(nullif(auth.jwt() ->> 'location_ids', ''), ',')::uuid[],
    '{}'::uuid[]
  )
$$;

-- Planner, finance and admin see every location by design: the
-- all-locations overview and the transfer source search need it.
-- Those are explicit exceptions with a named reason, not gaps.
create or replace function platform.has_global_scope()
returns boolean language sql stable as $$
  select platform.current_role_name() in ('planner','finance','admin')
$$;

-- THE function. Every location-scoped policy and every SECURITY
-- DEFINER function that touches a location must call this.
create or replace function platform.can_access_location(p_location uuid)
returns boolean language sql stable as $$
  select platform.has_global_scope()
      or p_location = any (platform.current_location_ids())
$$;

comment on function platform.can_access_location(uuid) is
  'The location boundary. A SECURITY DEFINER function that touches a location and does not call this is a privilege leak — see check-definer-scope.sql.';

-- ─────────────────────────── RLS ───────────────────────────

alter table platform.location      enable row level security;
alter table platform.app_user      enable row level security;
alter table platform.user_location enable row level security;
alter table platform.api_client    enable row level security;

-- Everyone signed in may read the location list; only admins write it.
create policy location_read on platform.location
  for select using (platform.current_role_name() <> '');

create policy location_write on platform.location
  for all using (platform.current_role_name() = 'admin')
  with check (platform.current_role_name() = 'admin');

-- A user sees themselves; admins see everyone.
create policy app_user_read on platform.app_user
  for select using (
    id = platform.current_user_id()
    or platform.current_role_name() = 'admin'
  );

create policy app_user_write on platform.app_user
  for all using (platform.current_role_name() = 'admin')
  with check (platform.current_role_name() = 'admin');

create policy user_location_read on platform.user_location
  for select using (
    user_id = platform.current_user_id()
    or platform.current_role_name() = 'admin'
  );

create policy user_location_write on platform.user_location
  for all using (platform.current_role_name() = 'admin')
  with check (platform.current_role_name() = 'admin');

-- API keys are admin-only in every direction. Nobody else needs to
-- know they exist, and the hash must never be widely readable.
create policy api_client_admin on platform.api_client
  for all using (platform.current_role_name() = 'admin')
  with check (platform.current_role_name() = 'admin');

create index location_status_idx      on platform.location (status);
create index app_user_role_idx        on platform.app_user (role) where status = 'ACTIVE';
create index user_location_loc_idx    on platform.user_location (location_id);
create index api_client_status_idx    on platform.api_client (status);
