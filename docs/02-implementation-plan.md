# 02 — Implementation plan

---

## 1. Stack, and the three constraints it imposes

| Layer | Choice | Role |
|---|---|---|
| Database | **Supabase Postgres** | The stock records, the constraints, location and role isolation via RLS |
| Backend | **Next.js Route Handlers** on Node runtime | The public API and server logic |
| Frontend | **Next.js App Router**, React Server Components, Tailwind, shadcn/ui | Dashboard and operator screens |
| Hosting | **Vercel** | Edge network, preview deployments, cron triggers |
| Jobs | **`pg_cron` inside Supabase** | Sweepers, projections, scheduled recalculation |
| Auth | **Supabase Auth** | Staff sign-in; API clients use separate keys |

This stack is a good fit, and it constrains three things that matter more here than in a typical CRUD app.

### Constraint 1 — Critical writes belong in Postgres functions, not application code

Reserving stock, closing a ticket, issuing a gapless number: each must be one atomic operation. Doing it as several round-trips from a serverless function means a window where two requests interleave, and that window is exactly where overselling lives.

**Rule:** if an operation touches the ledger or a sequence, it is a Postgres function (`SECURITY DEFINER`, called via `supabase.rpc()`). If it only reads, or only touches non-stock tables, it may live in a route handler.

```sql
-- The shape every stock-changing operation takes
create or replace function inv.reserve_stock(
  p_product uuid, p_location uuid, p_qty int, p_key text
) returns uuid
language plpgsql security definer as $$
declare v_id uuid;
begin
  -- idempotency first: a retry returns the original result, unchanged
  select id into v_id from inv.reservation where idempotency_key = p_key;
  if found then return v_id; end if;

  update inv.stock_balance
     set reserved = reserved + p_qty
   where product_id = p_product and location_id = p_location
     and on_hand - reserved - allocated >= p_qty;   -- the guard, in one statement
  if not found then raise exception 'INSUFFICIENT_STOCK'; end if;

  insert into inv.reservation (...) returning id into v_id;
  return v_id;
end $$;
```

The `UPDATE … WHERE available >= qty` pattern is the whole guarantee. It is a single statement, so Postgres serialises it, and no amount of concurrency can produce a negative.

### Constraint 2 — Connection pooling is mandatory

Serverless functions open connections per invocation and exhaust a Postgres connection limit quickly. Use the **Supavisor pooler** connection string (transaction mode) for all application traffic, and reserve the direct connection for migrations only.

Transaction-mode pooling does not support session-level features — prepared statement caching, `LISTEN/NOTIFY`, advisory locks held across statements. Design around this rather than discovering it in production.

### Constraint 3 — Vercel has no long-running workers

The expiry sweeper, the balance projection check, webhook retries and nightly recalculation all need to run on a schedule and, in some cases, inside a transaction with the data they touch.

**Use `pg_cron` in Supabase, not Vercel Cron**, for anything that touches stock. A job that runs inside the database is transactional with the rows it updates; a job that runs on Vercel and calls back over HTTP is not. Reserve Vercel Cron for things genuinely outside the database — sending digest emails, calling third-party APIs.

## 2. Repository structure

A single Next.js application with hard internal module boundaries. **Not microservices** — stock correctness is a transactional problem, and splitting the ledger from reservations means a reservation and its ledger entry can no longer be written in one transaction.

```
inventory-core/
├─ app/
│  ├─ (dashboard)/           # manager and planner screens
│  ├─ (operator)/            # scan-first mobile screens
│  └─ api/v1/                # the public API — the product surface
├─ modules/                  # one directory per domain, boundaries enforced in CI
│  ├─ catalog/               # products, variants, units of measure
│  ├─ location/
│  ├─ stock/                 # ledger, balances, adjustments, counts
│  ├─ movement/              # tickets, documents, reconciliation
│  ├─ reservation/
│  ├─ planning/              # reorder points, suggestions  → doc 03
│  ├─ insight/               # metrics, reports              → doc 06
│  ├─ alerting/
│  └─ platform/              # auth, roles, audit, API keys
├─ supabase/
│  ├─ migrations/            # numbered SQL, forward-only
│  └─ functions/             # SQL function definitions, version controlled
└─ packages/
   └─ contracts/             # shared types, the API schema, generated client
```

