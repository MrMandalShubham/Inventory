-- ============================================================
-- 0048 — extensions last, on the functions 0044-0046 added
--
-- supabase/checks/search-path.sql requires `extensions` to be the LAST
-- entry on a pinned search_path: it must be reachable, but it must
-- never shadow one of our own schemas. 0044 and 0045 put it in the
-- middle, and 0046 — the migration whose entire purpose was to fix a
-- search_path — put it in the middle too.
--
-- Three times in four migrations, which is what a convention nobody
-- can see looks like. The guard sees it.
-- ============================================================

alter function platform.open_session_for(uuid, text)
  set search_path = platform, public, extensions;

alter function platform.ensure_admin(text, text)
  set search_path = platform, public, extensions;
