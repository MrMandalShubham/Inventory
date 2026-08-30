-- ============================================================
-- LOCAL ONLY — make the container the same SHAPE as Supabase
--
-- Runs after the auth shim, which creates the `authenticated` role this
-- file grants to.
--
-- ── Why this file exists ──
--
-- Migration 0022 passed every local test and failed on Supabase with
-- `digest(text, unknown) does not exist`. Nothing was wrong with the
-- migration. The difference was where pgcrypto lives:
--
--   local container   pgcrypto in public      — on every search_path
--   Supabase          pgcrypto in extensions  — on none of ours
--
-- A `language sql` body is validated against the function's OWN pinned
-- search_path at creation time, so on Supabase the call could not
-- resolve and the deploy stopped halfway. The local suite could not
-- have caught it, because locally the call always resolved.
--
-- Reproducing Supabase's layout here turns that entire class of bug —
-- anything that depends on where an extension function lives — from a
-- deploy-time failure into a local test failure.
--
-- What this deliberately does NOT try to reproduce: pg_cron (needs
-- shared_preload_libraries and is not in the alpine image), Supabase
-- Auth's own tables, storage, or vault. Those are verified against the
-- real project by `npm run db:verify` and `npm run db:jobs`.
-- ============================================================

create schema if not exists extensions;

-- Supabase installs these three into `extensions`. Anything already
-- installed elsewhere is moved rather than recreated, so an existing
-- container converges instead of erroring.
do $$
declare e text;
begin
  foreach e in array array['pgcrypto', 'pg_trgm', 'uuid-ossp'] loop
    if exists (select 1 from pg_extension where extname = e) then
      execute format('alter extension %I set schema extensions', e);
    else
      execute format('create extension %I schema extensions', e);
    end if;
  end loop;
end $$;

-- The database-level search_path, matching Supabase's exactly. Set on
-- the DATABASE rather than the session so every connection the test
-- harness opens inherits it — including the ones it opens as
-- `authenticated`.
do $$
begin
  execute format('alter database %I set search_path to "$user", public, extensions',
                 current_database());
end $$;

-- Supabase's other two API roles. Nothing here uses them yet, but a
-- grant that accidentally names `anon` should fail locally the same
-- way it would on Supabase — not silently do nothing because the role
-- does not exist.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

grant usage on schema extensions to authenticated, anon, service_role;
grant execute on all functions in schema extensions to authenticated, anon, service_role;