Each module owns a Postgres schema and exposes a `contracts.ts`. No module reads another module's tables directly — cross-module access goes through the owning module's exported functions. Enforce it with `dependency-cruiser` in CI, because a convention nobody checks is a convention nobody keeps.

## 3. Isolation model

**One deployment per business.** Each company gets its own Supabase project, its own Vercel project and its own instance of this codebase. There is no organisation column anywhere, because there is never more than one organisation in a database.

That removes an entire class of bug. It does not remove the *shape* of the bug — inside one company there are still several shops and several roles, and that boundary is enforced the same way:

```sql
alter table stock.balance enable row level security;

create policy location_scope on stock.balance
  using (
    (auth.jwt() ->> 'role') in ('planner','finance','admin')
    or location_id = any (
      string_to_array(auth.jwt() ->> 'location_ids', ',')::uuid[]
    )
  );
```

Three things this must get right:

- **`SECURITY DEFINER` functions bypass RLS.** Every one must check location and role explicitly in its own body. This is the single most likely place for a privilege leak, and it is **silent** when it happens — no error, no crash, just one shop quietly adjusting stock it does not own.
- **API clients are not users.** They authenticate with a key that resolves to a scope set, and the request runs with a JWT minted from that — never with a service role key that skips RLS entirely.
- **Tables added without RLS.** A CI query over `pg_policies` fails the build if any table in a stock schema lacks a policy. A convention nobody checks is a convention nobody keeps.

### If this ever has to become multi-tenant

Single-tenant → multi-tenant is the expensive direction: adding an organisation column to a live schema with years of data touches every table, query and index. We accept that cost deliberately, rather than carry a column that means nothing in every deployment we actually run. The point to revisit is around ten deployments, where per-instance operations start costing more than the migration would.

## 4. Two kinds of user interface

Most arguments about building the UI early or late are really two different things being given one name.

| | **Working UI** | **Product UI** |
|---|---|---|
| Looks like | Plain tables and forms, no design | Designed, tested, fast |
| For | Us — seeing data, entering test data, showing progress | Shop staff, daily, under time pressure |
| Cost | ~15–20% on top of a phase | A phase of its own |
| Lifetime | Disposable | The product |

**Working UI ships with every phase.** On Next.js against Supabase a table view is a few dozen lines, and without one a phase is verified only by test output — fine for correctness, useless for noticing that a field nobody thought about is missing.

**Product UI is Phase 5**, where it gets the design attention it needs.

**One deliberate exception: the receiving flow is built properly in Phase 3.** [09 — Product](09-product.md) §3 says the operator persona drives more design than any other, because if receiving takes longer than the paper process it replaces the data stops being entered and every other feature becomes fiction. That cannot be tested through an API. Building it at Phase 3 and putting it in front of real staff on a real delivery answers the project's largest risk two phases earlier — while the schema can still absorb the answer.

## 5. Build phases

Each phase ends at a gate. **If the gate does not pass, the next phase does not start** — in a stock system a weak foundation compounds silently rather than surfacing.

### Phase 0 — Foundation
Roles and per-location permissions, RLS baseline, audit log, gapless ID minting, API clients and keys, migration harness, CI with module-boundary checks.

*Working UI: none — there is nothing yet to look at. Verified by the confirmation suite alone.*

> **Gate:** a shop manager cannot read or write another location's stock, and an operator cannot post an adjustment — proven by a test that tries both, **through every `SECURITY DEFINER` function**, not merely through the normal query path. A query over `pg_policies` fails the build if any stock table is missing a policy.

### Phase 1 — Masters
Products with variants, units of measure and conversions, barcodes, tracking mode. Location tree. Partners. Bulk CSV import and opening balances.

*Working UI: product list and form, location list, partner list, and the CSV import screen showing the line-by-line error report.*

> **Gate:** 5,000 products and opening stock for three locations import in one pass, with a line-by-line error report for failed rows. Product search returns in under 200ms at that volume.

### Phase 2 — Stock truth
The append-only ledger, the balance projection, batches and serials, adjustments with reason codes, wastage, cycle counting with blind counts and variance approval, the negative-stock constraint, point-in-time queries.

