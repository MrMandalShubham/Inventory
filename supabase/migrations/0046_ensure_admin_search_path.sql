-- ============================================================
-- 0046 — ensure_admin() could not see the extensions schema
--
-- Migration 0043 appended `extensions` to the pinned search_path of
-- every function that existed at the time, because Supabase keeps
-- pgcrypto and pg_trgm there and a definer function is resolved
-- against its OWN pinned path.
--
-- 0045 then added platform.ensure_admin() with `platform, public` and
-- reintroduced exactly the condition 0043 existed to remove. It works
-- today only because it happens not to call pgcrypto — which is luck,
-- not design, and the kind of luck that runs out the first time
-- somebody adds a hashed column to it.
--
-- supabase/checks/search-path.sql caught it. That is the guard doing
-- its job on the very next migration after the fix.
-- ============================================================

alter function platform.ensure_admin(text, text)
  set search_path = platform, extensions, public;
