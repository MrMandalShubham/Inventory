# Inventory Core

A system of record for stock — *how many, where, worth what* — served to any application through one shared interface. One deployment per business.

**Specification:** [`docs/`](docs/README.md) — nine documents. Read [09 — Product](docs/09-product.md) first.

**Integrating a selling app?** [`docs/STOREFRONT-API.md`](docs/STOREFRONT-API.md) — the whole integration in one file: keys, endpoints, the order lifecycle, and a working Next.js client.

---

## Status

| Phase | State | Gate |
|---|---|---|
| **0 — Foundation** | ✅ **Passing** | Location and role boundaries hold through every `SECURITY DEFINER` function |
| **1 — Masters** | ✅ **Passing** — working UI | 5,000 products imported in one pass; fuzzy search 49ms, barcode 38ms |
| **2 — Stock truth** | ✅ **Passing** — working UI | Balance table destroyed and rebuilt from the ledger alone, reproducing every number |
| **3 — Movement** | ✅ **Part one passing** — receiving flow built | 100 ordered, 98 sent, 97 arrive, 3 crushed, 1 lost: cannot close until every unit is explained. **Part two needs a real delivery and a stopwatch** |
| **4 — Public API** | ✅ **Passing** — working UI | 200 concurrent holds against 100 units: exactly 100 succeed, 100 clean 409s, zero oversold. Proven at the database *and* over HTTP |
| **5 — The product UI** | ✅ **Passing** | An operator receives a shipment by scanning only, typing nothing; a manager reaches *why* in **one** click |
| **6 — Insight and alerts** | ✅ **Passing** | Ten products across three demand patterns reproduce the hand calculation exactly |
| 7–8 | not started | see [docs/02](docs/02-implementation-plan.md) |

## Running it

Requires Docker Desktop running, and Node 20+.

```bash
npm install
npm run db:reset   # fresh container, migrations, demo data
npm run dev        # the app at http://localhost:3000
npm test           # the confirmation suite
```

**Sign in** at `/login`. The demo password for every seeded user is `inventory`:

| Email | Role | Sees |
|---|---|---|
| `arun@example.com` | operator | Shop 1 only |
| `meena@example.com` | shop manager | Shop 1 only |
| `priya@example.com` | planner | Shops 1 and 3 — no all-locations grant |
| `deepa@example.com` | planner | every location |
| `admin@example.com` | admin | everything |

Sign in as Arun, then as the admin, and watch the figures change. They change because the
database refuses what a role may not see, not because a page filtered it.

`npm run check` does a reset and the suite in one command — that is what CI runs.

| Script | Does |
|---|---|
| `npm run db:up` | Start the local Postgres container on `:55432` |
| `npm run db:migrate` | Apply pending migrations, forward only |
| `npm run db:reset` | Destroy and rebuild the database, then seed demo data |
| `npm run db:seed` | Reload demo data (the test suite wipes it) |
| `npm run dev` | The app on :3000 |
| `npm run db:down` | Remove the container and its data |
| `npm test` | Run the confirmation suite |
| `npm run api:smoke` | Exercise the HTTP API against a running dev server |

## The API

The contract is published at **`/api/v1/openapi`** and needs no key — a developer has to
be able to read the spec before they have one.

```bash
curl -s localhost:3000/api/v1/stock \
  -H "Authorization: Bearer ic_live_…"
```

Mint a key at **`/api-keys`** (admin only). It is shown once; only a SHA-256 hash is
stored, so a database read cannot yield a usable key — and neither can we recover one
for you.

**Every write requires an `Idempotency-Key` header.** A network timeout is
indistinguishable from a failure to the client, so clients retry. Reuse the same key and
you get the original response back verbatim, with `Idempotent-Replay: true`. Reuse it for
a *different* request and you get a 422 rather than somebody else's answer.

Sandbox is a **separate deployment** with its own database and base URL, not a flag on a
key. A flag would mean simulated responses, and a simulated response is a lie developers
eventually ship against.

## Layout

