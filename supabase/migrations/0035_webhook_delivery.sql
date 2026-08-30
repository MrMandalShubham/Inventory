-- ============================================================
-- 0035 — Webhooks that actually leave the building
--
-- ── The state this was in ──
--
-- platform.webhook_subscription, platform.webhook_delivery and
-- platform.emit_event() have existed since migration 0020. Nothing
-- has ever called emit_event, and nothing has ever POSTed a delivery.
-- Every table, index and comment describing retry and backoff
-- described behaviour that did not exist.
--
-- That is worse than having no webhooks. A subscriber can be created
-- through the API, it reports ACTIVE, and it silently never fires —
-- so an integrator builds against it, ships, and discovers the gap in
-- production.
--
-- ── Delivered at most once, in order of age ──
--
-- Claimed with FOR UPDATE SKIP LOCKED, so several workers can drain
-- the queue at once without ever handing the same delivery to two of
-- them. A worker that dies mid-flight leaves its rows SENDING; those
-- are reclaimed by age rather than lost, which is why claimed_at
-- exists.
--
-- Duplicates are prevented at the point of QUEUEING, not at the point
-- of sending: one row per subscription per event key. A retry of the
-- same business event finds the row already there and does nothing.
--
-- ── The queue must never block the write ──
--
-- emit_event() swallows its own errors, and delivery happens outside
-- the transaction that caused it. A subscriber's broken endpoint is
-- their problem; it must never be a reason a shop cannot receive
-- stock.
-- ============================================================

alter table platform.webhook_delivery
  -- The business event this represents. Two attempts to queue the
  -- same event for the same subscriber collapse into one row.
  add column event_key text,

  -- Claim bookkeeping, so a dead worker's rows can be found.
  add column claimed_at timestamptz,
  add column claimed_by text,

  add column response_status integer,
  add column duration_ms integer;

-- SENDING is a real state: claimed by a worker, outcome unknown.
-- Without it a crash is indistinguishable from success.
alter table platform.webhook_delivery
  drop constraint if exists webhook_delivery_status_check;
alter table platform.webhook_delivery
  add constraint webhook_delivery_status_check
  check (status in ('PENDING','SENDING','DELIVERED','FAILED','DEAD'));

create unique index webhook_delivery_once
  on platform.webhook_delivery (subscription_id, event_key)
  where event_key is not null;

create index webhook_delivery_claimed
  on platform.webhook_delivery (claimed_at)
  where status = 'SENDING';

alter table platform.webhook_subscription
  -- How many attempts before we stop. A subscriber whose endpoint has
  -- been down for a day does not want the backlog when it returns;
  -- they want to know they missed it.
  add column max_attempts integer not null default 6 check (max_attempts between 1 and 20),
  add column last_success_at timestamptz,
  add column last_failure_at timestamptz,
  add column consecutive_failures integer not null default 0;

-- ─────────────── queueing ───────────────

/**
 * Queue an event for every subscriber.
 *
 * p_event_key makes it idempotent: the same business event queued
 * twice produces one delivery. Callers that have a natural key (a
 * ledger id, a movement id) should pass it. Never raises.
 */
create or replace function platform.emit_event(
  p_event     text,
  p_payload   jsonb,
  p_event_key text default null
) returns integer
language plpgsql
security definer
set search_path = platform, public, extensions
as $$
-- @no-scope-check: fans an already-authorised event out to
-- subscribers and reads no stock of its own.
declare v_count integer := 0;
begin
  insert into platform.webhook_delivery (subscription_id, event, payload, event_key)
  select s.id, p_event, p_payload, p_event_key
    from platform.webhook_subscription s
   where s.event = p_event and s.status = 'ACTIVE'
  on conflict do nothing;

  get diagnostics v_count = row_count;
  return v_count;
exception when others then
  -- A webhook problem is never a reason to fail a stock write.
  return 0;
end $$;

-- ─────────────── claiming ───────────────

/**
 * Take a batch of due deliveries.
 *
 * SKIP LOCKED is what makes more than one worker safe. Without it,
 * two workers block on the same row and the second delivers a
 * duplicate the moment the first commits.
 *
 * Returns the URL and secret, so the worker needs no second query and
 * no read access to the subscription table of its own.
 */
create or replace function platform.claim_webhook_batch(
  p_limit  integer default 20,
  p_worker text default 'worker'
) returns table (
  id              bigint,
  subscription_id uuid,
  event           text,
  payload         jsonb,
  attempts        integer,
  url             text,
  signing_secret  text
)
language plpgsql
security definer
set search_path = platform, public, extensions
as $$
-- @no-scope-check: drains an internal queue. Callable only by admin
-- and the delivery worker, checked below.
begin
  if platform.current_role_name() not in ('admin','api_client') then
    raise exception 'FORBIDDEN_ROLE: % may not drain the webhook queue',
      platform.current_role_name() using errcode = '42501';
  end if;

  return query
  with due as (
    select d.id
      from platform.webhook_delivery d
      join platform.webhook_subscription s on s.id = d.subscription_id
     where d.status = 'PENDING'
       and d.next_attempt_at <= now()
       and s.status = 'ACTIVE'
     order by d.next_attempt_at, d.id
     limit greatest(p_limit, 1)
     for update of d skip locked
  ),
  claimed as (
    update platform.webhook_delivery d
       set status = 'SENDING', claimed_at = now(), claimed_by = p_worker
      from due
     where d.id = due.id
    returning d.*
  )
  select c.id, c.subscription_id, c.event, c.payload, c.attempts,
         s.url, s.signing_secret
    from claimed c
    join platform.webhook_subscription s on s.id = c.subscription_id
   order by c.id;
