# 03 — Reasoning and planning

*How the system turns observed data into recommended action.*

---

## 1. What "reasoning" means here

Today, nothing in this system is probabilistic. Reasoning means **explicit, inspectable decision logic**: given what we have observed, what should happen next, and can a human reproduce that conclusion with a calculator.

That standard — *reproducible by hand* — is the design constraint. A planner who cannot reconstruct why the system suggested ordering 240 units will override it, and once they start overriding they stop reading. Every decision surface below therefore shows its inputs and its arithmetic.

The system **proposes; a human disposes.** No decision in this document executes itself.

## 2. The decision surfaces

Six places where the system reasons. Each is a pure function of recorded data.

### 2.1 Reorder point

```
reorder_point = (average_daily_sell_through × lead_time_days) + safety_stock
```

Computed **per product, per location**, because a product that sells 40 a day in one shop may sell 4 in another, and sizing every shop to the average is how you get stockouts and dead stock simultaneously.

| Input | Source | Window |
|---|---|---|
| `average_daily_sell_through` | Outbound ledger rows for that product and location | Rolling 28 days, excluding days the location was closed |
| `lead_time_days` | Observed receipt dates against order dates for that supplier | Rolling 6 receipts, median not mean — see [06](06-feedback-and-adaptation.md) |
| `safety_stock` | `z × σ_demand × √lead_time`, with `z` from the target service level | Recomputed weekly |

**Excluding closed days matters more than it sounds.** Averaging a week's sales over seven days when the shop opened five understates demand by 29% and produces reorder points that guarantee stockouts.

### 2.2 Replenishment quantity

Reaching the reorder point answers *when*. This answers *how much*.

```
suggested_qty = (reorder_point + review_period_demand) − on_hand − in_transit − on_order
```

then rounded up to the supplier's minimum order quantity or case pack, whichever binds.

Subtracting `in_transit` and `on_order` is the whole point. Omit them and the system re-suggests goods that are already coming, which is invariant 4 ([09 — Product](09-product.md)) expressed as a planning rule.

### 2.3 Source selection for a transfer

When a shop needs stock, where should it come from?

1. Prefer the hub if it holds surplus above its own reorder point.
2. Otherwise the nearest location whose days-of-cover exceeds a configured ceiling — a shop with 60 days of cover on a product should give some up.
3. Never source from a location that would drop below its own reorder point as a result.
4. Break ties by shortest lead time, then by oldest expiry, so stock moves toward where it will sell before it expires.

Rule 3 is the guardrail. Without it, the system solves one shop's stockout by creating another's.

### 2.4 Picking order

**FEFO — first expired, first out.** Among batches of the same product at the same location, allocate from the earliest expiry date that has sufficient quantity. Where a product has no expiry, fall back to first-in-first-out on receipt date.

Deterministic and non-negotiable: the picking list tells the operator which batch to take, and the scan verifies they took it.

### 2.5 Allocation priority when stock is short

When demand exceeds available stock, something has to give. In order:

1. **Firm allocations** — stock already promised to a named customer or event. Untouchable.
2. **Confirmed reservations** — a customer has paid.
3. **Held reservations** — a checkout in progress, ordered by hold time, oldest first.
4. **Replenishment transfers** — internal moves yield to customer demand.

Stated as policy rather than emerging from whatever the code happens to do, because during a shortage is exactly when an accidental policy becomes visible and expensive.

### 2.6 Markdown and disposal timing

For products with expiry, the system flags stock whose **days of cover exceeds its days to expiry** — meaning at the current rate it will not sell before it is lost.

```
at_risk_qty = on_hand − (average_daily_sell_through × days_to_expiry)
```

The suggestion is transfer first (to a location that will sell it in time), discount second, write off last. The system does not choose; it presents the three with the numbers behind each.

## 3. The planning cycle

