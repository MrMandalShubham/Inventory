-- ============================================================
-- 0044 — Opening a session for an identity the database did not
--        authenticate
--
-- ── Why this exists ──
--
-- The single administrator's credentials now live in the environment
-- rather than in platform.credential. The password is checked by the
-- server, so the database is asked only for a session — it never sees
-- the password and has nothing to compare it against.
--
-- platform.sign_in() cannot do that: it exists precisely to verify a
-- bcrypt hash, and there is no hash.
--
-- ── The identity row is not optional ──
--
-- It is tempting to think an environment admin needs no row in
-- platform.app_user at all. It does. Some forty columns across this
-- schema reference that table — raised_by, approved_by, received_by,
-- actor_id on every ledger entry, posted_by on every journal,
-- uploaded_by_user on every photograph. Without a row, the first
-- movement anybody raises fails on a foreign key.
--
-- That is not a flaw to work around. Those columns are the audit
-- trail: "who did this" has to name somebody who exists.
--
-- ── This function is a skeleton key, so nobody but the server holds it
--
-- open_session_for() mints a valid session for ANY user id without a
-- password. Callable by a client, it would be complete privilege
-- escalation: any signed-in operator could open an admin session.
--
-- So EXECUTE is revoked from authenticated and anon. Only the roles
-- the web server itself connects as can call it, and the web server
-- never exposes it. The revoke is the whole security boundary here —
-- if a later migration grants execute broadly, this becomes the
-- largest hole in the system.
-- ============================================================

create or replace function platform.open_session_for(
  p_user       uuid,
  p_user_agent text default 'web'
) returns table (token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = platform, extensions, public
as $$
-- @no-scope-check: mints a session for a user the CALLER has already
-- authenticated by other means. Not reachable by application roles —
-- see the revoke below, which is what makes that true.
declare
  v_tok text;
  v_exp timestamptz;
  u     platform.app_user%rowtype;
begin
  select * into u from platform.app_user where id = p_user;
  if not found then
    raise exception 'NO_SUCH_USER' using errcode = 'P0002';
  end if;

  if u.status <> 'ACTIVE' then
    raise exception 'USER_NOT_ACTIVE: % is %', u.email, u.status
      using errcode = '42501';
  end if;

  v_tok := encode(gen_random_bytes(32), 'hex');
  v_exp := now() + interval '12 hours';

  -- Only the SHA-256 is stored, exactly as platform.sign_in does. A
  -- database read must never yield a usable session token.
  insert into platform.session (token_hash, user_id, user_agent, expires_at)
       values (encode(digest(v_tok, 'sha256'), 'hex'), p_user, p_user_agent, v_exp);

  token := v_tok;
  expires_at := v_exp;
  return next;
end $$;

revoke execute on function platform.open_session_for(uuid, text) from public;
revoke execute on function platform.open_session_for(uuid, text) from authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function platform.open_session_for(uuid, text) from anon';
  end if;
end $$;

comment on function platform.open_session_for is
  'Mints a session without a password, for an identity the server authenticated itself. EXECUTE is deliberately revoked from application roles — granting it back would let any signed-in user become an admin.';

-- ─────────────── the environment admin's identity row ───────────────

/**
 * Make sure the configured administrator exists, and return their id.
 *
 * Idempotent, and deliberately does NOT overwrite an existing row's
 * role or name: if somebody has been given a different role in the
 * database, a restart of the web server should not silently promote
 * them back.
 */
create or replace function platform.ensure_admin(
  p_email text,
  p_name  text default 'Administrator'
) returns uuid
language plpgsql
security definer
set search_path = platform, public
as $$
-- @no-scope-check: creates the single administrator identity at
-- startup. Not reachable by application roles — revoked below.
declare v_id uuid;
begin
  select id into v_id from platform.app_user where lower(email) = lower(p_email);
  if found then return v_id; end if;

  insert into platform.app_user (email, full_name, role, all_locations, status)
       values (lower(p_email), p_name, 'admin', true, 'ACTIVE')
    returning id into v_id;

  return v_id;
end $$;

revoke execute on function platform.ensure_admin(text, text) from public;
revoke execute on function platform.ensure_admin(text, text) from authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function platform.ensure_admin(text, text) from anon';
  end if;
end $$;