*Working UI: stock table per location, movement history for one product, count sheet, adjustment form with reason codes.*

> **Gate:** drop the balance table, rebuild it from the ledger alone, reproduce every number exactly — and wire that rebuild into CI. Separately, a physical count that finds a variance posts an adjustment with an approver and a ledger entry, and the count sheet is reproducible afterwards.

### Phase 3 — Movement and ticketing
The movement object and lines, the full state machine, import/export/transfer, pick lists, dispatch and receipt, three-way reconciliation, the discrepancy branch, documents, returns both directions.

*Working UI: ticket board and document views.*

***Product UI, pulled forward:*** *the receiving flow — scan-first, on a phone, built properly. This is the exception described in §4.*

> **Gate, part one:** a transfer of 100 units where 97 arrive and 2 are damaged cannot reach `CLOSED` until all 100 are accounted for. After closing, ledger entries across source, destination and transit sum to zero and the transit bucket is empty.
>
> **Gate, part two:** an operator receives a real delivery on a phone, using the scanner, **faster than the paper process it replaces** — measured, not assumed. If it is slower, the flow is wrong, and Phase 4 does not start.

### Phase 4 — The public API
Versioned REST over everything above. Key-scoped clients, idempotency middleware, the reservation lifecycle and its expiry sweeper, signed webhooks with retry, published OpenAPI spec.

*Working UI: API key management and the request log.*

> **Changed during the build — sandbox is a deployment, not a flag.**
> The plan called for a sandbox mode on the API client. That shape is
> wrong here: a flag means simulated responses, and a simulated
> response is a lie developers eventually ship against. Under
> one-deployment-per-business (§3) a sandbox is simply another
> deployment with its own database and its own base URL. Nothing to
> build, nothing to fake, and no path by which test traffic can reach
> real stock. Keys still carry `environment`, so a test key pasted
> into a live host is obvious in the log.

> **Gate:** 200 concurrent reservation requests against 100 units yield exactly 100 successes, 100 clean rejections and zero oversells. Every write replayed with the same idempotency key changes nothing and returns the original response.

### Phase 5 — The product UI
**Where design gets its own phase.** All-locations overview, per-location tables, product detail with movement history, the ticket board, counting screens built scan-first, label printing — and the working UI from Phases 1–4 **replaced rather than extended**.

*Responsiveness, empty states, error copy and speed all get real attention here. The receiving flow built in Phase 3 is refined, not rebuilt.*

> **Gate:** an operator receives a shipment end to end on a phone using only the scanner, typing nothing except a variance reason. A manager finds why one product is short at one location in under three clicks.

> **Changed during the build — sign-in is ours, not Supabase Auth's.**
> The plan assumed Supabase Auth. It needs a hosted project, and a
> login you cannot run locally is a login you cannot test. Migration
> 0022 mints the *same claims shape* (`sub`, `role`, `location_ids`,
> `all_locations`) from our own `platform.session`, so every policy,
> every `SECURITY DEFINER` body and every test is untouched. Moving to
> Supabase Auth later changes where claims come from, never what they
> look like.

### Phase 6 — Insight and alerts
Velocity and days of cover, reorder points, replenishment suggestions, stockout risk, dead stock, ABC and XYZ, the reports pack, the alerting engine.

*Product UI: the demand and supply dashboard per location, the suggestion worklist, the alert inbox.*

> **Gate:** reorder suggestions for one location reproduce a hand calculation for ten products across three demand patterns — fast mover, slow mover, and one with a spike inside the window.

### Phase 7 — Cost and value
Landed cost at receipt, weighted average valuation, accounting postings for every movement, billing documents with tax, supplier payables.

*Product UI: valuation by location, margin by order, who owes whom, the trial balance.*

> **Gate:** gross margin on one dispatched order, computed from the ledger, ties to a manual calculation to the paisa.

Three decisions worth writing down, because changing any of them later
makes historic figures incomparable:

**Weighted average, not FIFO.** Simpler, robust to the constant small
purchases this business makes, and standard for grocery distribution.
FIFO is more precise for fruit and veg and is not worth the complexity
at this scale.

