# 06 — Feedback and adaptation

*How the system's own parameters improve from observing what actually happened.*

---

## 1. The principle

Every planning parameter in [03 — Reasoning and planning](03-reasoning-and-planning.md) starts as an assumption. Adaptation is the process of replacing each assumption with a measurement, on a schedule, within bounds, visibly.

Three rules govern all of it:

1. **Adaptation is bounded.** No parameter moves more than a set percentage per cycle. A single anomalous week must not be able to reset a policy.
2. **Adaptation is logged.** Every parameter change writes a row: old value, new value, the evidence, the run that produced it. A planner asking "why did this reorder point jump" gets an answer.
3. **Adaptation never touches stock.** These loops change *parameters*, never quantities. The ledger is not an input to anything that writes to the ledger.

## 2. The four learning loops

### 2.1 Demand — sell-through

**Assumption replaced:** how fast this product sells at this location.

Recomputed nightly from outbound ledger rows over a rolling 28 days, excluding days the location was closed. Two adjustments that matter:

- **Stockout censoring.** Days when available stock was zero are excluded from the average. A product that sold 0 units because there were none to sell did not have zero demand, and counting it as such starts a death spiral: low observed demand → lower reorder point → more stockouts → lower observed demand.
- **Outlier damping.** A single day beyond three standard deviations is capped at that bound rather than dropped, so a genuine bulk order influences the average without dominating it.

### 2.2 Supply — supplier lead time

**Assumption replaced:** how long this supplier actually takes.

```
lead_time_days = median(receipt_date − order_date) over the last 6 receipts
```

**Median, not mean.** One supplier disaster that took 21 days should not permanently inflate a 3-day lead time — but if it happens twice more, the median moves and the reorder point should move with it.

Tracked per supplier *and* per product where they differ, because the same supplier is often quick on staples and slow on specialities.

### 2.3 Variability — safety stock

**Assumption replaced:** how much buffer this product needs here.

```
safety_stock = z × σ_demand × √lead_time_days
```

`σ_demand` is measured from the same 28-day window; `z` comes from the target service level, set per ABC class rather than globally — an A-class product might target 98%, a C-class 90%. Carrying 98% service on every product is how a business ties up cash protecting items nobody misses.

Recomputed weekly. Changes above 20% are flagged for planner review rather than applied silently.

### 2.4 Loss — wastage and shrinkage rates

**Assumption replaced:** what this category normally loses.

Wastage is posted **daily, per location, per category** — never discovered as a month-end plug figure. From that, a rolling normal rate per category, which becomes the baseline the alerting engine measures against. F&V running 11% against its own 9% baseline is a signal; F&V running 11% against a global 1% average is noise.

## 3. Human feedback is data

The most valuable adaptation signal is not a measurement — it is a planner disagreeing with the system.

Every suggestion carries an outcome: **approved, adjusted, or rejected with a reason.** Those outcomes are recorded and reviewed:

| Pattern | What it means | Response |
|---|---|---|
| One product's suggestions repeatedly adjusted upward | Reorder point systematically low — likely stockout censoring not working | Investigate the specific product |
| One location's suggestions repeatedly rejected | Local knowledge the model lacks — a closure, a road, a seasonal pattern | Talk to the manager, consider a location parameter |
| Adjustments cluster in one category | A structural gap, not a tuning problem | Revisit the logic in [03](03-reasoning-and-planning.md) |
| Approval rate above 90% and stable | The system is trusted and roughly right | Consider raising auto-approval thresholds |

**Approval rate is the single best health metric for the planning system.** If planners approve everything without reading, that is a problem. If they reject most of it, the suggestions are worthless and the daily run is wasted effort. Somewhere in between is a system being used properly.

## 4. Cadence

| When | What adapts | Applied |
|---|---|---|
| Nightly | Sell-through, days of cover, dead stock flags | Automatically |
| Weekly | Safety stock, ABC/XYZ class, wastage baselines | Automatically, with >20% changes flagged |
| On receipt | Supplier lead time median | Automatically |
| Monthly | Service level targets per class, review of override patterns | **Human decision, never automatic** |

The monthly row is deliberately manual. Service level is a business trade-off between cash and availability, not a number to be optimised by a job.

## 5. Guardrails

| Guardrail | Rule |
|---|---|
| Maximum change per cycle | No parameter moves more than 30% in one recalculation |
| Minimum evidence | No adaptation from fewer than 14 days of data, or fewer than 3 receipts for lead time |
| New product handling | Uses category defaults until it has its own history — never a reorder point derived from two days of sales |
| Change log | Every parameter change is a row with old value, new value, evidence, run ID |
| Reversibility | Any recalculation run can be reverted wholesale, restoring the previous parameter set |
| Freeze | Parameters can be pinned per product or location, so a planner's manual override is not overwritten nightly |

The freeze mechanism matters more than it looks. Without it, a planner sets a value in the morning, the nightly run overwrites it, and they conclude the system does not listen — after which they stop using it.

## 6. What does not adapt

- **The invariants.** Nothing in this loop can weaken a constraint.
- **Approval thresholds and permissions.** Governance changes are human decisions, in [08 — Governance and safety](08-governance-and-safety.md).
- **Valuation method.** Weighted average, decided once. Changing it makes every historic margin figure incomparable.
- **Anything during a data quality incident.** If reconciliation is failing, adaptation pauses — learning from numbers known to be wrong makes the parameters wrong too.

---

## 7. Forward: agent adaptation

> **Not built in v1.**

### What the agent could learn from

The override record in section 3 is a labelled dataset: the system proposed X, a human chose Y, and here is their stated reason. That is exactly the signal a model can generalise from where a formula cannot — "this manager always cuts oil orders before a long weekend" is a pattern with no column to hold it.

### The hard boundary

**The agent may propose parameter changes. It may never apply them.**

A proposal reaches the same approval queue as any other agent action, stating the parameter, the current value, the proposed value, and the specific overrides that justify it. A human approves, and the ordinary change-log path applies it.

Two failure modes this prevents, both of which are severe and quiet:

1. **Feedback loops.** An agent that adjusts parameters, then learns from outcomes shaped by its own adjustments, drifts with no external correction and no obvious moment of failure.
2. **Learned bias becoming policy.** If overrides encode one planner's habits — including their mistakes — an agent that applies them automatically promotes personal preference into system-wide rule without anyone deciding to.

### Evaluation before any of it

No agent adaptation ships without the offline evaluation described in [07 — Evaluation and monitoring](07-evaluation-and-monitoring.md): replay historical periods, compare the agent's proposed parameters against what actually happened, and demonstrate it would have beaten the formula. **If it cannot beat the arithmetic on history, it does not get to touch the future.**
