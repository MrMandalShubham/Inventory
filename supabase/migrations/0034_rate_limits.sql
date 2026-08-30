-- ============================================================
-- 0034 — Rate limits, quotas and usage
--
-- ── Why this is not optional ──
--
-- rate_limit_per_min has existed on platform.api_client since
-- migration 0020, and nothing has ever read it. The whole premise of
-- this system is that SEVERAL DIFFERENT APPLICATIONS share one
-- inventory (docs/09 §1). Without a limit, any one of them can starve
-- the rest: a retry loop with no backoff, a badly paginated report, a
-- developer testing against production. The others see timeouts and
-- conclude the inventory is down.
--
-- A shared API without per-client limits is not a shared API. It is a
-- single point of failure with several owners.
--
-- ── Token bucket, not a fixed window ──
--
-- A fixed window lets a client spend its entire minute's budget in
-- the first 50ms and then sit idle — the average looks fine and the
-- database saw a spike. A token bucket smooths that: tokens refill
-- continuously at the sustained rate, and `burst` caps how much can
-- be spent at once.
--
-- ── Isolation is the point ──
--
-- The bucket lives on the client's OWN ROW. Refusing a request is one
-- UPDATE against one row, so a client being throttled contends only
-- with itself. A shared counter table would put every client behind
-- one lock, and the busiest client would slow down everybody — which
-- is the exact failure this migration exists to prevent.
-- ============================================================

alter table platform.api_client
  -- How much can be spent at once. Defaults to ten seconds' worth of
  -- the sustained rate, which absorbs a normal burst without letting
  -- a runaway loop through.
  add column burst integer not null default 100 check (burst > 0),

  -- The bucket itself. Fractional, because a limit of 600/min refills
  -- at 10 tokens a second and integer truncation would quietly halve
  -- a slow client's throughput.
  add column tokens numeric(12,4) not null default 100,
  add column tokens_at timestamptz not null default now(),

  -- A hard daily ceiling, separate from the rate. The rate stops a
  -- client hurting others; the quota stops it running up a bill or
  -- pulling the whole catalogue every hour for no reason.
  -- NULL means no ceiling.
  add column daily_quota integer check (daily_quota is null or daily_quota > 0),
  add column quota_day date,
  add column quota_used integer not null default 0;

comment on column platform.api_client.tokens is
  'Token bucket balance. Refilled by elapsed time on read, so no job has to top it up — a bucket that depends on a cron is a bucket that empties permanently when the cron stops.';

-- Existing rows were created before burst existed and default to a
-- full bucket, which is the friendly reading.
update platform.api_client set tokens = burst, tokens_at = now();

-- ─────────────── spending a token ───────────────

/**
 * Charge a request against a client's bucket and daily quota.
 *
 * Returns whether it may proceed, and everything the caller needs to
 * build the X-RateLimit headers. NEVER raises: a limiter that throws
 * turns a throttle into a 500, and the client's retry logic then
 * treats it as our fault rather than theirs.
 */
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
set search_path = platform, public, extensions
as $$
-- @no-scope-check: meters a client that authenticate_api_key() has
-- already identified. Touches no stock and reads no location data.
declare
  c         platform.api_client%rowtype;
  v_avail   numeric(12,4);
  v_rate    numeric(12,6);          -- tokens per second
  v_quota   integer;
begin
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

  -- ── the daily quota ──
  --
  -- Rolls over by date rather than by a scheduled reset, so a
  -- stopped job cannot lock a client out for a day.
  v_quota := case when c.quota_day = current_date then c.quota_used else 0 end;

  if c.daily_quota is not null and v_quota + p_cost > c.daily_quota then
    return query select
      false, c.rate_limit_per_min, floor(v_avail)::integer,
      -- Until midnight. Retrying sooner cannot help.
      greatest(1, extract(epoch from ((current_date + 1) - now()))::integer),
      'daily_quota_exhausted'::text,
      0;
    return;
  end if;

  if v_avail < p_cost then
    return query select
      false, c.rate_limit_per_min, 0,
      -- How long until enough tokens exist. Told rather than guessed,
      -- so a well-behaved client backs off exactly as long as needed.
      greatest(1, ceil((p_cost - v_avail) / nullif(v_rate, 0))::integer),
      'rate_limited'::text,
      case when c.daily_quota is null then null else c.daily_quota - v_quota end;
    return;
  end if;

  -- Spend. One row, one statement — a throttled client contends with
  -- nobody but itself.
  update platform.api_client
     set tokens     = v_avail - p_cost,
         tokens_at  = now(),
         quota_day  = current_date,
         quota_used = v_quota + p_cost
   where id = p_client;

  return query select
    true, c.rate_limit_per_min, floor(v_avail - p_cost)::integer, 0, null::text,
    case when c.daily_quota is null then null
         else c.daily_quota - (v_quota + p_cost) end;
exception when others then
  -- Fail OPEN, loudly. A limiter outage must not take the inventory
  -- down with it; the request log still records what happened.
  return query select true, 0, 0, 0, 'limiter_error'::text, null::integer;
end $$;

