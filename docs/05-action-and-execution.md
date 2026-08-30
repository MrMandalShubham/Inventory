# 05 — Action and execution

*Everything the system can do that changes state, and the contract each one honours.*

---

## 1. The action catalogue

Every state-changing operation in the system. If it is not on this list, it does not change stock.

| Action | Effect on stock | Ledger entry | Approval |
|---|---|---|---|
| `receive_goods` | `on_hand +` at destination | `RECEIPT` | Auto if matched to PO |
| `dispatch_movement` | `on_hand −` at source, `in_transit +` | `TRANSFER_OUT` / `ISSUE` | Ticket must be approved |
| `receive_movement` | `in_transit −`, `on_hand +` at destination | `TRANSFER_IN` | Auto if counts match |
| `reserve_stock` | `reserved +` | none — no physical change | None |
| `confirm_reservation` | `reserved` held, order bound | none | None |
| `consume_reservation` | `on_hand −`, `reserved −` | `ISSUE` | None |
| `release_reservation` | `reserved −` | none | None |
| `record_counter_sale` | `on_hand −` | `ISSUE` | None |
| `post_adjustment` | `on_hand ±` | `ADJUST` | **Always** |
| `record_wastage` | `on_hand −` | `WASTAGE` | Manager, above threshold |
| `apply_count_variance` | `on_hand` set to counted | `COUNT` | **Always** |
| `receive_return` | `on_hand +` in graded condition | `RETURN` | Condition grading required |
| `transfer_ownership` | no quantity change | `RECLASS` | Deferred to Phase 8 |

Two patterns to notice. **Reservations do not write to the ledger** — nothing has physically moved, so there is no event to record; only `consume` does. And **every action that increases or decreases stock without a corresponding physical movement requires approval**, because that is precisely the shape of both an honest correction and a concealed theft.

## 2. The contract every action honours

```
1. Idempotency      Same key → same result, no second effect.
2. Atomicity        Stock change + ledger entry + document, one transaction.
3. Authorisation    Caller's role and location scope checked before anything.
4. Definer re-check Role and location checked AGAIN inside every SECURITY
                    DEFINER function, where RLS does not apply.
5. Attribution      actor_id and actor_app_id recorded, always.
6. Constraint       Database refuses the illegal state; app code does not police it.
```

Rule 1 is not optional anywhere. Networks time out; a timeout is indistinguishable from a failure to the client; clients retry. Without an idempotency key held in a unique index, one flaky connection silently takes a second unit off the shelf.

```sql
create unique index reservation_idempotency
  on inv.reservation (idempotency_key);
```

A unique index, not a check-then-insert — two concurrent retries would both pass a check.

## 3. Where actions execute

| Kind of work | Runs where | Why |
|---|---|---|
| Touches the ledger or a sequence | **Postgres function**, called via `rpc()` | Must be one atomic statement set; a multi-round-trip version has a race window |
| Reads, validation, orchestration | **Next.js route handler** | Ordinary application logic |
| Scheduled, touching stock | **`pg_cron` job** | Transactional with the rows it changes |
| Scheduled, calling outward | **Vercel Cron** | Email digests, third-party calls |

The dividing line is simple: **if getting it wrong could produce a wrong stock number, it is in the database.**

## 4. The reservation lifecycle

The most concurrency-sensitive path in the system, and the one the buy/sell app depends on.

```
                    ┌──────────────────────────────┐
   POST /reservations│  HELD    available −qty      │
                    │          on_hand unchanged    │
                    └───┬──────────────────┬────────┘
             customer pays          expiry sweep
                        │            or abandoned
                        ▼                  │
                 ┌─────────────┐           │
                 │  CONFIRMED  │──cancel──►├──► RELEASED
                 └──────┬──────┘           │    available restored
                   dispatched              │
                        ▼                  │
                 ┌─────────────┐           │
                 │  CONSUMED   │           │
                 │  on_hand −  │           │
                 │  ledger row │           │
                 └─────────────┘
```

**Held at checkout, not at add-to-cart.** Holding at cart means one person browsing makes the item appear sold out to everyone else — a worse failure than the one being prevented.

