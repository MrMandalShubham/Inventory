-- ============================================================
-- CI CHECK — server-only functions are not reachable by an
--            application role
--
-- ── The bug this catches, which already happened ──
--
-- platform.open_session_for() mints a valid session for ANY user id
-- without a password. It exists so the web server can sign in an
-- administrator whose credentials live in the environment.
--
-- Migration 0044 revoked EXECUTE from `authenticated`. Four lines
-- later — in a different file, run afterwards — 99-grants.sql said
-- `grant execute on all functions in schema platform to authenticated`
-- and gave it straight back.
--
-- The revoke was written. Its own comment claimed it was "the whole
-- security boundary". It was undone immediately, and nothing noticed,
-- because a revoke leaves no trace when it is overridden. Any
-- signed-in operator could have called it and become an admin.
--
-- Two files, each individually reasonable, combining into a hole. That
-- is precisely the class a build-time check exists for: the property
-- is asserted about the FINAL state of the database, after every
-- migration and every grant has run, rather than about the intention
-- of any one file.
--
-- ── The convention ──
--
-- A function declares itself server-only with `@server-only` in its
-- body, the same way it declares `@no-scope-check`. The marker travels
-- with the function; a list in another file would not.
-- ============================================================

with server_only as (
  select n.nspname as schema_name,
         p.proname as function_name,
         pg_get_function_identity_arguments(p.oid) as args,
         p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname not like 'pg\_%'
     and n.nspname not in ('information_schema', 'public', 'extensions')
     and p.prosrc like '%@server-only%'
),
-- Every role an untrusted caller could plausibly arrive as. PUBLIC is
-- included because a grant to PUBLIC reaches everybody, which is the
-- easiest version of this mistake to make.
callers as (
  select unnest(array['authenticated', 'anon', 'public']) as role_name
)
select f.schema_name,
       f.function_name,
       f.args,
       c.role_name  as reachable_by,
       'SERVER_ONLY_FUNCTION_IS_EXECUTABLE' as violation,
       'this function does not check the caller''s identity — it is trusted to be '
       'called only by the server. Revoke EXECUTE from ' || c.role_name ||
       '. If a blanket grant is putting it back, it must be revoked AFTER that grant '
       '(see supabase/local/99-grants.sql).' as fix
  from server_only f
  cross join callers c
 where has_function_privilege(c.role_name, f.oid, 'EXECUTE')
   -- A role that does not exist on this database cannot reach anything.
   and (c.role_name = 'public' or exists (
         select 1 from pg_roles where rolname = c.role_name))
 order by f.schema_name, f.function_name, c.role_name;
