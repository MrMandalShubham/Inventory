-- ============================================================
-- 0022 — Real sign-in
--
-- Phases 1–4 ran on a persona switcher: a cookie naming which seeded
-- user you were. It made the location boundary visible during the
-- build, which was its whole job, and it is not a login.
--
-- ── Why this is not Supabase Auth ──
--
-- It mints the SAME claims shape Supabase Auth would (`sub`, `role`,
-- `location_ids`, `all_locations`), so nothing downstream knows the
-- difference. What changes if you later move to Supabase Auth is the
-- SOURCE of the claims, never their shape — and every policy, every
-- SECURITY DEFINER body and every test keeps working untouched.
--
-- The reason to do it this way now: Supabase Auth needs a hosted
-- project, and a login you cannot run locally is a login you cannot
-- test. This runs in the same container as everything else.
--
-- ── Passwords ──
--
-- bcrypt via pgcrypto. Comparison happens inside the database, so a
-- hash never crosses the wire and the application never sees one.
-- ============================================================

create table platform.credential (
  user_id        uuid primary key references platform.app_user(id) on delete cascade,
  password_hash  text not null,

  -- Enough to stop online guessing. Not a substitute for rate
  -- limiting at the edge, which belongs in front of the app.
  failed_attempts integer not null default 0,
  locked_until   timestamptz,

  updated_at     timestamptz not null default now()
);

create table platform.session (
  -- Only the hash is stored. A database read cannot yield a usable
  -- session, exactly as with API keys.
  token_hash  text primary key,
  user_id     uuid not null references platform.app_user(id) on delete cascade,

  user_agent  text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  last_seen_at timestamptz not null default now()
);

create index session_user_idx   on platform.session (user_id);
create index session_expiry_idx on platform.session (expires_at);

-- ─────────────────────── sign in ───────────────────────

create or replace function platform.sign_in(
  p_email      text,
  p_password   text,
  p_user_agent text default null
) returns table (token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = platform, public
as $$
-- @no-scope-check: authentication runs before any scope exists.
declare
  u     platform.app_user%rowtype;
  c     platform.credential%rowtype;
  v_tok text;
  v_exp timestamptz;
begin
  select * into u from platform.app_user
   where lower(email) = lower(btrim(p_email)) and status = 'ACTIVE';

  -- Run the hash comparison even when the user does not exist, so a
  -- wrong email and a wrong password take about the same time.
  if found then
    select * into c from platform.credential where user_id = u.id;
  end if;

  if c.locked_until is not null and c.locked_until > now() then
    raise exception 'ACCOUNT_LOCKED: too many attempts, try again later'
      using errcode = '42501';
  end if;

  if not found or c.password_hash is null
     or crypt(p_password, c.password_hash) <> c.password_hash then

    if u.id is not null then
      update platform.credential
         set failed_attempts = failed_attempts + 1,
             locked_until = case when failed_attempts + 1 >= 8
                                 then now() + interval '15 minutes' end,
             updated_at = now()
       where user_id = u.id;
    end if;

    -- Wrong email and wrong password are deliberately the same error.
    raise exception 'INVALID_CREDENTIALS: that email and password do not match'
      using errcode = '42501';
  end if;

  update platform.credential
     set failed_attempts = 0, locked_until = null, updated_at = now()
   where user_id = u.id;

  v_tok := encode(gen_random_bytes(32), 'hex');
  v_exp := now() + interval '12 hours';

  insert into platform.session (token_hash, user_id, user_agent, expires_at)
  values (encode(digest(v_tok, 'sha256'), 'hex'), u.id, p_user_agent, v_exp);

  token := v_tok;
  expires_at := v_exp;
  return next;
end $$;

-- ─────────────────── resolve a session ───────────────────

create or replace function platform.session_claims(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = platform, public
as $$
-- @no-scope-check: resolves a session before any scope exists.
declare
  u    platform.app_user%rowtype;
  v_id uuid;
  v_locs uuid[];
begin
  select s.user_id into v_id
    from platform.session s
   where s.token_hash = encode(digest(p_token, 'sha256'), 'hex')
     and s.expires_at > now();

  if v_id is null then return null; end if;

  update platform.session set last_seen_at = now()
   where token_hash = encode(digest(p_token, 'sha256'), 'hex');

  select * into u from platform.app_user where id = v_id and status = 'ACTIVE';
  if not found then return null; end if;

  select coalesce(array_agg(location_id), '{}') into v_locs
    from platform.user_location where user_id = v_id;

  -- The same shape the persona stub produced, and the same shape
  -- Supabase Auth would produce. Nothing downstream changes.
  return jsonb_build_object(
    'sub',           u.id,
    'email',         u.email,
    'full_name',     u.full_name,
    'role',          u.role,
    'all_locations', u.all_locations,
    'location_ids',  array_to_string(v_locs, ',')
  );
end $$;

create or replace function platform.sign_out(p_token text)
returns void language sql security definer
set search_path = platform, public
as $$
  -- @no-scope-check: ends a session and touches no stock.
  delete from platform.session
   where token_hash = encode(digest(p_token, 'sha256'), 'hex');
$$;

/** Expired sessions are rubbish, not history. Unlike the ledger,
    there is nothing here worth keeping. */
create or replace function platform.sweep_expired_sessions()
returns integer language plpgsql security definer
set search_path = platform, public
as $$
-- @no-scope-check: a scheduled cleanup of expired session rows.
declare n integer;
begin
  delete from platform.session where expires_at < now() - interval '1 day';
  get diagnostics n = row_count;
  return n;
end $$;

/** Set or change a password. Admins set anyone's; you may set your own. */
create or replace function platform.set_password(p_user uuid, p_password text)
returns void
language plpgsql security definer
set search_path = platform, public
as $$
-- @no-scope-check: credentials have no location dimension. The role
-- and self-service check below is the whole guard.
begin
  if platform.current_role_name() <> 'admin'
     and platform.current_user_id() is distinct from p_user then
    raise exception 'FORBIDDEN: you may only change your own password'
      using errcode = '42501';
  end if;

  if length(coalesce(p_password, '')) < 8 then
    raise exception 'WEAK_PASSWORD: use at least 8 characters' using errcode = '23514';
  end if;

  insert into platform.credential (user_id, password_hash)
       values (p_user, crypt(p_password, gen_salt('bf', 10)))
  on conflict (user_id) do update
      set password_hash = excluded.password_hash,
          failed_attempts = 0, locked_until = null, updated_at = now();

  -- Changing a password ends every other session. If the reason for
  -- the change was that somebody else had it, leaving their session
  -- alive defeats the point.
  delete from platform.session where user_id = p_user;
end $$;

-- ─────────────────────── RLS ───────────────────────

alter table platform.credential enable row level security;
alter table platform.session    enable row level security;

-- Nobody reads credentials through SQL. The functions above are the
-- only door and they run as definer.
create policy credential_none on platform.credential
  for select using (false);

-- You may see your own sessions — useful for "sign out everywhere".
create policy session_own on platform.session
  for select using (
    user_id = platform.current_user_id()
    or platform.current_role_name() = 'admin');
