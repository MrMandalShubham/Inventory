-- ============================================================
-- Subscribe Grocery to Inventory's stock events
--
-- NOT a migration. It carries two facts that live outside the code —
-- which deployment is listening, and which API client it is — so it
-- is run by hand, once per environment, rather than applied
-- everywhere by `db:migrate`.
--
-- ── Fill in these two before running ──
--
--   :grocery_url    where Grocery is reachable, plus the path:
--                     http://localhost:3000/api/inventory/events
--                     https://<your-grocery-host>/api/inventory/events
--
--   :client_name    which API client Grocery authenticates as. There
--                   are several called some variation of "Storefront";
--                   the right one is whichever minted the ic_live_ key
--                   in Grocery's INVENTORY_API_KEY. Check with:
--
--                     select id, name, scopes from platform.api_client
--                      where status = 'ACTIVE';
--
-- ── What happens after ──
--
-- The insert generates a `signing_secret`. Copy it into Grocery's
-- environment as INVENTORY_WEBHOOK_SECRET — the final select prints
-- it. Then run Inventory's delivery worker:
--
--   npm run webhooks
--
-- Nothing is delivered until that worker runs. The queue is in SQL
-- and survives without it; it simply does not drain.
--
-- ── Why only stock.changed ──
--
-- It is the event that replaces a poll. Grocery refetched the
-- catalogue every five seconds purely to notice stock moving; price
-- and product edits are rare and a five-minute backstop revalidate
-- covers them. `stock.low` is an operations alert, not a storefront
-- concern — Grocery's receiver records it and does nothing, which is
-- why it is not subscribed here.
-- ============================================================

insert into platform.webhook_subscription (api_client_id, event, url)
select c.id, 'stock.changed', :'grocery_url'
  from platform.api_client c
 where c.name = :'client_name'
   and c.status = 'ACTIVE'
on conflict (api_client_id, event, url) do nothing;

-- The secret to copy into Grocery's INVENTORY_WEBHOOK_SECRET.
select s.url,
       s.event,
       s.status,
       s.signing_secret as copy_into_grocery_INVENTORY_WEBHOOK_SECRET
  from platform.webhook_subscription s
  join platform.api_client c on c.id = s.api_client_id
 where s.url = :'grocery_url';