**Landed cost is fixed at receipt.** Freight and handling are spread
across the lines by value at the moment the goods are counted in, and
cannot be edited afterwards — by then they have already reached the
weighted average and the accounts, and editing them behind those two
would make them disagree. A charge that arrives late is a new
document, not a correction to an old one.

**Value with no cost is left at no value.** A movement worth nothing
posts no journal. Loading opening stock before its cost is known
enters it at zero rather than inventing a figure — the alternative
books a phantom asset and makes the trial balance meaningless. Opening
stock that *does* state a cost lands in equity, not in an expense
account: it is the balance the business started with, neither a
purchase nor a loss.

### Phase 8 — Depth
Bins and pick paths, kitting, forecasting, offline capture, consignment ownership, statutory integrations, rate limits and per-app usage analytics.

Too broad to gate as one thing, so it is split. Nothing here blocks a production launch of the stock system — but 8a blocks a production launch of the **shared API**, which is what the whole standalone design is for.

**8a — the open API becomes safe to share.** Per-client rate limits and quotas, usage analytics, and webhook delivery that actually delivers. Without limits, any one consuming application can starve the others; without a worker, the webhook tables that have existed since Phase 4 advertise an event stream that silently never fires.

> **Gate:** one client hammering at 10× its limit is throttled without touching a second client's latency; and an event raised by a stock movement reaches a subscriber, retries with backoff when the endpoint fails, and is never delivered twice.

**8b — the catalogue becomes presentable.** Product photographs, stored against the product and served to any consuming app alongside the product record. Done: a customer-facing app cannot render a catalogue from names and codes alone, and the whole reason images belong here rather than in each app is that the catalogue is global — a photo uploaded once is the photo every location and every app sees.

> **Gate:** an image uploaded through the dashboard is returned by the public API and renders in a browser with no credentials, and a file that is not an image is refused on its bytes rather than on its declared type.

**8c — the warehouse gets deeper.** Bins and pick paths, kitting and bundles, consignment ownership.

**8d — the edges.** Forecasting beyond a moving average, offline capture on a phone, statutory integrations (blocked on the e-way bill questions in docs/08).

**Phases 1–3 already constitute a working stock system.** That matters: if the build has to stop, it stops somewhere useful.

## 6. Migrations

Forward-only, numbered, reviewed. Never edit a migration that has run anywhere.

Two rules specific to this system:

- **A migration that touches the ledger must be additive.** Adding a column is fine. Rewriting historical rows is not — that breaks invariant 2 and invalidates every point-in-time query.
- **Every migration ships with its rollback plan written down**, even when the plan is "restore from the point-in-time backup", because for the ledger that will sometimes be the only honest answer.

## 7. Environments and delivery

| Environment | Database | Purpose |
|---|---|---|
| Local | Supabase CLI, Docker | Development, migration authoring |
| Per-company | One Supabase and Vercel project each | Production instances — the same migrations run against every one |
| Preview | Branch database per PR | Automatic on every pull request |
| Staging | Dedicated project, anonymised copy | Load tests, the concurrency gate |
| Production | Dedicated project, PITR enabled | Live |

CI on every pull request: type check, lint, module-boundary check, unit tests, migration apply against a fresh database, **the ledger-rebuild test**, and the RLS coverage query. The last two are the ones that must never be marked as allowed failures.

## 8. Testing strategy

Three tests carry disproportionate weight. Everything else is ordinary coverage.

1. **Ledger rebuild.** Rebuild `stock_balance` from `stock_ledger` and assert it matches row for row. This is invariant 1, mechanised. Runs in CI on every commit.
2. **Concurrency.** Fire N concurrent reservations against a known quantity and assert exactly the available number succeed. This is the Phase 4 gate, and it belongs in the suite permanently, not just at the gate.
3. **Scope isolation.** Attempt every read and write path as the wrong location and as the wrong role, and assert refusal — including via every RPC function, which is where `SECURITY DEFINER` will eventually leak.

## 9. What is explicitly deferred

Recorded here so that deferral stays a decision rather than becoming an oversight: the AI agent layer, bins, kitting, forecasting, offline capture, consignment, multi-currency, e-way bill integration.

Each is designed for in the relevant document's forward section, so that building it later is additive.
