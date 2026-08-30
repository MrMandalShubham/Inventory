-- ============================================================
-- 0021 — An API client can finish what it starts
--
-- The HTTP smoke test found this: a key could hold stock and confirm
-- the hold, then failed at the last step with
--
--   FORBIDDEN_ROLE: api_client may not post ISSUE
--
-- stock.reason.allowed_roles listed the five human roles and knew
-- nothing about `api_client`, which arrived with the API in 0020.
-- The reservation lifecycle dead-ended one call from the end.
--
-- ── What an API client may and may not post ──
--
-- ISSUE and RETURN only: a sale leaving, and a customer sending
-- something back. Both are things a storefront legitimately causes.
--
-- Deliberately NOT granted:
--   ADJUST, COUNT   corrections need a human and an approver
--   WASTAGE         somebody has to have seen the damage
--   OPENING         a go-live decision, not an API call
--   TRANSFER_*      internal movement goes through a ticket
--
-- The narrow grant matters because the reason list is the last coarse
-- gate before the ledger. A key that could post ADJUST could rewrite
-- stock with no approver anywhere in the loop.
-- ============================================================

update stock.reason
   set allowed_roles = allowed_roles || array['api_client']
 where code in ('ISSUE', 'RETURN');

comment on column stock.reason.allowed_roles is
  'Roles permitted to post this reason. api_client holds only ISSUE and RETURN — corrections need a human.';
