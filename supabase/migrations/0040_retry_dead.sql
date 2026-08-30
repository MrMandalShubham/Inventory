-- ============================================================
-- 0040 — Retrying a dead letter, through a function
--
-- platform.webhook_delivery has a SELECT policy and no write policy,
-- which is deliberate: the queue is written by emit_event() and by
-- the worker's own functions, never by a client holding a connection.
--
-- So "retry these" is a function too, rather than an UPDATE policy
-- opened up for one screen. Same rule as stock: there is one door.
--
-- ── Why attempts resets to zero ──
--
-- A dead delivery has already spent its attempts. Requeueing without
-- resetting means it fails once and dies again — so the button reads
-- "retry" and means "try once more", which is not what anybody
-- clicking it expects after they have fixed their endpoint.
-- ============================================================

create or replace function platform.retry_dead_deliveries(
  p_subscription uuid default null
) returns integer
language plpgsql
security definer
set search_path = platform, public
as $$
-- @no-scope-check: requeues internal queue rows. Admin only, checked
-- below; touches no stock and no location data.
declare v integer;
begin
  if platform.current_role_name() <> 'admin' then
    raise exception 'FORBIDDEN_ROLE: only an admin may retry dead deliveries'
      using errcode = '42501';
  end if;

  update platform.webhook_delivery d
     set status          = 'PENDING',
         attempts        = 0,
         next_attempt_at = now(),
         claimed_at      = null,
         claimed_by      = null,
         last_error      = 'requeued by an admin'
   where d.status = 'DEAD'
     and (p_subscription is null or d.subscription_id = p_subscription);

  get diagnostics v = row_count;

  -- Give the subscription a clean slate too, so the health screen
  -- reports what is happening now rather than what happened before
  -- somebody fixed it.
  if v > 0 then
    update platform.webhook_subscription
       set consecutive_failures = 0
     where p_subscription is null or id = p_subscription;
  end if;

  return v;
end $$;

comment on function platform.retry_dead_deliveries is
  'Requeue dead-lettered webhooks after the subscriber has fixed their endpoint. Resets the attempt count, or the retry would die on its first failure.';
