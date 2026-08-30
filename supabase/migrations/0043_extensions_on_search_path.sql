-- ============================================================
-- 0043 — Making the definer functions work on Supabase
--
-- ── The failure this prevents ──
--
-- Every SECURITY DEFINER function in this system pins its search_path,
-- which is correct and is what stops a caller shadowing a table name
-- with one of their own. But the pinned paths name only our schemas
-- and `public`:
--
--   set search_path = platform, public
--
-- On a plain Postgres container that is enough, because `create
-- extension pgcrypto` installs into `public`. On Supabase, extensions
-- live in a schema called `extensions` — so inside these functions
-- there is no digest(), no crypt(), no gen_salt(), no
-- gen_random_bytes(), and no word_similarity() or `<%` from pg_trgm.
--
-- Nothing about that shows up during migration. It shows up later, as:
--
--   • nobody can sign in            (crypt in platform.sign_in)
--   • no API key authenticates      (digest in authenticate_api_key)
--   • no key can be minted          (gen_random_bytes)
--   • product search returns zero   (word_similarity in search_products)
--
-- Four total outages, all at runtime, on a deployment that migrated
-- without a single error.
--
-- ── The fix, and why it is safe on both ──
--
-- Append `extensions` to the search_path of every function of ours
-- that sets one. Postgres silently ignores a schema in search_path
-- that does not exist, so on the local container — where there is no
-- `extensions` schema — this changes nothing at all.
--
-- ALTER FUNCTION ... SET rather than redefining forty function bodies:
-- the bodies are already correct, and re-pasting them would be forty
-- more chances to introduce a difference.
--
-- `extensions` goes LAST, so it can never shadow one of our own
-- schemas — the reason the search_path is pinned in the first place.
-- ============================================================

do $$
declare
  f       record;
  v_path  text;
  v_count integer := 0;
begin
  for f in
    select p.oid,
           n.nspname as schema_name,
           p.proname as function_name,
           pg_get_function_identity_arguments(p.oid) as args,
           cfg
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join lateral unnest(coalesce(p.proconfig, '{}')) as cfg
     where n.nspname in ('platform','catalog','stock','movement','partner',
                         'insight','alerting','ledger')
       and cfg like 'search\_path=%'
       and cfg not like '%extensions%'
  loop
    -- 'search_path=' is twelve characters.
    v_path := substring(f.cfg from 13);

    execute format(
      'alter function %I.%I(%s) set search_path = %s, extensions',
      f.schema_name, f.function_name, f.args, v_path);

    v_count := v_count + 1;
  end loop;

  raise notice 'search_path extended with `extensions` on % function(s)', v_count;
end $$;