**The sweeper is mandatory.** A `pg_cron` job runs every minute, releasing holds past `expires_at`. Without it, a wave of abandoned carts freezes the catalogue and the failure looks exactly like a stockout.

## 5. The movement ticket state machine

```
DRAFT → APPROVED → PICKED → DISPATCHED → IN_TRANSIT → RECEIVED
                                │                          │
                       source −qty                   counts compared
                       transit +qty                        │
                                             ┌─────────────┴─────────────┐
                                        counts match              counts differ
                                             │                           │
                                        RECONCILED                  DISCREPANCY
                                    transit −, dest +                   │
                                             │              reason + approver
                                             │                           │
                                             │                       RESOLVED
                                             │                    adjustment posted
                                             └───────────┬───────────────┘
                                                      CLOSED

  CANCELLED — available up to DISPATCHED, never after.
```

Once goods have physically moved, cancellation is not a state — the only way back is a reverse movement, which leaves its own record.

### Five quantities per line

`qty_ordered`, `qty_dispatched`, `qty_received`, `qty_accepted`, `qty_rejected`. They genuinely differ, and collapsing them into one loses what you need to settle a dispute:

> Ordered 100. Hub dispatched 98 — two were already damaged on the shelf. Shop counted 97 arriving; one lost in transit, carrier query raised. Of those, 3 were crushed, so 94 accepted and 3 rejected.

The close condition: **`qty_dispatched = qty_received + lost_in_transit`, and every rejected unit carries a reason.** There is no path to `CLOSED` that skips it.

## 6. Failure handling

| Failure | Response |
|---|---|
| Client retries a write | Idempotency key returns the original result. No second effect |
| Insufficient stock | Clean `409` naming the product and the available quantity — never a partial reservation |
| Function raises mid-transaction | Postgres rolls back. Stock and ledger cannot diverge, by construction |
| Webhook delivery fails | Exponential backoff, 24h, then dead-letter and alert. Never blocks the write |
| Job fails | Recorded, retried next tick, alerted after three consecutive failures |
| An action was genuinely wrong | Compensating entry, never an edit. See [04 — Memory and retrieval](04-memory-and-retrieval.md) |

**No partial success anywhere.** An action either fully happened, with its ledger entry, or it did not happen at all.

## 7. The public API surface

| Group | Endpoints |
|---|---|
| Catalogue | `GET /v1/products`, `GET /v1/products/:id` |
| Stock | `GET /v1/stock`, `GET /v1/stock/:product/:location`, `GET /v1/stock/as-of` |
| Reservations | `POST /v1/reservations`, `POST /v1/reservations/:id/confirm`, `POST /v1/reservations/:id/release` |
| Movements | `POST /v1/movements`, `POST /v1/movements/:id/dispatch`, `POST /v1/movements/:id/receive` |
| History | `GET /v1/ledger` |
| Webhooks | `stock.changed`, `stock.low`, `movement.closed`, `reservation.expired` |

Every write requires an `Idempotency-Key` header. Every response carries `as_of`, so consumers know how stale their copy is. Every client is scoped — the storefront can reserve; it cannot post an adjustment.

---

## 8. Forward: agent actions

> **Not built in v1.**

An agent that can only read is useful and safe. An agent that can act is useful and dangerous. The design that makes the second acceptable:

1. **The agent uses the public API with a scoped key.** No internal path, no service role, no direct database access. Whatever a third-party integrator could not do, the agent cannot do either.
2. **Agent-initiated writes land in an approval queue**, never in the ledger. The queue entry records the proposed action, the agent's stated reasoning and the records it cited. A human approves, and the ordinary API write path executes it under *that human's* identity, with `actor_app_id` marking the agent as originator.
3. **Read-only capabilities ship first**, and stay alone until the eval harness in [07 — Evaluation and monitoring](07-evaluation-and-monitoring.md) has a track record.
4. **Bounded blast radius.** Per-hour caps on proposals, a value ceiling above which approval escalates to a second person, and a kill switch that disables the agent's key without a deploy.
5. **Untrusted input stays data.** Supplier names, product descriptions and note fields are free text typed by people, and they will end up inside prompts. They are never treated as instructions. See [08 — Governance and safety](08-governance-and-safety.md).

The agent is a client of this system, held to the same contract as every other client, with an extra gate in front of it.