```
docs/                     The nine specification documents
supabase/
  migrations/             Numbered SQL, forward-only, never edited once run
  checks/                 CI guards — any row returned fails the build
  local/                  auth.jwt() shim + grants; local container only
scripts/                  Database lifecycle, migrations, API smoke test,
                          the webhook delivery worker
app/
  login/                  Sign-in — the only page outside the auth gate
  api/v1/                 The public API — the product surface
  (app)/                  Everything behind the gate
    ui.tsx                Shared surfaces: tiles, pills, tables, empty states
    nav.tsx               Sidebar and the mobile drawer
    stock/                Balances, and the ledger page that answers "why?"
    movements/            Ticket board, raise, approve, dispatch, resolve
    receive/              Scan-first receiving, with camera + handheld scanner
    counts/               Blind cycle counting with variance approval
    products/[sku]/       One product: photographs, where it is, the catalogue record
    products/labels/      Printable shelf labels with Code 128 barcodes
    planning/             The replenishment run, and "show working" per line
    alerts/               The alert inbox — grouped by how soon it matters
    reports/              Dead stock, expiry ageing, ABC×XYZ, wastage
    finance/              Valuation, margin by order, payables, trial balance
    api-keys/             Keys and scopes
    api-keys/usage/       Who is calling, who is throttled, are events getting out
lib/
  api/handler.ts          Auth, rate limits, scopes, idempotency, error mapping, log
  webhooks.ts             Signing and HTTP delivery — the queue itself is in SQL
  storage.ts              Image bytes: local disk in dev, Supabase Storage in prod
  db.ts                   The session helper every query goes through
tests/
  phase0.test.mjs         The Phase 0 gate
  phase1.test.mjs         The Phase 1 gate
  phase2.test.mjs         The Phase 2 gate — the rebuild
  phase3.test.mjs         The Phase 3 gate — 100/98/97/3/1
  phase4.test.mjs         The Phase 4 gate — 200 concurrent holds
  phase5.test.mjs         The Phase 5 gate — sign-in, sessions, scoping
  phase6.test.mjs         The Phase 6 gate — reorder points, by hand
  phase7.test.mjs         The Phase 7 gate — margin from the books, to the paisa
  phase8.test.mjs         The Phase 8a gate — rate limits and webhook delivery
  phase8b.test.mjs        Product images — what is in the file, not what was claimed
  guards.test.mjs         Negative controls: do the CI guards actually fire?
```

## Four rules for anyone adding code

**1. If it touches the ledger or a sequence, it is a Postgres function.**
Not several round-trips from a route handler — that leaves a race window, and that window
is where overselling lives.

**2. Stock changes only through `stock.post_movement()`.**
`stock.balance` has no write policy, so row-level security refuses every INSERT, UPDATE
and DELETE from a client. The posting function runs as definer and is the single door —
not by convention, but because there is no other way in.

**3. Every `SECURITY DEFINER` function checks location and role in its own body.**
Row-level security does *not* apply inside them; the guard steps aside. A function that
forgets lets one shop change another's stock, silently.
`supabase/checks/definer-scope.sql` fails the build on any that neither call
`platform.can_access_location()` nor carry an explicit `-- @no-scope-check: <reason>`.

**4. API handlers use `ctx.db`, never a fresh pool connection.**
`ctx.db` is the session connection with claims set and the role switched. A new connection
is anonymous, so RLS would return nothing and the bug would look like missing data rather
than missing auth.

**5. Nothing changes stock without also changing the books.**
A trigger on `stock.ledger` posts the accounting entry, so it cannot be forgotten by a
future code path that nobody has written yet. Debits equal credits per journal, enforced
by a deferred constraint trigger — an unbalanced journal does not commit. If the stock
valuation and the `INVENTORY` account ever disagree, that is an incident: "what is our
inventory worth" would have two answers and no way to tell which is right.

**6. Outbound stock leaves at the weighted average, never at its selling price.**
`movement.line.unit_cost` on an export is what the *customer* pays. Passing it into the
stock movement books the sale price as the cost of sale, and every gross margin in the
business quietly becomes wrong. Outbound posts pass `null` and take the average.

**7. Adding an argument to a function is not replacing it.**
`create or replace function f(a, b)` where `f(a)` already exists creates a *second*
function. Every existing call then fails as ambiguous — or worse, resolves to the old
one. Drop the old signature explicitly in the same migration.
`supabase/checks/function-overloads.sql` fails the build on any accidental overload; it
was added after this happened twice in one afternoon.

**8. Never trust a caller's content type.**
`putImage()` reads the magic bytes and refuses anything that is not a real JPEG, PNG,
WebP or AVIF — and refuses a mismatch rather than silently correcting it. Whatever is
storable here is served back by an unauthenticated route, so a file stored on a caller's
say-so is a file served on a caller's say-so.

