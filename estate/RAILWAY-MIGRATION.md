# Moving the estate to Railway

Five services from three repos, in one Railway project. Supabase stays
where it is.

Why all of it rather than just the workers: today you manage Vercel +
Supabase, which is two things. Railway + Supabase is still two — but
the workers run as long-lived processes, which is what they were
written for, and no cron limits or function timeouts apply.

Vercel Hobby was never going to work for this: cron runs **once a day**
there, and functions are capped at 10–60 seconds while checkout now
does reserve → confirm → publish in one request.

---

## The services

| Service | Repo | Start command | Type |
|---|---|---|---|
| `grocery` | Grocery | `npm start` | web |
| `inventory` | Inventory | `npm start` | web |
| `logistics` | logistics | `npm start` | web |
| `inventory-worker` | Inventory | `npm run webhooks` | worker |
| `logistics-worker` | logistics | `npm run worker` | worker |

The two worker services deploy from the **same repos** as their web
counterparts — same build, different start command. Give them no
domain; they serve no HTTP.

All three `start` scripts now use `next start` with no `--port`, so
each listens on the `$PORT` Railway assigns. Both workers read
configuration from the environment only; neither needs a `.env` file.

---

## Environment variables

`✱` marks a value that CHANGES during the migration. Everything else
carries over from Vercel unchanged.

### `grocery`

```
NEXT_PUBLIC_SUPABASE_URL          same
NEXT_PUBLIC_SUPABASE_ANON_KEY     same
SUPABASE_URL                      same
SUPABASE_SERVICE_ROLE_KEY         same
INVENTORY_API_URL              ✱  new inventory service URL
INVENTORY_API_KEY                 ic_live_26e2…  (the live storefront key)
INVENTORY_WEBHOOK_SECRET          same — must equal the subscription's signing_secret
LOGISTICS_API_URL              ✱  new logistics service URL
LOGISTICS_API_KEY                 same
LOGISTICS_WEBHOOK_SECRET          same
LOGISTICS_INBOUND_SECRET          same
```

### `inventory` (web)

```
DATABASE_URL                      Supabase POOLER, port 6543 — not 5432
STORAGE_DRIVER                    supabase
SUPABASE_URL                      same
SUPABASE_SERVICE_ROLE_KEY         same
SUPABASE_STORAGE_BUCKET           same
PUBLIC_BASE_URL                ✱  new inventory URL — product image URLs are built from it
STOREFRONT_ORIGINS             ✱  new grocery ORIGIN (scheme + host, no path) — CORS allowlist
WORKER_SECRET                     keep, for poking /api/internal/drain by hand
```

`CRON_SECRET` and `vercel.json` become dead once you leave Vercel. The
drain route stays useful as a manual lever and as a backup trigger.

### `inventory-worker`

```
DATABASE_URL                      same as the inventory web service
WEBHOOK_BATCH                     optional, default 20
WEBHOOK_IDLE_MS                   optional, default 2000
```

Nothing else. It never reads stock and holds no keys.

### `logistics` (web)

```
DATABASE_URL                      Supabase POOLER, port 6543
PG_POOL_MAX                       8 is fine for a real process
GROCERY_BASE_URL               ✱  new grocery URL — status pushes go to {this}/api/logistics/status
INVENTORY_API_URL              ✱  new inventory URL
INVENTORY_API_KEY                 same
INBOUND_WEBHOOK_SECRET            same
GROCERY_WEBHOOK_SECRET            same
SESSION_TTL_STAFF_SECONDS         optional
SESSION_TTL_RIDER_SECONDS         optional
SCRYPT_N / SCRYPT_R / SCRYPT_P    optional — N must stay ≥ 16384 or the process refuses to start
LOG_LEVEL                         optional
```

### `logistics-worker`

Same as the logistics web service. It runs all four jobs
(`outbound.drain`, `assignments.expire`, `holds.expire`,
`retention.purge`) and needs `INVENTORY_API_*` to commit sales and
`GROCERY_*` to push status.

---

## The paired secrets

Each of these is **one secret in two places**. A mismatch shows up as a
401 that looks exactly like a bug. Read from the code, not from memory:

| Grocery | ⇄ | Logistics |
|---|---|---|
| `LOGISTICS_WEBHOOK_SECRET` (signs orders out) | = | `INBOUND_WEBHOOK_SECRET` (verifies them) |
| `LOGISTICS_INBOUND_SECRET` (verifies status in) | = | `GROCERY_WEBHOOK_SECRET` (signs it out) |

| Grocery | ⇄ | Inventory |
|---|---|---|
| `INVENTORY_WEBHOOK_SECRET` | = | `platform.webhook_subscription.signing_secret` |

That last one lives in the **database**, not in Inventory's
environment. To read it back:

```sql
select url, signing_secret from platform.webhook_subscription
 where url like '%/api/inventory/events';
```

One secret per direction per peer is deliberate: a leak of any one
cannot be used anywhere else, and any one can be rotated alone.

---

## Cross-references outside the env

Three things point at `*.vercel.app` and will not fix themselves.

**1 · The webhook subscription — in the database.**

```sql
update platform.webhook_subscription
   set url = 'https://<new-grocery-host>/api/inventory/events'
 where url like '%/api/inventory/events';
```

**2 · `STOREFRONT_ORIGINS` on Inventory.** An origin allowlist, not a
wildcard. If the grocery origin is wrong, browser calls fail CORS with
no useful error.

**3 · `PUBLIC_BASE_URL` on Inventory.** Product image URLs are built
from it. Wrong value means every product photo 404s.

---

## Order of operations

Do it one service at a time, leaving Vercel running until each
replacement is proven. Nothing here is irreversible until step 7.

1. **`inventory` web.** Check `/api/health` returns `ok`, and that a
   product page renders images.
2. **`inventory-worker`.** Watch the logs. It should claim 0 —
   everything pending belongs to the two paused `example.com`
   subscriptions and is not claimable.
3. **`logistics` web**, then **`logistics-worker`**. Confirm with
   `npm run worker -- --list` (or the logs) that all four jobs move off
   `OVERDUE (has never succeeded)`. That is the single biggest
   behavioural change in this migration — those jobs have never run.
4. **`grocery` web.** Set `INVENTORY_API_URL` and `LOGISTICS_API_URL`
   to the new Railway hosts first.
5. **Update the three cross-references above**, including the SQL.
6. **Place one test order** end to end and watch it reach `DELIVERED`
   in all three systems. `estate/estate-health.mjs` answers that in one
   command.
7. **Turn off the Vercel projects** once a real order has completed on
   Railway.

---

## What to expect the moment the workers start

These jobs have never run in this estate. Starting them is not a
no-op:

- `outbound.drain` will push any queued delivery status to Grocery and
  commit delivered orders to Inventory
- `assignments.expire` will return rider offers nobody answered
- `holds.expire` will flag stock holds close to lapsing
- The Inventory worker will begin delivering `stock.changed` to
  Grocery, which is what makes the catalogue cache correct

Order `7e0cdc64` stays broken regardless — it was delivered, its stock
was released, and the sale was never booked. That needs a stock
adjustment by hand, not a worker.
