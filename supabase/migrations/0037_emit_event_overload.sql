-- ============================================================
-- 0037 — There were two emit_event functions
--
-- Migration 0035 added the p_event_key argument with CREATE OR
-- REPLACE. In Postgres a function is identified by name AND argument
-- list, so that did not replace anything — it created a second
-- function beside the first:
--
--   platform.emit_event(text, jsonb)            -- 0020, no dedupe
--   platform.emit_event(text, jsonb, text)      -- 0035, dedupes
--
-- Two consequences, both silent:
--
--   • Any two-argument call is now ambiguous and fails outright with
--     "function is not unique" — the third argument has a default, so
--     both candidates match.
--
--   • Had it resolved instead of erroring, it could have resolved to
--     the OLD one, which queues without an event key and therefore
--     without the duplicate protection the whole design rests on.
--
-- The overload is the dangerous half. An error is loud; picking the
-- wrong function would have meant subscribers quietly receiving the
-- same event twice, which is precisely the failure 0035 was written
-- to prevent.
--
-- Adding a defaulted argument to an existing function is never a
-- replacement. Drop the old signature explicitly.
-- ============================================================

drop function if exists platform.emit_event(text, jsonb);

-- Prove there is exactly one left. A migration that assumes is a
-- migration that leaves this same trap for the next person.
do $$
declare n integer;
begin
  select count(*) into n
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'platform' and p.proname = 'emit_event';

  if n <> 1 then
    raise exception 'EXPECTED_ONE_EMIT_EVENT: found % overloads', n;
  end if;
end $$;
