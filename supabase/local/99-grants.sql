-- ============================================================
-- Grants — applied after migrations, on BOTH local and Supabase
--
-- Gives the `authenticated` role the same access shape Supabase gives
-- a signed-in user: it can reach our tables, and row-level security
-- decides what it actually sees.
--
-- Crucially `authenticated` is NOT the table owner and NOT a
-- superuser, so RLS genuinely applies to it. Testing as `postgres`
-- would prove nothing at all — a superuser bypasses every policy, and
-- the suite would pass while the system leaked.
--
-- ── Schemas are discovered, but NOT all of them ──
--
-- The first version of this file granted on every schema that was not
-- pg_*, information_schema, public or extensions. Against a plain
-- container that is exactly right. Against a real Supabase project it
-- would have granted `authenticated` — the role every signed-in user
-- of the whole project holds — INSERT, UPDATE and DELETE on
-- auth.users, storage.objects and vault.secrets.
--
-- That is not a rough edge. It is handing every user of the project
-- the ability to rewrite its authentication tables.
--
-- Discovery is still the right shape: a hardcoded list broke twice
-- already, once when catalog and partner arrived in Phase 1 and again
-- when movement arrived in Phase 3, and "permission denied for
-- schema" is at least loud. So this keeps discovery and adds two
-- filters that no new schema of ours will ever trip:
--
--   • the known system and Supabase-internal schemas, and
--   • anything OWNED by a supabase_* role, which is how Supabase
--     names the owners of everything it manages.
--
-- A schema Supabase adds next year is owned by one of those roles and
-- is excluded automatically. A schema WE add is owned by us and is
-- included automatically. Neither case needs anybody to remember.
-- ============================================================

do $$
declare
  s       text;
  granted text[] := '{}';
begin
  for s in
    select n.nspname
      from pg_namespace n
      join pg_roles r on r.oid = n.nspowner
     where n.nspname not like 'pg\_%'
       and n.nspname not in (
         'information_schema', 'public', 'extensions', 'auth', 'storage',
         'vault', 'graphql', 'graphql_public', 'realtime', 'cron', 'net',
         'pgbouncer', 'pgsodium', 'pgsodium_masks', 'supabase_functions',
         'supabase_migrations', '_analytics', '_realtime')
       -- Everything Supabase manages is owned by a supabase_* role.
       and r.rolname not like 'supabase%'
  loop
    execute format('grant usage on schema %I to authenticated', s);
    execute format('grant select, insert, update, delete on all tables in schema %I to authenticated', s);
    execute format('grant execute on all functions in schema %I to authenticated', s);
    execute format('grant usage, select on all sequences in schema %I to authenticated', s);
    granted := granted || s;
  end loop;

  -- Say what was granted. A grant script that works silently is one
  -- nobody notices has started granting somewhere new.
  raise notice 'granted authenticated access to: %', array_to_string(granted, ', ');
end $$;

-- ── and take back the ones no application role may ever call ──
--
-- The blanket `grant execute on all functions` above is right for
-- almost everything: our functions check their own role and scope, so
-- reaching them is harmless.
--
-- A few are different. platform.open_session_for() mints a valid
-- session for ANY user id without a password — it exists so the server
-- can log in an administrator it authenticated from the environment.
-- Granted to `authenticated`, it is complete privilege escalation: any
-- signed-in operator calls it and becomes an admin.
--
-- Migration 0044 revoked it. This file then granted it straight back,
-- because it runs AFTER every migration. The revoke was written, the
-- comment claimed it was the security boundary, and it was undone
-- four lines later — caught only because a probe asserted an operator
-- could NOT call it.
--
-- So the revoke lives here, at the end, where nothing follows it. And
-- it is DISCOVERED rather than listed: a function declares itself
-- server-only in its own body, exactly as it declares
-- @no-scope-check, so the marker cannot drift away from the function
-- it describes. A hardcoded list has rotted twice in this codebase
-- already.
do $$
declare
  f       record;
  revoked text[] := '{}';
begin
  for f in
    select n.nspname as schema_name,
           p.proname  as name,
           pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname not like 'pg\_%'
       and n.nspname not in ('information_schema', 'public', 'extensions')
       and p.prosrc like '%@server-only%'
  loop
    execute format('revoke execute on function %I.%I(%s) from authenticated',
                   f.schema_name, f.name, f.args);
    execute format('revoke execute on function %I.%I(%s) from public',
                   f.schema_name, f.name, f.args);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke execute on function %I.%I(%s) from anon',
                     f.schema_name, f.name, f.args);
    end if;
    revoked := revoked || format('%s.%s', f.schema_name, f.name);
  end loop;

  raise notice 'server-only, revoked from authenticated: %',
    coalesce(array_to_string(revoked, ', '), 'none');
end $$;
