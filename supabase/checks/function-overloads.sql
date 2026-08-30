-- ============================================================
-- CI CHECK — no accidental function overloads
--
-- ── The bug this catches ──
--
-- A function in Postgres is identified by its name AND its argument
-- list. So this does NOT replace anything:
--
--   -- 0020
--   create or replace function platform.emit_event(text, jsonb) ...
--   -- 0035, adding an argument
--   create or replace function platform.emit_event(text, jsonb, text default null) ...
--
-- It creates a SECOND function beside the first. Two ways that hurts,
-- and it happened twice in one afternoon:
--
--   • Every existing two-argument call becomes ambiguous and fails
--     with "function is not unique" — because the third argument has
--     a default, both candidates match. Loud, at least.
--
--   • Worse, where the call still resolves, it may resolve to the OLD
--     function. emit_event's old signature had no deduplication, so
--     subscribers would have quietly received every event twice.
--
-- Adding a defaulted argument to an existing function is never a
-- replacement. Drop the old signature explicitly in the same
-- migration.
--
-- ── Why a blanket ban ──
--
-- Deliberate overloading is a legitimate technique, and this codebase
-- does not use it. Given the choice between allowing a tool that is
-- never needed and catching a mistake that has already been made
-- twice, the guard wins. An intentional overload can be exempted by
-- name below — with a reason, like every other exemption here.
-- ============================================================

with app_schemas as (
  select n.oid, n.nspname
    from pg_namespace n
   where n.nspname not like 'pg\_%'
     and n.nspname not in (
       'information_schema', 'public', 'auth', 'extensions', 'graphql',
       'graphql_public', 'realtime', 'storage', 'vault', 'net', 'cron',
       'pgbouncer', 'pgsodium', 'pgsodium_masks')
),
overloaded as (
  select s.nspname as schema_name,
         p.proname as function_name,
         count(*)  as signatures,
         string_agg(pg_get_function_identity_arguments(p.oid), '  |  '
                    order by p.oid) as argument_lists
    from pg_proc p
    join app_schemas s on s.oid = p.pronamespace
   where p.prokind = 'f'
     -- Trigger functions take no arguments and cannot be overloaded
     -- in a way that matters here.
     and p.prorettype <> 'trigger'::regtype
   group by s.nspname, p.proname
  having count(*) > 1
)
select schema_name,
       function_name,
       signatures,
       argument_lists,
       'FUNCTION_OVERLOADED' as violation,
       'adding an argument with CREATE OR REPLACE does not replace — it creates a second function. '
       'Drop the old signature explicitly: drop function ' || schema_name || '.' || function_name || '(<old args>);'
         as fix
  from overloaded o
 where
   -- Intentional overloads, each with a reason. Empty by design.
   --
   -- NOT EXISTS, not NOT IN. The first draft of this guard used
   --
   --   where (schema_name, function_name) not in ((null, null))
   --
   -- as an empty placeholder. A row comparison against NULL is NULL,
   -- NOT IN of NULL is NULL, and NULL is not true — so the guard
   -- filtered out every violation it had just found and reported a
   -- clean build forever. It was caught only because a negative
   -- control in tests/guards.test.mjs asserts the guard FIRES.
   --
   -- Same shape as the dead scope check migration 0009 had to fix. A
   -- guard nobody has watched fail is not a guard.
   not exists (
     select 1
       from (values ('__example__', '__none__')) as exempt(schema_name, function_name)
      where exempt.schema_name = o.schema_name
        and exempt.function_name = o.function_name
   )
 order by o.schema_name, o.function_name;
