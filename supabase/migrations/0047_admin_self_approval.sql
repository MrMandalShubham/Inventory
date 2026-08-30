-- ============================================================
-- 0047 — An administrator may approve their own request
--
-- ── The control being relaxed, and why ──
--
-- Migration 0017 refused self-approval outright: the person who raised
-- a movement may not approve it, and the person who received goods may
-- not explain their own shortage. That is separation of duties, and it
-- is the single most effective control against inventory fraud —
-- shrinkage is overwhelmingly explained away by the person who caused
-- it.
--
-- It also assumes two people exist.
--
-- This business currently has one. With the rule absolute, no import
-- can be approved, no transfer can leave, and no delivery with a
-- discrepancy can ever be closed. A control that stops the business
-- operating is not observed, it is bypassed — by sharing a login,
-- which destroys the audit trail entirely and is strictly worse than
-- what is being built here.
--
-- ── So: relaxed deliberately, narrowly, and visibly ──
--
--   • ONLY the admin role. A shop manager or planner still cannot
--     approve their own request, so the control returns by itself the
--     moment staff are added.
--   • Governed by a setting, not by deleted code. Turning it back on
--     is one UPDATE, not a migration.
--   • RECORDED. Every self-approved movement is flagged forever, so
--     "which of these had no second pair of eyes" is one query rather
--     than an archaeology exercise. A relaxed control that leaves no
--     trace is just a missing control.
--
-- The flag is the important part. When a second approver is hired,
-- the movements approved without review are still identifiable.
-- ============================================================

create table platform.setting (
  key     text primary key,
  value   text not null,
  note    text,
  updated_at timestamptz not null default now(),

  -- Deliberately NOT a foreign key to platform.app_user.
  --
  -- The demo seed does `truncate ... platform.app_user ... cascade`,
  -- and CASCADE follows foreign keys inward: a reference here would
  -- have made every reseed delete this table's contents. The setting
  -- would vanish, setting_on() would return false, and self-approval
  -- would silently switch itself off — configuration destroyed as a
  -- side effect of rebuilding users.
  --
  -- Configuration must outlive the rows it happens to mention.
  updated_by uuid
);

insert into platform.setting (key, value, note) values
  ('admin_may_self_approve', 'true',
   'A single-operator business cannot separate duties. Set to false the day a second person can approve — the check returns immediately, and every movement approved without review stays flagged.');

alter table platform.setting enable row level security;

create policy setting_read on platform.setting
  for select using (platform.current_role_name() <> '');

-- Admin only: this is the table that decides which controls apply.
create policy setting_write on platform.setting
  for all using (platform.current_role_name() = 'admin')
  with check (platform.current_role_name() = 'admin');

create or replace function platform.setting_on(p_key text)
returns boolean
language sql stable
security definer
set search_path = platform, public, extensions
as $$
  -- @no-scope-check: reads one configuration flag. No location data,
  -- no stock, and the table's own policy governs who may write it.
  select coalesce(
    (select lower(value) in ('true','on','yes','1')
       from platform.setting where key = p_key),
    false)
$$;

-- ─────────────── the flag on the movement ───────────────

alter table movement.movement
  add column self_approved boolean not null default false;

-- ── the flag is not bookkeeping, it is the permission ──
--
-- Separation of duties was enforced by a CHECK CONSTRAINT on the
-- table, not only by the function — which is why relaxing the function
-- alone still failed, loudly, with approver_is_not_raiser. That is the
-- structure doing its job.
--
-- The replacement keeps the rule and adds exactly one escape: an
-- approver may be the raiser ONLY when the row records that fact. It
-- is now physically impossible to self-approve without leaving the
-- trace, because a row that tried would violate a constraint.
--
-- An audit flag the application is trusted to set is a flag that gets
-- forgotten. One the database requires cannot be.
alter table movement.movement
  drop constraint approver_is_not_raiser;

alter table movement.movement
  add constraint approver_is_not_raiser_unless_recorded
    check (approved_by is null
        or approved_by <> raised_by
        or self_approved);

comment on column movement.movement.self_approved is
  'The raiser approved their own request. Permitted only for an admin, and only while admin_may_self_approve is on — see migration 0047. Kept forever so movements that had no second pair of eyes stay identifiable.';

create index movement_self_approved_idx
  on movement.movement (self_approved) where self_approved;

-- ─────────────── approval ───────────────

create or replace function movement.approve_movement(p_id uuid)
returns void
language plpgsql security definer
set search_path = movement, platform, public, extensions
as $$
declare
  m      movement.movement%rowtype;
  v_self boolean := false;
