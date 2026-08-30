-- ============================================================
-- CI CHECK — a pinned search_path must include `extensions`
--
-- ── The bug this catches ──
--
-- Every SECURITY DEFINER function here pins its search_path, which is
-- what stops a caller shadowing a table name with one of their own.
-- The paths name our schemas and `public`:
--
--   set search_path = platform, public
--
-- On a plain Postgres container that works, because `create extension
-- pgcrypto` installs into `public`. On Supabase, extensions live in a
-- schema called `extensions`, so inside such a function there is no
-- digest(), crypt(), gen_salt(), gen_random_bytes(), word_similarity()
-- or `<%`.
--
-- Nothing fails during migration. It fails afterwards, in production
-- only, as: nobody can sign in, no API key authenticates, no key can
-- be minted, and product search returns nothing.
--
-- Migration 0043 fixed every function that existed at the time. This
-- catches the next one — because a `create or replace` that restates
-- the old search_path silently undoes it, and the local container
-- cannot tell you, since there it makes no difference.
--
-- ── Why `extensions` last ──
--
-- It must never come before our own schemas, or it could shadow one —
-- which is the exact risk pinning the path exists to remove.
-- ============================================================

with ours as (
  select p.oid,
         n.nspname as schema_name,
         p.proname as function_name,
         pg_get_function_identity_arguments(p.oid) as args,
         p.proconfig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('platform','catalog','stock','movement','partner',
                       'insight','alerting','ledger')
     and p.prokind = 'f'
),
pinned as (
  select o.schema_name, o.function_name, o.args, cfg as setting
    from ours o
    cross join lateral unnest(coalesce(o.proconfig, '{}')) as cfg
   where cfg like 'search\_path=%'
)
select schema_name,
       function_name,
       args,
       setting,
       case
         when setting not like '%extensions%' then 'SEARCH_PATH_MISSING_EXTENSIONS'
         else 'EXTENSIONS_NOT_LAST'
       end as violation,
       case
         when setting not like '%extensions%'
           then 'on Supabase this function cannot see pgcrypto or pg_trgm. '
                'Add `, extensions` to the end of its search_path.'
         else 'move `extensions` to the END of the search_path so it cannot '
              'shadow one of our own schemas.'
       end as fix
  from pinned
 where setting not like '%extensions%'
    -- Present, but not in the last position.
    or setting !~ ',\s*extensions\s*$'
 order by schema_name, function_name;
