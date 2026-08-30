-- ============================================================
-- 0045 — Marking the two functions no application role may call
--
-- Migration 0044 revoked EXECUTE on open_session_for() and
-- ensure_admin(), and 99-grants.sql granted it straight back four
-- lines later, because that file runs after every migration and says
-- `grant execute on all functions`.
--
-- The revoke was written. The comment claimed it was the security
-- boundary. It was undone immediately, and nothing noticed until a
-- probe asserted that an operator could NOT call it — and found that
-- they could, which is complete privilege escalation: mint a session
-- for any user id, without a password.
--
-- The fix is not another revoke in another migration; that would be
-- undone the same way. 99-grants.sql now DISCOVERS server-only
-- functions and revokes them last, after its blanket grant. A
-- function declares itself with a marker in its own body — the same
-- convention as @no-scope-check, so the marker cannot drift away from
-- the thing it describes.
--
-- This migration adds the marker.
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
-- authenticated by other means.
--
-- @server-only: this is a skeleton key. It returns a valid session for
-- ANY user id with no password, so that the web server can sign in an
-- administrator whose credentials live in the environment. Reachable
-- by `authenticated`, any signed-in operator becomes an admin.
-- 99-grants.sql revokes EXECUTE from every application role on the
-- strength of this marker, and supabase/checks/server-only.sql fails
-- the build if that ever stops being true.
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

  insert into platform.session (token_hash, user_id, user_agent, expires_at)
       values (encode(digest(v_tok, 'sha256'), 'hex'), p_user, p_user_agent, v_exp);

  token := v_tok;
  expires_at := v_exp;
  return next;
end $$;

create or replace function platform.ensure_admin(
  p_email text,
  p_name  text default 'Administrator'
) returns uuid
language plpgsql
security definer
set search_path = platform, public
as $$
-- @no-scope-check: creates the single administrator identity.
--
-- @server-only: creates a user with the admin role and all_locations.
-- Reachable by `authenticated`, anyone signed in could mint themselves
-- an administrator and then log in as it.
declare v_id uuid;
begin
  select id into v_id from platform.app_user where lower(email) = lower(p_email);
  if found then return v_id; end if;

  insert into platform.app_user (email, full_name, role, all_locations, status)
       values (lower(p_email), p_name, 'admin', true, 'ACTIVE')
    returning id into v_id;

  return v_id;
end $$;
