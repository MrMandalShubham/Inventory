# 07 — Evaluation and monitoring

*Two different questions: is the software healthy, and is the inventory healthy.*

---

## 1. Three layers of watching

| Layer | Question | Failure means |
|---|---|---|
| **System health** | Is the software running correctly? | Users cannot work |
| **Data health** | Are the numbers internally consistent? | Users work on wrong numbers — worse |
| **Business health** | Is the inventory being managed well? | The system works and the business still loses money |

Most monitoring covers only the first. The second is where a stock system actually fails, because it fails **silently** — nothing errors, nothing pages, and the number on the screen is simply wrong.

## 2. System health

| Signal | Budget | Alert |
|---|---|---|
| `GET /v1/stock` p95 latency | < 150 ms | > 400 ms for 5 min |
| `POST /v1/reservations` p95 | < 250 ms | > 600 ms for 5 min |
| API error rate (5xx) | < 0.1% | > 1% for 5 min |
| Database connection saturation | < 70% | > 85% |
| `pg_cron` job lag | < 2 min | Any job missed twice consecutively |
| Webhook delivery success | > 99% | < 95% over an hour |
| Vercel function duration | < 5 s | Timeouts detected |

The reservation endpoint gets the tightest budget because a slow reservation is a lost sale, and because it is the endpoint a third-party app hammers hardest.

**Stack:** Vercel analytics and logs for the application tier, Supabase logs and `pg_stat_statements` for the database, plus a lightweight status table the system writes to itself so job health is queryable in the same place as everything else.

## 3. Data health — the checks that matter most

These run continuously and any failure is an **incident**, not a metric.

### 3.1 Ledger-to-balance reconciliation

The core invariant, mechanised.

```sql
-- Must return zero rows. Always. Every time.
select b.product_id, b.location_id, b.on_hand, l.summed
  from stock.balance b
  join (
    select product_id, location_id, sum(qty_delta) as summed
      from stock.ledger group by 1, 2
  ) l using (product_id, location_id)
 where b.on_hand <> l.summed;
```

Runs hourly in production via `pg_cron`, and on every commit in CI against the test dataset. **A non-empty result is a page, day or night.** It means the balance cache and the event log disagree, and until it is resolved every number the system reports is suspect.

### 3.2 The other continuous checks

| Check | Expected | Meaning if it fires |
|---|---|---|
| Rows where `reserved + allocated + damaged > on_hand` | zero | A constraint was bypassed |
| `in_transit` totals vs open movement tickets | equal | Goods lost between the two records |
| Tickets in `DISPATCHED` or `IN_TRANSIT` beyond expected lead time | zero | Goods lost, or a receipt never entered |
| Reservations past `expires_at` still `HELD` | zero | The sweeper is not running |
| Negative stock attempts (constraint violations logged) | rare | Someone's logic is wrong — investigate every one |
| Ledger rows with `recorded_at − occurred_at` > 24h | rare | Backdated entry, worth a look |
| Orphan records — batches without products, etc. | zero | Referential integrity gap |

### 3.3 Physical truth

The above checks prove the system is consistent **with itself**. Only counting proves it is consistent with the shelf.

- **Cycle counting, blind.** The counter never sees the expected quantity — show it and they write down what the system says, which measures nothing.
- **Coverage target:** every A-class product counted monthly, B quarterly, C annually.
- **Accuracy is measured at SKU level, not value level.** Value-weighted accuracy hides a hundred small errors behind one large correct number.

```
stock_accuracy = (SKUs counted where system = physical) / (SKUs counted)
```

The Phase 2 gate — a location's system stock matching a physical count within 2% on a day including counter sales, with every variance carrying a posted ledger entry — is re-run monthly, not just once.

## 4. Business health

Reviewed monthly. These do not page anyone; they drive decisions.

| Metric | Definition | Watch for |
|---|---|---|
| **Stock accuracy** | Above | Below 98% |
| **Stockout rate** | Product-location-days at zero available ÷ total | Rising, or concentrated in A-class |
| **Fill rate** | Order lines fulfilled complete ÷ total lines | Below 95% |
| **Dead stock share** | Value with no movement in 60 days ÷ total stock value | Rising — cash trapping |
| **Wastage rate** | Wastage value ÷ COGS, **by category** | Above category baseline |
| **Days inventory outstanding** | Average stock value ÷ daily COGS | Rising — cash locking up |
| **Suggestion approval rate** | Approved ÷ total suggestions | Above 90% or below 50% — see [06](06-feedback-and-adaptation.md) |
| **Shrinkage** | Unexplained adjustment value ÷ COGS | Any trend |

**By category, not in aggregate.** Blended wastage of 3% across a business where F&V runs 12% and staples run 0.4% describes nothing that exists and hides the only number worth acting on.

## 5. Alerting discipline

| Severity | Examples | Route |
|---|---|---|
| **Page** | Ledger reconciliation failure, API down, reservations failing | Immediate, day or night |
| **Urgent** | Sweeper stopped, job failed 3× consecutively, webhook backlog | Working hours, same day |
| **Operational** | Stock out, expiring in 48h, ticket overdue in transit | To the person who can act, in the dashboard |
| **Informational** | Dead stock building, count variance above threshold | Daily digest |

The first two rows go to engineering; the last two go to shop and planning staff. Mixing them is how both groups learn to ignore alerts.

**Every alert names the action.** "Stock accuracy at Shop 3 is 94%" is a fact. "Stock accuracy at Shop 3 is 94% — 12 products with variance, count sheet ready" is an alert.

## 6. Continuous gate testing

The phase gates in [02 — Implementation plan](02-implementation-plan.md) are not one-time acceptance tests. Three of them run forever:

1. **Ledger rebuild** — every CI run, hourly in production.
2. **Concurrency** — nightly against staging. 200 concurrent reservations against 100 units must still yield exactly 100 successes.
3. **Scope isolation** — every CI run, exercising every RPC function as the wrong location and the wrong role.

A gate that passed once and is never re-run is a claim about the past.

---

## 7. Forward: agent evaluation

> **Not built in v1.** This section is the gate the agent layer must pass.

### Offline evaluation, before anything ships

A **golden set** of at least 200 questions with verified answers, drawn from real historical data: stock positions, movement traces, variance explanations, planning questions. Every agent capability is scored against it before release and after every model or prompt change.

| Measure | Bar |
|---|---|
| **Factual accuracy** — figures cited match the database exactly | 100%. A wrong number is a total failure, not a partial score |
| **Citation validity** — every claim links to a real, retrievable record | 100% |
| **Refusal correctness** — declines when data is insufficient rather than guessing | > 95% |
| **Scope discipline** — never surfaces cost or another location's data to a role that cannot see it, under adversarial prompting | 100%, no exceptions |
| **Proposal quality** — replayed against history, beats the formula | Must beat it, or it does not ship |

The first, second and fourth are pass/fail. There is no acceptable rate of fabricated stock figures in a system of record.

### In production

- **Every agent interaction logged in full** — prompt, retrieved context, tool calls, output, and whether a human accepted it.
- **Acceptance rate tracked** per capability. Falling acceptance means the agent is drifting or the data changed.
- **Automatic number verification.** Every figure in an agent response is re-queried against the database before display; a mismatch suppresses the response and raises an alert. This is cheap and it catches the one failure mode that matters.
- **Kill switch**, exercised in drills, not just documented.

### The standing rule

**An agent that cannot be evaluated does not get to act.** If a capability's correctness cannot be measured against ground truth, it ships as a suggestion with a visible label, or it does not ship.
