-- ============================================================
-- 0039 — A default burst that does not refuse legitimate traffic
--
-- 0034 set burst to 100 — a number chosen because it sounded like a
-- lot, which is not a reason.
--
-- The Phase 4 gate is 200 simultaneous reservations against 100 units
-- of stock: a flash sale, the exact traffic shape this system was
-- built for. With a burst of 100 the limiter refused a quarter of it
-- with 429s, and the oversell guarantee could no longer be measured
-- because the requests never arrived.
--
-- A limiter that refuses the workload the product exists to serve is
-- misconfigured, not strict.
--
-- ── One minute's worth in hand ──
--
-- Burst now defaults to the sustained rate: "600 requests a minute"
-- means a client may spend 600 at once and then refill at 10/second.
-- That is what the number reads as to the person being told it, and
-- it is the behaviour that makes a burst-then-idle client — which is
-- every real client — work without tuning.
--
-- Anyone who needs a tighter shape sets it deliberately with
-- platform.set_api_limits(). A default should serve the common case;
-- the unusual case is what the knob is for.
-- ============================================================

alter table platform.api_client
  alter column burst set default 600,
  alter column tokens set default 600;

-- Existing clients get one minute's worth of their own rate, rather
-- than the 100 they were given by a default that was never right.
update platform.api_client
   set burst  = greatest(burst, rate_limit_per_min),
       tokens = greatest(tokens, rate_limit_per_min),
       tokens_at = now();

comment on column platform.api_client.burst is
  'How much may be spent at once. Defaults to one minute of the sustained rate, because that is what "N per minute" means to the person being told it — see migration 0039.';

-- Minting a key sets the bucket from the rate, so a client created
-- with a custom rate is not silently handed the table default.
--
-- DROP FIRST. Adding p_per_min with CREATE OR REPLACE would leave the
-- four-argument version standing beside the new one and make every
-- existing call ambiguous — the same trap migration 0037 had to undo
-- for emit_event, walked into a second time within the hour.
-- supabase/checks/function-overloads.sql now fails the build on it.
drop function if exists platform.create_api_client(text, text[], uuid[], text);

create or replace function platform.create_api_client(
  p_name         text,
  p_scopes       text[],
  p_locations    uuid[] default '{}',
  p_environment  text default 'LIVE',
  p_per_min      integer default 600
) returns table (client_id uuid, api_key text)
language plpgsql security definer
set search_path = platform, public, extensions
as $$
-- @no-scope-check: mints a credential and touches no stock. Admin only,
-- checked below.
declare
  v_key text;
  v_id  uuid;
begin
  if platform.current_role_name() <> 'admin' then
    raise exception 'FORBIDDEN_ROLE: only an admin may create an API client'
      using errcode = '42501';
  end if;

  if p_per_min < 1 then
    raise exception 'BAD_LIMIT: a rate limit of % would lock the client out entirely', p_per_min
      using errcode = '23514';
  end if;

  -- ic_live_… / ic_test_… so a key is recognisable on sight and a
  -- sandbox key pasted into production is obvious in the log.
  v_key := 'ic_' || lower(case p_environment when 'SANDBOX' then 'test' else 'live' end)
           || '_' || encode(gen_random_bytes(24), 'hex');

  insert into platform.api_client
    (name, key_hash, key_prefix, scopes, location_ids, environment,
     rate_limit_per_min, burst, tokens, tokens_at)
  values
    (p_name, encode(digest(v_key, 'sha256'), 'hex'), left(v_key, 12),
     p_scopes, p_locations, p_environment,
     p_per_min, p_per_min, p_per_min, now())
  returning id into v_id;

  client_id := v_id;
  api_key   := v_key;
  return next;
end $$;
