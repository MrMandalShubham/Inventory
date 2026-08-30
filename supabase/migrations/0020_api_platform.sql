-- ============================================================
-- 0020 — The API platform
--
-- Keys, idempotency records, the request log and webhooks.
--
-- ── Two layers of idempotency, doing different jobs ──
--
--   stock.idempotency        the DB layer. Stops a retry posting a
--                            second ledger entry.
--   platform.idempotency_record  the API layer. Returns the ORIGINAL
--                            RESPONSE BODY, byte for byte.
--
-- The second is what a consuming app actually needs. A retry that
-- correctly declines to move stock but answers "409 already exists"
-- still breaks the client, because the client never learned the id
-- of the thing it created.
--
-- ── On sandbox mode ──
--
-- The plan called for a sandbox flag on the client. That is the
-- wrong shape here: a flag means simulated responses, and a
-- simulated response is a lie that developers will eventually ship
-- against. Under one-deployment-per-business (docs/02 §3) a sandbox
-- is simply another deployment with its own database and its own
-- base URL. Nothing to build, nothing to fake, no way for test
-- traffic to touch real stock. `environment` below records which
-- one this is so a key cannot be pasted into the wrong host.
-- ============================================================

create extension if not exists pgcrypto;

-- ─────────────────── keys ───────────────────

alter table platform.api_client
  add column environment text not null default 'LIVE'
      check (environment in ('LIVE','SANDBOX')),
  add column key_prefix text,
  add column rate_limit_per_min integer not null default 600;

-- The prefix is the first 12 characters, stored in clear so a key can
-- be identified in a log or a UI without ever storing the key itself.
create index api_client_prefix_idx on platform.api_client (key_prefix);

/**
 * Mint a key. The plaintext is returned ONCE and never stored — only
 * its SHA-256. A database read must not yield a usable key.
 */
