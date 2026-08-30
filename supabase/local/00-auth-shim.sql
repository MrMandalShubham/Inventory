-- ============================================================
-- LOCAL ONLY — never applied to a real Supabase project
--
-- Supabase provides the auth schema, auth.jwt() and the
-- `authenticated` role. A plain Postgres container does not, so we
-- recreate exactly those three things and nothing more.
--
-- auth.jwt() below is the same definition Supabase uses: it reads
-- the request.jwt.claims setting. That is what makes these tests
-- faithful rather than approximate — the policies under test are
-- byte-for-byte the ones that will run in production.
-- ============================================================

create schema if not exists auth;

create or replace function auth.jwt()
returns jsonb language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), ''),
    '{}'
  )::jsonb
$$;

create or replace function auth.uid()
returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;

-- `authenticated` must be able to CALL auth.jwt(), or every policy in
-- the system fails with "permission denied for schema auth".
--
-- This lives here, in the local-only shim, and NOT in 99-grants.sql:
-- that file now deliberately skips the auth schema, because on a real
-- Supabase project granting into it would mean handing every
-- signed-in user access to auth.users. Supabase already gives
-- `authenticated` exactly this much, and no more.
grant usage on schema auth to authenticated;
grant execute on all functions in schema auth to authenticated;