**9. Check-then-act is a race, everywhere — not just in stock.**
The rate limiter read the token bucket, decided, then wrote it. Fifty concurrent
requests all read the same balance and a bucket of five let twenty-four through. The
fix is the one already used against overselling: one guarded `UPDATE`, with the
condition in the `WHERE` clause. Sequential tests cannot find this — a concurrent case
has to exist.

## Where it runs

**The database is Supabase.** The project is shared with the customer-facing app,
which owns the tables in `public`. The inventory lives entirely in its own eight
schemas — `platform`, `catalog`, `stock`, `movement`, `partner`, `insight`,
`alerting`, `ledger` — and never touches theirs. Verified, not assumed: there are
zero foreign keys crossing in either direction, which is what makes
`TRUNCATE ... CASCADE` in the seed unable to reach anybody else's data.
`scripts/db-config.mjs` re-checks that on every seed, because the customer app is
still growing tables.

```bash
npm run db:migrate    # apply migrations, forward only
npm run db:jobs       # schedule the pg_cron jobs
npm run db:verify     # does it actually WORK, not just migrate
```

**`db:verify` is the one that matters.** A deployment can apply all 43 migrations
without an error and still be unable to sign anybody in, because Supabase keeps
pgcrypto in an `extensions` schema that a definer function's pinned `search_path`
cannot see. That failure has no symptom until a person tries to log in. It checks
the four things that break silently, that our grants never reached Supabase's own
schemas, and that all four integrity functions reconcile.

Two things needed changing to run there, both in `scripts/migrate.mjs`:
`extensions` on the session search_path, and `check_function_bodies = off` for
remote targets — a `language sql` body is parsed at creation time against the
function's own search_path, so the functions could not be created at all. Migration
0043 then appends `extensions` to every pinned path.

Deployed databases are migrated forward, never reset.

## The local container, and what it is still for

One thing still needs a disposable database: **the test suite**. `tests/harness.mjs`
TRUNCATEs every table between runs, so it refuses any host that is not loopback and
never reads `.env.local`.

```bash
npm run db:reset && npm test
```

`db:reset` forces `DATABASE_URL` to the container and `STORAGE_DRIVER=local`, so it
cannot wander onto Supabase even when `.env.local` says otherwise. To drop Docker
entirely, point the tests at a second empty Supabase project by exporting
`DATABASE_URL` in that shell — nothing else changes.

Seeding a deployed database is possible but deliberate: the host has to be named.

```bash
npm run db:seed -- --target=db.<project>.supabase.co
```

## Local database

Plain `postgres:16-alpine` on port `55432`, not the Supabase CLI. The only Supabase-specific
pieces the tests need are `auth.jwt()` and the `authenticated` role, and
[`supabase/local/00-auth-shim.sql`](supabase/local/00-auth-shim.sql) provides both using
Supabase's own definitions — so the policies under test are the ones that will run in
production.

Tests run as `authenticated`, never as `postgres`. A superuser bypasses every policy, so a
suite written against `postgres` would pass while the system leaked.

## Scheduled jobs

One job is **mandatory in production**, not an optimisation:

```sql
select cron.schedule('sweep-reservations', '* * * * *',
                     $$ select stock.sweep_expired_reservations() $$);
select cron.schedule('sweep-sessions', '0 3 * * *',
                     $$ select platform.sweep_expired_sessions() $$);

-- Phase 6: demand, reorder points and alerts.
select cron.schedule('refresh-metrics', '30 2 * * *',
                     $$ select insight.refresh_metrics() $$);
select cron.schedule('evaluate-alerts', '*/10 * * * *',
                     $$ select alerting.evaluate() $$);
```

Without it, abandoned checkouts hold stock forever and the failure looks exactly like a
stockout. Use `pg_cron` inside Supabase rather than Vercel Cron, so the release and the
counter move in one transaction.

Also worth scheduling: `stock.verify_balances()`, `movement.verify_transit()` and
`ledger.verify_balanced()` hourly. All three should return zero rows. Anything else is an
incident, not a metric. And `platform.sweep_api_requests()` nightly, or the request log
grows by one row per API call forever.

## Moving the database to Supabase