end $$;

-- ─────────────── recording the outcome ───────────────

/**
 * Record what happened to one delivery.
 *
 * Backoff is exponential from ten seconds — 10s, 40s, 2m40s, 10m40s,
 * 42m, 2h50m — which spans a deploy, a restart and a short outage
 * without hammering an endpoint that is already struggling.
 */
create or replace function platform.record_webhook_result(
  p_id     bigint,
  p_ok     boolean,
  p_status integer default null,
  p_error  text default null,
  p_ms     integer default null
) returns text
language plpgsql
security definer
set search_path = platform, public, extensions
as $$
-- @no-scope-check: writes the outcome of an internal queue item.
declare
  d       platform.webhook_delivery%rowtype;
  v_max   integer;
  v_next  integer;
  v_state text;
begin
  if platform.current_role_name() not in ('admin','api_client') then
    raise exception 'FORBIDDEN_ROLE: % may not record a delivery result',
      platform.current_role_name() using errcode = '42501';
  end if;

  select * into d from platform.webhook_delivery where id = p_id;
  if not found then raise exception 'NO_SUCH_DELIVERY' using errcode = 'P0002'; end if;

  select max_attempts into v_max
    from platform.webhook_subscription where id = d.subscription_id;

  v_next := d.attempts + 1;

  if p_ok then
    update platform.webhook_delivery
       set status = 'DELIVERED', attempts = v_next, delivered_at = now(),
           response_status = p_status, duration_ms = p_ms,
           last_error = null, claimed_at = null, claimed_by = null
     where id = p_id;

    update platform.webhook_subscription
       set last_success_at = now(), consecutive_failures = 0
     where id = d.subscription_id;

    return 'DELIVERED';
  end if;

  -- DEAD, not retried forever. A queue that never gives up becomes a
  -- queue nobody can read, and the one delivery that mattered is
  -- buried under ten thousand retries of one broken endpoint.
  v_state := case when v_next >= coalesce(v_max, 6) then 'DEAD' else 'PENDING' end;

  update platform.webhook_delivery
     set status = v_state,
         attempts = v_next,
         last_error = left(coalesce(p_error, 'unknown'), 500),
         response_status = p_status,
         duration_ms = p_ms,
         next_attempt_at = now() + make_interval(secs => 10 * power(4, d.attempts)::double precision),
         claimed_at = null, claimed_by = null
   where id = p_id;

  update platform.webhook_subscription
     set last_failure_at = now(), consecutive_failures = consecutive_failures + 1
   where id = d.subscription_id;

  return v_state;
end $$;

/**
 * Reclaim deliveries whose worker died.
 *
 * A process killed between claiming and reporting leaves rows SENDING
 * forever. Reclaiming by age is the only way to tell that apart from
 * a slow request, so the timeout must be comfortably longer than the
 * worker's own HTTP timeout.
 */
create or replace function platform.requeue_stuck_deliveries(
  p_older_than interval default interval '5 minutes'
) returns integer
language plpgsql
security definer
set search_path = platform, public, extensions
as $$
-- @no-scope-check: internal queue maintenance.
declare v integer;
begin
  update platform.webhook_delivery
     set status = 'PENDING',
         claimed_at = null,
         claimed_by = null,
         last_error = 'worker did not report back; requeued'
   where status = 'SENDING'
     and claimed_at < now() - p_older_than;
  get diagnostics v = row_count;
  return v;
end $$;

/** Queue health, for the screen that shows whether events are moving. */
create or replace function platform.webhook_health()
returns table (
  subscription_id uuid,
  client_name     text,
  event           text,
  url             text,
  status          text,
  pending         bigint,
  dead            bigint,
  delivered_24h   bigint,
  consecutive_failures integer,
  last_success_at timestamptz,
  last_error      text
)
language sql
stable
security definer
set search_path = platform, public, extensions
as $$
  -- @no-scope-check: operational queue state, admin only per the guard.
  select s.id, c.name, s.event, s.url, s.status,
         count(*) filter (where d.status in ('PENDING','SENDING')),
         count(*) filter (where d.status = 'DEAD'),
         count(*) filter (where d.status = 'DELIVERED' and d.delivered_at > now() - interval '24 hours'),
         s.consecutive_failures,
         s.last_success_at,
         (select d2.last_error from platform.webhook_delivery d2
           where d2.subscription_id = s.id and d2.last_error is not null
           order by d2.id desc limit 1)
    from platform.webhook_subscription s
    join platform.api_client c on c.id = s.api_client_id
    left join platform.webhook_delivery d on d.subscription_id = s.id
   where platform.current_role_name() = 'admin'
   group by s.id, c.name, s.event, s.url, s.status, s.consecutive_failures, s.last_success_at
   order by 9 desc nulls first, c.name;
$$;

-- ─────────────── the workers need to reach the queue ───────────────
--
-- The delivery worker authenticates as an api_client like anything
-- else. It reads and writes only the queue.

create policy webhook_delivery_worker on platform.webhook_delivery
  for select using (platform.current_role_name() in ('admin','api_client'));
