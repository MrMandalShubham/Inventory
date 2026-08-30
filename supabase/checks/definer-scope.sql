-- ============================================================
-- CI CHECK — SECURITY DEFINER scope discipline
--
-- Returns one row per violation. Any row returned fails the build.
--
-- A SECURITY DEFINER function runs as its owner, so row-level
-- security does not apply inside it. Every such function must
-- therefore do the guard's job itself: call
-- platform.can_access_location() before touching location data.
--
-- A function that genuinely touches no location data declares so
-- with a marker in its body:
--
--     -- @no-scope-check: <why this one is safe>
--
-- That keeps the exemption visible in review and in git history,
-- rather than being an absence nobody can see.
-- ============================================================

select n.nspname  as schema_name,
       p.proname  as function_name,
       pg_get_function_identity_arguments(p.oid) as args,
       'DEFINER_WITHOUT_SCOPE_CHECK' as violation,
       'call platform.can_access_location(<location>) in the body, '
         || 'or declare "-- @no-scope-check: <reason>" if it touches no location data' as fix
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where p.prosecdef                                    -- SECURITY DEFINER
   -- Every application schema, discovered rather than listed —
   -- see the note in rls-coverage.sql.
    and n.nspname not like 'pg\_%'
    and n.nspname not in (
      'information_schema','public','auth','extensions','graphql',
      'graphql_public','realtime','storage','vault','net','cron','pgbouncer')
   and p.prosrc not like '%can_access_location%'
   and p.prosrc not like '%@no-scope-check%'
 order by 1, 2;