begin
  m := movement.assert_status(p_id, array['DRAFT']);

  if not (platform.can_access_location(coalesce(m.source_location_id, m.dest_location_id))) then
    raise exception 'FORBIDDEN_LOCATION' using errcode = '42501';
  end if;

  if platform.current_role_name() not in ('shop_manager','planner','admin') then
    raise exception 'FORBIDDEN_ROLE: % may not approve a movement', platform.current_role_name()
      using errcode = '42501';
  end if;

  if m.raised_by = platform.current_user_id() then
    -- Only an admin, and only while the setting allows it. Everyone
    -- else is refused exactly as before.
    if platform.current_role_name() <> 'admin'
       or not platform.setting_on('admin_may_self_approve') then
      raise exception 'SELF_APPROVAL: the person who raised a movement may not approve it'
        using errcode = '42501';
    end if;
    v_self := true;
  end if;

  update movement.movement
     set status = 'APPROVED',
         approved_by = platform.current_user_id(),
         approved_at = now(),
         self_approved = v_self
   where id = p_id;
end $$;

-- ─────────────── the variance, which is the riskier one ───────────────
--
-- Closing a discrepancy is where stock that never arrived gets written
-- off. Letting the receiver do it alone is the textbook shrinkage
-- route, and it deserves saying plainly: this is the weaker of the two
-- relaxations. It is here because a single operator who receives a
-- short delivery would otherwise have a ticket that can never close,
-- and an inbox of permanently open tickets teaches people to ignore
-- the inbox.

create or replace function movement.resolve_discrepancy(
  p_id     uuid,
  p_reason text
) returns integer
language plpgsql security definer
set search_path = movement, stock, platform, public, extensions
as $$
declare
  m       movement.movement%rowtype;
  l       record;
  v_short integer;
  v_total integer := 0;
begin
  m := movement.assert_status(p_id, array['DISCREPANCY']);

  if not platform.can_access_location(coalesce(m.dest_location_id, m.source_location_id)) then
    raise exception 'FORBIDDEN_LOCATION' using errcode = '42501';
  end if;

  if platform.current_role_name() not in ('shop_manager','planner','admin') then
    raise exception 'FORBIDDEN_ROLE: % may not resolve a discrepancy',
      platform.current_role_name() using errcode = '42501';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'REASON_REQUIRED: a discrepancy closed without a reason explains nothing'
      using errcode = '23514';
  end if;

  if m.received_by = platform.current_user_id() then
    if platform.current_role_name() <> 'admin'
       or not platform.setting_on('admin_may_self_approve') then
      raise exception 'SELF_APPROVAL: the receiver may not approve their own variance'
        using errcode = '42501';
    end if;
    update movement.movement set self_approved = true where id = p_id;
  end if;

  for l in select * from movement.line where movement_id = p_id loop
    v_short := coalesce(l.qty_dispatched, 0) - coalesce(l.qty_received, 0);
    if v_short > 0 then
      -- The units left the source and never arrived. They are still
      -- sitting in TRANSIT, which is exactly why the transit balance
      -- is not yet empty. Writing them off there is what empties it.
      perform stock.post_movement(
        l.product_id, movement.transit_location(), -v_short, 'WASTAGE',
        l.batch_id, 'lost in transit on ' || m.ticket_no || ': ' || p_reason, p_id);
      update movement.line set loss_reason = p_reason where id = l.id;
      v_total := v_total + v_short;
    end if;
  end loop;

  update movement.movement
     set status = 'CLOSED', resolved_by = platform.current_user_id(),
         resolved_at = now(), closed_at = now()
   where id = p_id;

  return v_total;
end $$;

-- ─────────────── what had no second pair of eyes ───────────────

/** Movements approved by the person who raised them. */
create or replace function movement.self_approved_movements(p_days integer default 90)
returns table (
  id           uuid,
  ticket_no    text,
  type         text,
  status       text,
  approved_by  text,
  approved_at  timestamptz,
  goods_value_paise bigint
)
language sql
stable
security definer
set search_path = movement, platform, public, extensions
as $$
  -- @no-scope-check: a governance report. Restricted to the roles that
  -- are accountable for the control, and location-scoped below.
  select m.id, m.ticket_no, m.type, m.status,
         u.full_name, m.approved_at,
         (select coalesce(sum(coalesce(l.unit_cost,0)
                              * coalesce(l.qty_dispatched, l.qty_ordered, 0)), 0)::bigint
            from movement.line l where l.movement_id = m.id)
    from movement.movement m
    left join platform.app_user u on u.id = m.approved_by
   where m.self_approved
     and m.approved_at > now() - make_interval(days => greatest(p_days, 1))
     and platform.current_role_name() in ('admin','finance','planner')
     and (platform.can_access_location(m.source_location_id)
       or platform.can_access_location(m.dest_location_id))
   order by m.approved_at desc;
$$;

comment on function movement.self_approved_movements is
  'Movements the raiser approved themselves. The point of recording it: when a second approver exists, these are the ones nobody else ever looked at.';
