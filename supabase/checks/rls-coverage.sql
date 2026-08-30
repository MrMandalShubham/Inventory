-- ============================================================
-- CI CHECK — row-level security coverage
--
-- Returns one row per violation. Any row returned fails the build.
--
-- "A convention nobody checks is a convention nobody keeps."
-- A table added without RLS is not a style problem; it is a hole
-- that nobody notices until someone reads through it.
-- ============================================================

with managed as (
  select c.oid, n.nspname as schema_name, c.relname as table_name, c.relrowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where c.relkind = 'r'
     -- Every application schema, discovered rather than listed. An
     -- allowlist here silently stopped covering `movement` the day it
     -- was added, and the build stayed green.
     and n.nspname not like 'pg\_%'
     and n.nspname not in (
      'information_schema','public','auth','extensions','graphql',
      'graphql_public','realtime','storage','vault','net','cron','pgbouncer')
)
select schema_name,
       table_name,
       'RLS_NOT_ENABLED' as violation,
       'alter table ' || schema_name || '.' || table_name
         || ' enable row level security;' as fix
  from managed
 where not relrowsecurity

union all

select m.schema_name,
       m.table_name,
       'NO_POLICY' as violation,
       'table has RLS enabled but no policy — it denies everything, which is '
         || 'usually a mistake rather than a decision' as fix
  from managed m
 where m.relrowsecurity
   and not exists (select 1 from pg_policy p where p.polrelid = m.oid)

order by 1, 2;