| Cadence | What runs | Who acts |
|---|---|---|
| **Continuous** | Reorder point breach detection on every stock change | Alerting engine raises it |
| **Daily, early morning** | Replenishment run — suggestions for every location, expiry risk scan, dead stock refresh | Planner reviews and approves before the day's picking |
| **Weekly** | Reorder point and safety stock recalculation, lead time refresh, ABC/XYZ reclassification | Planner reviews changes above a threshold |
| **Monthly** | Service level review, supplier performance, wastage by category | Management review |

The daily run is the heartbeat. It produces a worklist, not actions: *these 23 products at these 4 locations are below reorder point; here is the suggested quantity and source for each.* A planner approves, adjusts or rejects each line, and **every rejection is recorded with a reason** — that record is the input to [06 — Feedback and adaptation](06-feedback-and-adaptation.md).

## 4. Explainability requirement

Every suggestion the system makes carries its derivation, available in one click:

```
Suggest: transfer 240 units of PRD-2026-004178 from Hub to Shop 3

  Sell-through (28d, 24 open days)     18.3 /day
  Lead time (median of last 6)          3 days
  Safety stock (98% service, σ=4.1)    38 units
  ─────────────────────────────────────────────
  Reorder point                        93 units
  Current on hand                      41 units
  In transit                            0 units
  On order                              0 units
  Review period demand (14d)          256 units
  ─────────────────────────────────────────────
  Suggested quantity                  308 → 240 (Hub surplus limit)

  Source: Hub — 61 days cover, above 30-day ceiling
```

The last line matters as much as the number. A suggestion that was *capped* by a constraint should say so, because the planner needs to know the shortfall exists.

## 5. What the system deliberately does not reason about

- **Seasonality.** A rolling window handles gradual change and handles a festival badly. Deferred to Phase 8 rather than approximated poorly.
- **Price elasticity.** We do not model how a discount changes demand.
- **Supplier negotiation.** Order quantities respect minimums; they do not chase price breaks.
- **Cannibalisation and substitution.** Products are reasoned about independently.

Each of these makes suggestions worse in a specific, knowable way. Recorded so the limitation is visible when a suggestion looks wrong.

---

## 6. Forward: the agent layer

> **Not built in v1.** Designed here so it is additive later. Nothing in this section may proceed until the Phase 6 gate has held for a full quarter — a language model reasoning over numbers that are wrong produces confident, wrong answers faster than a human could.

### What an agent would add

| Capability | Why a model helps where the rules above do not |
|---|---|
| **Natural-language questions** | "Why did Shop 2 run out of oil last week?" requires joining sell-through, transfer history and a delayed receipt — a query a planner cannot express in a filter |
| **Anomaly explanation** | The rules detect that wastage rose; a model can propose *which* changes correlate with it and rank the candidates |
| **Multi-constraint planning** | Balancing a truck's capacity across 40 products and 5 shops is a search problem, not a formula |
| **Narrative summaries** | Turning the daily run into three paragraphs a manager actually reads |

### Hard boundaries

1. **The agent never writes stock.** It calls the same public API as any other client, with a scoped key, and every stock-changing call it makes lands in an approval queue. There is no privileged path.
2. **The agent's suggestions are labelled as such** in the UI, always, and carry the same derivation requirement as section 4 — including which tool calls produced the numbers it cites.
3. **Untrusted text stays untrusted.** Product descriptions, supplier names and note fields are typed by people, including suppliers and staff. They enter a prompt as data, never as instruction. See [08 — Governance and safety](08-governance-and-safety.md).
4. **Scope applies to retrieval.** An agent answering for one shop must not surface another shop's cost data to a role that cannot see it. The agent's key carries a scope like any other client's. See [04 — Memory and retrieval](04-memory-and-retrieval.md).
5. **No agent action without an eval.** Each capability ships only after it clears an offline evaluation set. See [07 — Evaluation and monitoring](07-evaluation-and-monitoring.md).

### Where it would sit

```
Planner asks a question
   → agent (read-only scoped key)
       → public API: stock, ledger, movements, metrics
       → composes an answer with citations to specific records
   → if it proposes an action, that action enters the approval queue
       → a human approves → the normal API write path executes it
```

The agent is a **consumer of the system, not a component of it.** That placement is what makes it safe to add and safe to remove.
