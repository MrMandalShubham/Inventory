-- ============================================================
-- 0023 — The lockout was decorative
--
-- A Phase 5 test asked the obvious question: does eight wrong
-- passwords actually lock the account? It does not.
--
-- ── Why ──
--
-- sign_in() incremented failed_attempts and then raised:
--
--     update platform.credential set failed_attempts = ... ;
--     raise exception 'INVALID_CREDENTIALS: ...';
--
-- A function body is one transaction. RAISE rolls it back — including
-- the increment that was the entire point. failed_attempts never
-- moved off zero, locked_until was never set, and the brute-force
-- protection was a comment with SQL around it.
--
-- ── The fix ──
--
-- Failure RETURNS NO ROWS instead of raising, so the increment
-- commits. Zero rows already means "no session" to every caller, and
-- an empty result is not an error condition the way an exception is.
--
-- ACCOUNT_LOCKED still raises: that path persists nothing, so there
-- is nothing to lose, and the caller genuinely wants to say something
-- different to the person at the keyboard.
-- ============================================================

create or replace function platform.sign_in(
  p_email      text,
  p_password   text,
  p_user_agent text default null
) returns table (token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = platform, public, extensions
as $$
-- @no-scope-check: authentication runs before any scope exists.
declare
  u     platform.app_user%rowtype;
  c     platform.credential%rowtype;
  v_tok text;
  v_exp timestamptz;
  v_ok  boolean := false;
begin
  select * into u from platform.app_user
   where lower(email) = lower(btrim(p_email)) and status = 'ACTIVE';

  if u.id is not null then
    select * into c from platform.credential where user_id = u.id;
  end if;

  -- Locked is the one case worth distinguishing: the person at the
  -- keyboard needs to know waiting will help. It persists nothing, so
  -- raising here costs nothing.
  if c.locked_until is not null and c.locked_until > now() then
    raise exception 'ACCOUNT_LOCKED: too many attempts, try again in a few minutes'
      using errcode = '42501';
  end if;

  -- Compare even when the user does not exist, so a wrong email and a
  -- wrong password take roughly the same time.
  if c.password_hash is not null then
    v_ok := crypt(p_password, c.password_hash) = c.password_hash;
  else
    perform crypt(p_password, gen_salt('bf', 10));
  end if;

  if not v_ok then
    if u.id is not null then
      update platform.credential
         set failed_attempts = failed_attempts + 1,
             locked_until = case when failed_attempts + 1 >= 8
                                 then now() + interval '15 minutes' end,
             updated_at = now()
       where user_id = u.id;
    end if;
    -- No rows. NOT an exception — an exception would roll the
    -- increment above straight back, which is the bug this migration
    -- exists to fix.
    return;
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

comment on function platform.sign_in is
  'Returns zero rows for bad credentials so the failed-attempt counter survives; raises only for a locked account.';