create or replace function platform.create_api_client(
  p_name         text,
  p_scopes       text[],
  p_locations    uuid[] default '{}',
  p_environment  text default 'LIVE'
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

  -- ic_live_… / ic_test_… so a key is recognisable on sight and a
  -- sandbox key pasted into production is obvious in the log.
  v_key := 'ic_' || lower(case p_environment when 'SANDBOX' then 'test' else 'live' end)
           || '_' || encode(gen_random_bytes(24), 'hex');

  insert into platform.api_client
    (name, key_hash, key_prefix, scopes, location_ids, environment)
  values
    (p_name, encode(digest(v_key, 'sha256'), 'hex'), left(v_key, 12),
     p_scopes, p_locations, p_environment)
  returning id into v_id;

  client_id := v_id;
  api_key := v_key;
  return next;
end $$;

/**
 * Resolve a presented key to the claims a request should run under.
 * Returns null for anything unknown, revoked or expired — the caller
 * cannot tell which, deliberately.
 */
create or replace function platform.authenticate_api_key(p_key text)
returns jsonb
language plpgsql security definer
set search_path = platform, public, extensions
as $$
-- @no-scope-check: authentication runs before any scope exists.
declare c platform.api_client%rowtype;
begin
  select * into c from platform.api_client
   where key_hash = encode(digest(p_key, 'sha256'), 'hex')
     and status = 'ACTIVE'
     and (expires_at is null or expires_at > now());

  if not found then return null; end if;

  update platform.api_client set last_used_at = now() where id = c.id;

  -- An API client is not a user. It gets a scope set, never a session.
  return jsonb_build_object(
    'sub',           c.id,
    'role',          'api_client',
    'client_id',     c.id,
    'client_name',   c.name,
    'scopes',        to_jsonb(c.scopes),
    'environment',   c.environment,
    'rate_limit',    c.rate_limit_per_min,
    'location_ids',  array_to_string(c.location_ids, ','),
    'all_locations', coalesce(array_length(c.location_ids, 1), 0) = 0
  );
end $$;

-- An API client with no locations named holds every location. That is
-- the opposite of the rule for humans (migration 0009) and it is
-- deliberate: a key is issued by an admin in one deliberate act, with
-- its locations chosen at that moment, whereas a user's location list
-- is assembled from joins that can silently come back empty.
comment on column platform.api_client.location_ids is
  'Empty means every location. Set deliberately at mint time — unlike a user, where empty must never mean all.';

-- ─────────────────── idempotency records ───────────────────

create table platform.idempotency_record (
  api_client_id uuid not null references platform.api_client(id) on delete cascade,
  key           text not null,

  method        text not null,
  path          text not null,
  -- So a client reusing a key for a DIFFERENT request gets told,
  -- rather than silently receiving someone else's answer.
  request_hash  text not null,

  status_code   integer not null,
  response_body jsonb not null,

  created_at    timestamptz not null default now(),

  primary key (api_client_id, key)
);

create index idempotency_record_age on platform.idempotency_record (created_at);

-- ─────────────────── the request log ───────────────────

create table platform.api_request (
  id            bigint generated always as identity primary key,
  api_client_id uuid references platform.api_client(id) on delete set null,

  method        text not null,
  path          text not null,
  status_code   integer not null,
  error_code    text,

  idempotency_key text,
  replayed      boolean not null default false,

  duration_ms   integer,
  occurred_at   timestamptz not null default now()
);

create index api_request_client_idx on platform.api_request (api_client_id, occurred_at desc);
create index api_request_time_idx   on platform.api_request (occurred_at desc);

-- ─────────────────── webhooks ───────────────────

create table platform.webhook_subscription (
  id            uuid primary key default gen_random_uuid(),
  api_client_id uuid not null references platform.api_client(id) on delete cascade,

  event         text not null check (event in
                  ('stock.changed','stock.low','movement.closed','reservation.expired')),
  url           text not null,
  -- Payloads are signed so the receiver can verify they came from us.
  signing_secret text not null default encode(gen_random_bytes(24), 'hex'),

  status        text not null default 'ACTIVE' check (status in ('ACTIVE','PAUSED')),
  created_at    timestamptz not null default now(),

  unique (api_client_id, event, url)
);

create table platform.webhook_delivery (
  id              bigint generated always as identity primary key,
  subscription_id uuid not null references platform.webhook_subscription(id) on delete cascade,

  event           text not null,
  payload         jsonb not null,

  status          text not null default 'PENDING'
                  check (status in ('PENDING','DELIVERED','FAILED','DEAD')),
  attempts        integer not null default 0,
  last_error      text,

  -- Exponential backoff, then a dead letter. A webhook that cannot be
  -- delivered must never block the write that caused it.
  next_attempt_at timestamptz not null default now(),
  delivered_at    timestamptz,
  created_at      timestamptz not null default now()
);

create index webhook_delivery_due on platform.webhook_delivery (status, next_attempt_at)
  where status = 'PENDING';

/** Queue an event for every subscriber. Never raises — a webhook
    problem is not a reason to fail a stock write. */
create or replace function platform.emit_event(p_event text, p_payload jsonb)
returns integer
language plpgsql security definer
set search_path = platform, public, extensions
as $$
-- @no-scope-check: fans an already-authorised event out to subscribers
-- and reads no stock of its own.
declare v_count integer := 0;
begin
  insert into platform.webhook_delivery (subscription_id, event, payload)
  select s.id, p_event, p_payload
    from platform.webhook_subscription s
   where s.event = p_event and s.status = 'ACTIVE';

  get diagnostics v_count = row_count;
  return v_count;
exception when others then
  return 0;
end $$;

-- ─────────────────────── RLS ───────────────────────

alter table platform.idempotency_record  enable row level security;
alter table platform.api_request         enable row level security;
alter table platform.webhook_subscription enable row level security;
alter table platform.webhook_delivery    enable row level security;

create policy idempotency_admin on platform.idempotency_record
  for select using (platform.current_role_name() = 'admin');

-- Finance sees the request log too: it is the usage record that a
-- per-app bill would eventually be based on.
create policy api_request_read on platform.api_request
  for select using (platform.current_role_name() in ('admin','finance'));

create policy webhook_sub_admin on platform.webhook_subscription
  for all using (platform.current_role_name() = 'admin')
  with check (platform.current_role_name() = 'admin');

create policy webhook_delivery_admin on platform.webhook_delivery
  for select using (platform.current_role_name() = 'admin');

create trigger api_client_key_audit
  after update on platform.api_client
  for each row execute function platform.record_audit();
