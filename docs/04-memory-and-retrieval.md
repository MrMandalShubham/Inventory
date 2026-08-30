# 04 — Memory and retrieval

*What the system remembers, for how long, and how anyone gets it back out.*

---

## 1. Three layers of memory

| Layer | What it is | Mutability | Lifetime |
|---|---|---|---|
| **Event log** — `stock_ledger` | Every quantity change ever made | Append-only. Never updated, never deleted | Forever |
| **Current state** — `stock_balance` | What is on the shelf right now | Rewritten constantly | Disposable — rebuildable from the log |
| **Derived knowledge** — metrics, aggregates | Sell-through, days of cover, ABC class | Recomputed on a schedule | Rolling; regenerable |

The relationship is one-directional and it is the foundation of the whole system: **the log is truth, state is a cache, knowledge is a summary.** State never informs the log. Knowledge never informs state.

When state and log disagree, the log wins and the disagreement is an incident — see [07 — Evaluation and monitoring](07-evaluation-and-monitoring.md).

## 2. The event log

```sql
create table stock.ledger (
  id            bigint generated always as identity primary key,
  product_id    uuid not null,
  location_id   uuid not null,
  batch_id      uuid,
  serial_id     uuid,

  qty_delta     integer not null,        -- signed: +250 in, −3 out
  balance_after integer not null,        -- so reading never requires a re-sum
  reason_code   text    not null,        -- RECEIPT | ISSUE | TRANSFER_OUT | ...
  movement_id   uuid,                    -- the ticket that caused it
  unit_cost     bigint,                  -- paise; valuation rides with quantity
  total_value   bigint,

  actor_id      uuid not null,           -- which human
  actor_app_id  uuid,                    -- via which application
  occurred_at   timestamptz not null,    -- when it happened
  recorded_at   timestamptz not null default now()   -- when we heard about it
);
```

Four details that are easy to omit and expensive to add later:

- **`balance_after`** turns "what is the stock now" from an aggregate over millions of rows into an index lookup, and gives every row a self-check.
- **`occurred_at` separate from `recorded_at`.** A delivery received at 6am and entered at 11am is one event with two timestamps. Collapsing them makes yesterday's late entry look like today's activity and corrupts sell-through.
- **`actor_app_id`** answers "which application did this", which becomes the first question asked the moment a second consuming app exists.
- **No `UPDATE`.** Enforced with a trigger that raises on update or delete, not left to discipline.

### Corrections

A wrong entry is never edited. It is reversed by a compensating entry that references it:

```
id 88421  RECEIPT   +250   reason: RECEIPT
id 91002  REVERSAL  −250   reason: CORRECTION   reverses_id: 88421
id 91003  RECEIPT   +205   reason: RECEIPT      note: recount, 45 short
```

Three rows, complete history, and the original mistake is still visible — which is the point. An auditor asking "was this ever changed" gets a real answer.

## 3. Current state

`stock_balance`, one row per product × location × batch:

| Column | Meaning |
|---|---|
| `on_hand` | Physically present |
| `reserved` | Held by a checkout in progress |
| `allocated` | Committed to a named customer or event |
| `in_transit` | Left the source, not yet received — sellable from nowhere |
| `damaged` | Present but not sellable |
| `available` | `on_hand − reserved − allocated − damaged`, generated column |
| `weighted_avg_cost` | Value per unit |

Constraints live here, not in application code:

```sql
alter table stock.balance
  add constraint on_hand_non_negative check (on_hand >= 0),
  add constraint reserved_within_stock check (reserved + allocated + damaged <= on_hand);
```

These are the mechanised form of invariant 7. No bug in any application, present or future, can breach them.

## 4. Retrieval patterns

Five questions the system must answer fast. Each one dictates an index.

| Question | Access path |
|---|---|
| **"How many, here, now?"** | `stock_balance` on `(location_id, product_id)` — the hot path, called on every product view and every checkout |
| **"How many, everywhere?"** | Same table, aggregated on `(product_id)` |
| **"What was the position on 31 March?"** | Ledger: last row per product/location with `occurred_at <= date`, using `balance_after`. See below |
| **"Where has this unit been?"** | Ledger on `(serial_id, occurred_at)` |
| **"Who bought this batch?"** | Ledger on `(batch_id)` joined to movements — the recall query |

