-- ============================================================
-- 0009 — Global scope becomes an explicit grant, not a role name
--
-- ── Why this migration exists ──
--
-- A Phase 1 test asked a simple question: can a planner who holds
-- only Shop 1 open stock at Shop 2? The answer was yes, because
-- has_global_scope() hardcoded the role names planner, finance and
-- admin. Every user who could pass the role check also had global
-- scope — which meant the can_access_location() call inside
-- import_opening_balances() could never fire for anybody.
--
-- A guard that cannot fire is not a guard. It is dead code that
-- reads like protection, which is worse than no code at all.
--
-- ── The fix ──
--
-- Scope comes from an explicit grant on the user, not from the name
-- of their role. A head-office planner is granted all_locations. A
-- regional planner is granted three locations and is refused the
-- fourth — by exactly the same check, now live for everyone.
--
-- Admin keeps implicit global scope: it manages users and locations,
-- so a bootstrapping problem otherwise appears the first time
-- somebody needs to grant the first grant.
-- ============================================================

alter table platform.app_user
  add column all_locations boolean not null default false;

comment on column platform.app_user.all_locations is
  'Explicit grant to act at every location. Never inferred from role — see migration 0009.';

-- Not "empty location list means everything". An empty list is far
-- too easy to produce by accident — a dropped join, a failed lookup,
-- a claim that did not serialise — and the failure mode of guessing
-- "all" from "none" is silently handing someone the whole business.
create or replace function platform.has_global_scope()
returns boolean language sql stable as $$
  select coalesce((auth.jwt() ->> 'all_locations')::boolean, false)
      or platform.current_role_name() = 'admin'
$$;

comment on function platform.has_global_scope() is
  'True only for an explicit all_locations grant, or for admin. A missing claim means NO global scope.';