Local Docker stays the development and test database. Supabase is the deployed one. The
same migrations build both — `scripts/migrate.mjs` detects which it is talking to.

```bash
DATABASE_URL="postgresql://postgres:<password>@db.<project>.supabase.co:5432/postgres"   npm run db:migrate
```

Use the **direct** connection on port 5432, not the transaction pooler on 6543. Migrations
create types, partitions and event-level objects that a transaction-mode pooler cannot
carry. The app itself may use the pooler.

Before the first run, enable `pg_cron` in the Supabase dashboard (Database → Extensions).
`pgcrypto` and `pg_trgm` are created by the migrations themselves.

Then schedule the jobs listed under **Scheduled jobs** below, plus
`stock.ensure_next_partition()` monthly — the ledger is partitioned to the end of 2027 and
has a DEFAULT partition, so forgetting is untidy rather than fatal.

### Four things that differ, each of which fails silently

**The local auth shim must never reach a real project.** `supabase/local/00-auth-shim.sql`
defines `auth.jwt()` and `auth.uid()`. Supabase already has both, owned by
`supabase_auth_admin` and wired into its Auth service; replacing them would change what
every policy in the project sees. `migrate.mjs` now skips the whole `local/` directory
unless the target is loopback. The file said "never applied to a real project" in its own
header — that was a comment, not a check.

**Grants must not reach Supabase's own schemas.** The grants loop discovers schemas rather
than listing them, which is right — a hardcoded list broke twice. But its only exclusions
were `pg_*`, `information_schema`, `public` and `extensions`, so against Supabase it would
have granted `authenticated` — the role every signed-in user holds — INSERT, UPDATE and
DELETE on `auth.users`, `storage.objects` and `vault.secrets`. It now also skips anything
owned by a `supabase*` role, so schemas Supabase adds later are excluded automatically and
ours are included automatically.

**Extensions live in a different schema.** Every `SECURITY DEFINER` function pins its
`search_path`, and those paths named only our schemas and `public`. On Supabase, pgcrypto
and pg_trgm are in `extensions` — so inside those functions there is no `crypt()`,
`digest()`, `gen_random_bytes()` or `word_similarity()`. Nothing fails at migration time;
it fails afterwards as *nobody can sign in, no API key authenticates, and product search
returns nothing*. Migration 0043 appends `extensions` to every pinned path, and
`supabase/checks/search-path.sql` fails the build on the next function that forgets.

**TLS is required.** node-postgres does not enable it from the connection string alone.
`connectionOptions()` adds it for any non-loopback host.

### The suite will not run against it

`tests/harness.mjs` and `scripts/seed.mjs` both `TRUNCATE` every table in the system.
Pointing `DATABASE_URL` at Supabase and running `npm test` would empty the production
database in about four seconds, and the first sign would be that the catalogue was gone.
Both now refuse any host that is not loopback, and there is deliberately no override flag.

## Product images

The database stores metadata and a key; the bytes live in an object store. Keys are the
SHA-256 of the content, so the same photo uploaded twice is stored once and every URL is
immutable and cacheable forever.

```bash
STORAGE_DRIVER=local      # dev: writes to ./.storage
STORAGE_DRIVER=supabase   # prod: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
```

The local driver **refuses to start on Vercel**, and `supabase` without credentials
refuses rather than falling back to disk. A serverless filesystem accepts a write and
loses it, which looks like a working feature for exactly as long as one request.

Setting up production:

```bash
npm run storage:setup   # creates the bucket, idempotent
npm run storage:check   # round-trips a real image through the configured driver
```

Three things about Supabase Storage that only surfaced by running against a real project,
all of them silent failures:

- **"Already exists" comes back as HTTP 400**, with the real `409` buried in the JSON
  body as `KeyAlreadyExists`. Checking the status code alone treats every deduplicated
  upload as an error — and since keys are content-addressed, that is every repeat upload.
- **The list endpoint is not recursive.** Keys here are three levels deep, so a single
  call returns a directory name and no files, and the garbage collector concluded the
  bucket was empty and everything in it collectable.
- **Deleted objects keep serving from the CDN.** A successful `DELETE` followed by a
  plain `GET` returned 200 with `cf-cache-status: HIT` and the bytes of the object just
  removed. Server-side reads now bypass the cache; customer traffic uses the public URL,
  where immutable keys make caching correct.

