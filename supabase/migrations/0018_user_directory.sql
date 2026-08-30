-- ============================================================
-- 0018 — Colleagues have names
--
-- The Phase 3 ticket screen rendered "Raised by —", "Approved by —"
-- for everyone except an admin. The policy on platform.app_user let
-- you read yourself and nobody else, so every attribution on every
-- screen resolved to a dash.
--
-- Attribution is not a nice-to-have here. "Who approved this
-- variance" is the whole point of separation of duties, and a rule
-- nobody can see enforced is a rule nobody trusts.
--
-- So: any signed-in user may read the directory. This is one
-- company's own staff list, not cross-tenant data — the isolation
-- that matters is the deployment boundary (docs/02 §3) and the
-- location boundary on stock. Neither is weakened by knowing that
-- Meena Shah is a shop manager.
--
-- Writing the directory stays admin-only, unchanged.
-- ============================================================

drop policy app_user_read on platform.app_user;

create policy app_user_directory on platform.app_user
  for select using (platform.current_role_name() <> '');

comment on table platform.app_user is
  'Readable by any signed-in user so attribution renders. Writable only by admin.';