### Point-in-time reconstruction

Free, because the log is append-only — and impossible without it.

```sql
select distinct on (product_id, location_id)
       product_id, location_id, balance_after as on_hand
  from stock.ledger
 where occurred_at <= $2
 order by product_id, location_id, occurred_at desc, id desc;
```

Ordering by `id` after `occurred_at` matters: two events can share a timestamp, and the identity column is the tiebreaker that makes the answer deterministic rather than whichever row the planner happened to return.

### Product search

Trigram index for fuzzy name matching, exact index for codes and barcodes. A scan hits the exact path; a human typing "toor" hits the fuzzy one.

```sql
create index product_name_trgm on catalog.product using gin (name gin_trgm_ops);
create index product_barcode on catalog.product (barcode);
```

## 5. Growth, and what to do about it

The ledger only grows. At 5,000 products across 5 locations with moderate turnover, expect roughly **2–4 million rows per year**. That is comfortable for Postgres; it stops being comfortable somewhere past five years, which is what the plan below is for.

The plan, in order, applied when measured rather than pre-emptively:

1. **Partition the ledger by month** (`PARTITION BY RANGE (occurred_at)`). Recent partitions stay hot; old ones are rarely touched. Do this at Phase 2, because partitioning an existing large table is far more disruptive than starting partitioned.
2. **Index only what is queried.** Resist adding an index per column; each one costs write throughput on the hottest table in the system.
3. **Materialise the expensive aggregates.** Sell-through and days of cover are computed nightly into a metrics table, not calculated per request.
4. **Archive cold partitions to storage** once beyond the statutory retention need, with a documented restore path. Archived is not deleted — invariant 2 has no expiry date.

## 6. Retention

| Data | Retained | Reason |
|---|---|---|
| Stock ledger | Indefinitely (archived after 7 years) | Statutory, and it is the system's evidence base |
| Audit log | Indefinitely | Same |
| Movement tickets and documents | 8 years | Tax and commercial record-keeping |
| Derived metrics | 24 months rolling | Regenerable from the ledger |
| API request logs | 90 days | Debugging, abuse investigation |
| Customer personal data on documents | Per [08 — Governance and safety](08-governance-and-safety.md) | Deletion requests interact with statutory retention — that document owns the rule |

## 7. Scope isolation in retrieval

Each company runs its own deployment, so there is no cross-company read path to defend. The boundary that remains is **location and role**, and RLS enforces it at the database rather than a filter in the query.

The failure mode is unchanged in shape: a `SECURITY DEFINER` function bypasses RLS, and if it forgets to check location and role in its own body, one shop reads or changes stock belonging to another. Every such function is reviewed for that specific check, and the scope isolation test in [02 — Implementation plan](02-implementation-plan.md) exercises each one as the wrong location and the wrong role.

Two reads deliberately ignore location scope: the all-locations overview and the transfer source search, both restricted to planner and finance roles. Those are explicit exceptions with their own policies, not gaps.

---

## 8. Forward: agent memory

> **Not built in v1.** Designed so it is additive.

An agent needs two things this schema does not yet provide.

### Semantic retrieval

Policy documents, supplier terms, product descriptions and past incident notes are prose, and a planner's question ("what did we agree with this supplier about short deliveries?") is a semantic lookup, not a filter.

- `pgvector` in the same Supabase database — not a separate vector service, so **the same RLS policies apply to embeddings as to rows.** This is the whole reason to keep it in Postgres.
- **Embeddings live in the deployment they belong to**, like every other row. One company's prose never reaches another company's database, because there is no shared database to reach. Where a document is location-restricted, the similarity query carries the same scope filter as any other read.
- Only prose gets embedded. **Never embed stock quantities** — numbers must be retrieved exactly, not approximately, and a model reciting a remembered figure instead of querying the current one is a fabrication waiting to happen.

### Conversation memory

Per-user, per-org, with a short retention window. Scoped to the same org boundary as everything else, deleted on request, and never used as a source of fact — a number a user mentioned last week is not evidence about stock today.

### The rule that governs both

**The agent's memory is never authoritative.** For any question about quantity, location or value, the agent queries the live API and cites the record. Retrieval augments its reasoning; it does not replace the ledger. Anything else reintroduces exactly the several-versions-of-the-truth problem this system exists to eliminate.