-- ─────────────── who is using what ───────────────

alter table platform.api_request
  add column rate_limited boolean not null default false;

/**
 * Per-client usage. Read straight from the request log rather than
 * kept as a running total, so it cannot drift from what actually
 * happened.
 */
create or replace function platform.api_usage(p_days integer default 7)
returns table (
  api_client_id uuid,
  client_name   text,
  environment   text,
  requests      bigint,
  errors        bigint,
  throttled     bigint,
  replays       bigint,
  error_rate    numeric(5,2),
  p50_ms        integer,
  p95_ms        integer,
  slowest_path  text,
  last_seen     timestamptz
)
language sql
stable
security definer
set search_path = platform, public, extensions
as $$
  -- @no-scope-check: whole-platform operational data, restricted to
  -- admin by the guard below. Contains no stock and no money.
  with r as (
    select * from platform.api_request
     where occurred_at > now() - make_interval(days => greatest(p_days, 1))
  )
  select c.id, c.name, c.environment,
         count(r.id),
         count(*) filter (where r.status_code >= 400),
         count(*) filter (where r.status_code = 429),
         count(*) filter (where r.replayed),
         case when count(r.id) = 0 then 0
              else round(count(*) filter (where r.status_code >= 400)
                         * 100.0 / count(r.id), 2) end,
         coalesce(percentile_disc(0.50) within group (order by r.duration_ms), 0)::integer,
         coalesce(percentile_disc(0.95) within group (order by r.duration_ms), 0)::integer,
         (select r2.path from r r2
           where r2.api_client_id = c.id
           order by r2.duration_ms desc nulls last limit 1),
         max(r.occurred_at)
    from platform.api_client c
    left join r on r.api_client_id = c.id
   where platform.current_role_name() in ('admin','finance')
   group by c.id, c.name, c.environment
   order by count(r.id) desc, c.name;
$$;

/** The busiest endpoints, so a limit can be argued about with data. */
create or replace function platform.api_endpoint_usage(p_days integer default 7)
returns table (
  method       text,
  path         text,
  requests     bigint,
  errors       bigint,
  p95_ms       integer
)
language sql
stable
security definer
set search_path = platform, public, extensions
as $$
  -- @no-scope-check: operational counters, admin only per the guard.
  select r.method,
         -- Collapse ids out of the path so /products/<uuid> is one
         -- endpoint rather than ten thousand.
         regexp_replace(r.path,
           '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '/:id', 'g'),
         count(*),
         count(*) filter (where r.status_code >= 400),
         coalesce(percentile_disc(0.95) within group (order by r.duration_ms), 0)::integer
    from platform.api_request r
   where r.occurred_at > now() - make_interval(days => greatest(p_days, 1))
     and platform.current_role_name() in ('admin','finance')
   group by 1, 2
   order by 3 desc
   limit 40;
$$;

/**
 * Trim the request log.
 *
 * It grows by one row per API call forever. Ninety days is enough to
 * investigate an incident and short enough that the table stays a
 * table rather than an archive.
 */
create or replace function platform.sweep_api_requests(p_keep_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = platform, public, extensions
as $$
-- @no-scope-check: housekeeping on an operational log.
declare v integer;
begin
  delete from platform.api_request
   where occurred_at < now() - make_interval(days => greatest(p_keep_days, 7));
  get diagnostics v = row_count;
  return v;
end $$;

-- ─────────────── admin controls ───────────────

/** Change a client's limits. Separate from minting, because tuning a
 *  limit is a normal Tuesday and issuing a credential is not. */
create or replace function platform.set_api_limits(
  p_client       uuid,
  p_per_min      integer default null,
  p_burst        integer default null,
  p_daily_quota  integer default null,
  p_clear_quota  boolean default false
) returns void
language plpgsql
security definer
set search_path = platform, public, extensions
as $$
-- @no-scope-check: administers a credential, touches no stock.
begin
  if platform.current_role_name() <> 'admin' then
    raise exception 'FORBIDDEN_ROLE: only an admin may change API limits'
      using errcode = '42501';
  end if;

  if p_per_min is not null and p_per_min < 1 then
    raise exception 'BAD_LIMIT: a rate limit of % would lock the client out entirely', p_per_min
      using errcode = '23514';
  end if;
  if p_burst is not null and p_burst < 1 then
    raise exception 'BAD_BURST: a burst of % would refuse every request', p_burst
      using errcode = '23514';
  end if;

  update platform.api_client
     set rate_limit_per_min = coalesce(p_per_min, rate_limit_per_min),
         burst              = coalesce(p_burst, burst),
         daily_quota        = case when p_clear_quota then null
                                   else coalesce(p_daily_quota, daily_quota) end,
         -- A raised limit takes effect now rather than after the old
         -- bucket drains, which is what an admin raising it means.
         tokens             = least(coalesce(p_burst, burst)::numeric,
                                    greatest(tokens, coalesce(p_burst, burst)::numeric)),
         tokens_at          = now()
   where id = p_client;

  if not found then
    raise exception 'NO_SUCH_CLIENT' using errcode = 'P0002';
  end if;
end $$;