`storage:check` exists because the Supabase driver **cannot be covered by the test
suite** — the suite runs against a plain Postgres container with no Supabase project
behind it, so any assertion about Supabase Storage would be mocked, and a mocked object
store proves the mock works. Until `storage:check` passes against a real project, treat
the Supabase path as written but not proven.

On a public bucket the API returns Supabase's own CDN URL rather than a link back here.
Proxying every photograph through the application pays for the bandwidth twice, holds a
serverless function open for the length of each image, and leaves the CDN in front of the
bucket unused.

`/images/<key>` is deliberately **unauthenticated**. A customer app renders `<img src>`,
and a browser will not attach a bearer token to that — so an authenticated endpoint means
fetching every photo as a blob, which defeats the browser cache, the CDN and lazy loading
on the device least able to afford it. Product photographs are not confidential, and a
SHA-256 key cannot be guessed or enumerated. The route serves only keys under
`products/`, only when the stored bytes really are an image, and only with the type it
verified itself.

A photograph can be added while creating the product. There is nothing to attach it to
yet, so the bytes are uploaded first and the form carries only the key — content
addressing means an object is identified by what it *is*, not by what it belongs to. The
create action then re-reads type, size and dimensions off the stored bytes rather than
trusting the hidden fields, because a hidden field is a value the browser sent and
nothing more.

Resizing happens **in the browser** before upload. There is no image library in this
stack, and more importantly the photo comes off a phone over the shop's connection —
the constrained side. A 4MB picture leaves as about 300KB.

Removing an image never deletes its bytes: the same content-addressed object may be on
another product. Collect what nothing references:

```bash
npm run storage:gc            # report
npm run storage:gc -- --delete
```

## Deploying

Vercel needs these environment variables. They live only in `.env.local`, which is
gitignored and never deployed, so nothing arrives by itself:

```
DATABASE_URL                 the POOLER string — see below
ADMIN_EMAIL / ADMIN_PASSWORD
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
STORAGE_DRIVER=supabase
```

**Use the Supavisor pooler, not the direct connection.**
`db.<ref>.supabase.co` has an AAAA record and no A record — it is IPv6-only. A serverless
function is IPv4-only, so the hostname does not resolve and every request that touches the
database fails with `ENOTFOUND`. The symptom is a login that rejects a correct password.

```
postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

Transaction-mode pooling is safe: `withSession()` sets its claims with
`set_config(..., true)` and `SET LOCAL` inside an explicit transaction, so nothing depends
on session state surviving between statements.

Check a deployment in one request:

```bash
curl https://<your-app>/api/health
```

It reports whether each variable is set, which storage driver is active, and whether the
database actually answers — booleans and error codes only, never hostnames or keys.

## The webhook worker

Events are queued the instant they happen, by triggers — but nothing leaves the building
until something delivers them:

```bash
node scripts/webhook-worker.mjs
```

Run it as a small always-on process, not on Vercel: a serverless function is billed by
wall-clock time and killed mid-flight, which is the crash the `SENDING` state exists to
survive. Several workers are safe — claiming uses `FOR UPDATE SKIP LOCKED`.

On Supabase the alternative is `pg_cron` plus `pg_net`, calling `net.http_post()` from
the database, which keeps the job transactional with its data. `pg_net` is not in a plain
`postgres:16-alpine`, so the worker exists to be runnable and testable locally.

A growing "waiting" count with no deliveries on `/api-keys/usage` almost always means
nothing is running.

## How a reorder point is worked out

Stated once, because the whole point is that a planner can check it with a calculator:

```
avg_daily     = demand in the window ÷ OPEN days in the window
stddev_daily  = sample stddev of daily demand across open days, zeros included
safety_stock  = ceil( z × stddev_daily × √lead_time )
reorder_point = ceil( avg_daily × lead_time ) + safety_stock

suggested_qty = reorder_point + ceil( avg_daily × review_period )
                − on_hand − in_transit − on_order
```

**The divisor is open days, not calendar days.** Averaging a week's sales over seven days
when the shop opened five understates demand by 29% — and a reorder point 29% too low is a
guaranteed stockout, arriving quietly, in the products that sell best.

**Lead time is measured, not typed** — the median of the last six real receipts into that
location. Median, so one supplier disaster does not permanently inflate a three-day lead
time, but three of them do.

`/planning/<sku>?loc=<code>` shows the whole derivation, step by step.
