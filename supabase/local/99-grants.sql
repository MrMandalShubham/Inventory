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
