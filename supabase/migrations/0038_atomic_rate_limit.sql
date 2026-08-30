-- ============================================================
-- 0038 — The rate limiter leaked under concurrency
--
-- ── The bug ──
--
-- 0034 read the bucket, decided, then wrote it:
--
--   select * into c from platform.api_client where id = p_client;
--   v_avail := ... c.tokens ...;
--   if v_avail < p_cost then refuse; end if;
--   update platform.api_client set tokens = v_avail - p_cost ...;
--
-- Under READ COMMITTED that SELECT takes no lock. Fifty concurrent
-- requests all read the same starting balance, all decide there is
-- room, and all proceed — then serialise harmlessly on the UPDATE.
-- A bucket of 5 let 24 requests through.
--
-- Which is exactly the failure the limiter exists to prevent. A
-- limiter that only holds when requests arrive one at a time is not a
-- limiter; a flood is the only case that matters.
--
-- ── The fix is the one already used for overselling ──
--
-- One guarded UPDATE. The condition lives in the WHERE clause, so the
-- decision and the write are the same statement and cannot be
-- separated. When a concurrent updater holds the row, the blocked
-- statement re-evaluates its WHERE against the NEW row version once
-- the lock lifts — so the second request sees the first one's spend.
--
-- This is the same shape as stock.reserve()'s
--
--   UPDATE ... WHERE on_hand - reserved - allocated - damaged >= qty
--
-- and for the same reason. Migration 0011 wrote that rule down; the
-- limiter should have followed it, and did not.
--
-- ── Caught by the HTTP smoke test, not the unit tests ──
--
-- tests/phase8.test.mjs drives the limiter over one connection, in a
-- loop. It passed. Sequential tests cannot find a concurrency bug —
-- so a concurrent case now lives beside them.
-- ============================================================

create or replace function platform.consume_rate_token(
  p_client uuid,
  p_cost   integer default 1
) returns table (
  allowed       boolean,
  limit_per_min integer,
  remaining     integer,
  retry_after   integer,
  reason        text,
  quota_left    integer
)
language plpgsql
security definer
set search_path = platform, public
as $$
-- @no-scope-check: meters a client that authenticate_api_key() has
-- already identified. Touches no stock and reads no location data.
declare
  v_tokens  numeric(12,4);
  v_limit   integer;
  v_quota   integer;
  c         platform.api_client%rowtype;
  v_avail   numeric(12,4);
  v_rate    numeric(12,6);
  v_used    integer;
begin
  -- ── THE WHOLE THING, IN ONE STATEMENT ──
  --
  -- The refill is computed inside the UPDATE from the row's own
  -- tokens_at, so it is re-derived from the latest committed version
  -- if this statement had to wait for another. Repeating the
  -- expression in SET and WHERE is deliberate: a CTE or a subquery
  -- would read a snapshot and reintroduce the race.
  update platform.api_client c2
     set tokens = least(c2.burst::numeric,
                        c2.tokens + extract(epoch from (now() - c2.tokens_at))
                                    * (c2.rate_limit_per_min / 60.0))
                  - p_cost,
         tokens_at  = now(),
         quota_day  = current_date,
         quota_used = (case when c2.quota_day = current_date then c2.quota_used else 0 end)
                      + p_cost
   where c2.id = p_client
     and least(c2.burst::numeric,
               c2.tokens + extract(epoch from (now() - c2.tokens_at))
                           * (c2.rate_limit_per_min / 60.0)) >= p_cost
     and (c2.daily_quota is null
          or (case when c2.quota_day = current_date then c2.quota_used else 0 end) + p_cost
             <= c2.daily_quota)
  returning c2.tokens, c2.rate_limit_per_min,
            case when c2.daily_quota is null then null
                 else c2.daily_quota - c2.quota_used end
       into v_tokens, v_limit, v_quota;

  if found then
    return query select true, v_limit, floor(v_tokens)::integer, 0, null::text, v_quota;
    return;
  end if;

  -- ── Refused. Now work out why, and for how long ──
  --
  -- Off the hot path by definition: this only runs for a request that
  -- is already being turned away, so a second read costs nothing that
  -- matters.
  select * into c from platform.api_client where id = p_client;
  if not found then
    -- Cannot happen after authentication, but a limiter that assumes
    -- is a limiter that fails open.
    return query select false, 0, 0, 60, 'unknown_client'::text, null::integer;
    return;
  end if;

  v_rate  := c.rate_limit_per_min / 60.0;
  v_avail := least(c.burst::numeric,
                   c.tokens + extract(epoch from (now() - c.tokens_at)) * v_rate);
  v_used  := case when c.quota_day = current_date then c.quota_used else 0 end;

  if c.daily_quota is not null and v_used + p_cost > c.daily_quota then
    return query select
      false, c.rate_limit_per_min, greatest(0, floor(v_avail))::integer,
      -- Until midnight. Retrying sooner cannot help.
      greatest(1, extract(epoch from ((current_date + 1) - now()))::integer),
      'daily_quota_exhausted'::text,
      0;
    return;
  end if;

  return query select
    false, c.rate_limit_per_min, 0,
    -- How long until enough tokens exist. Told rather than guessed,
    -- so a well-behaved client backs off exactly as long as needed.
    greatest(1, ceil((p_cost - v_avail) / nullif(v_rate, 0))::integer),
    'rate_limited'::text,
    case when c.daily_quota is null then null else c.daily_quota - v_used end;

exception when others then
  -- Fail OPEN, loudly. A limiter outage must not take the inventory
  -- down with it; the request log still records what happened.
  return query select true, 0, 0, 0, 'limiter_error'::text, null::integer;
end $$;

comment on function platform.consume_rate_token is
  'Token bucket, spent in one guarded UPDATE. The decision and the write are the same statement — see migration 0038 for what happened when they were not.';
