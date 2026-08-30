# 09 — Product: details and goal

*Read this first. Every other document assumes it.*

---

## 1. What Inventory Core is

A **system of record for stock**, deployed as one instance per business. It owns the answer to three questions — *how many, where, and worth what* — and serves that answer to any application that asks, over one shared interface.

It is not an app with an inventory feature. It is the service that other apps depend on for stock truth. The dashboard we build is simply its first consumer, and it gets no privileged access that a third-party app would not also get.

## 2. The one job

> For any quantity the system reports, produce the complete list of events that produced it, who caused each one, and when.

That is the product. Features are downstream of it. A system of record that is approximately right is worse than useless, because people who cannot trust one number stop trusting all of them, and every application built on top inherits the doubt.

## 3. Who it is for

**The first deployment is ours** — a multi-location grocery and general retail operation: one hub warehouse, several shops, goods ranging from staples to fruit and vegetables to packaged beauty products.

If another business wants this later, they get **their own deployment**: their own database, their own hosting, their own instance of the same codebase. Nobody's data shares a table with anybody else's.

That choice buys the strongest isolation available and keeps the schema simple — no organisation column in every table, index and query. It costs operational effort instead: every schema change becomes one migration per deployment, and each instance carries its own infrastructure floor. Comfortable to about five deployments; past ten it becomes somebody's job. See [01 — Business model](01-business-model.md) §4.

**Isolation inside a deployment still matters.** One company still has several shops and several roles, and a shop manager must not be able to read or change another shop's stock. That boundary is enforced exactly the way a company boundary would be — see [08 — Governance and safety](08-governance-and-safety.md).

### Personas

| Persona | What they do here | Primary surface |
|---|---|---|
| **Shop operator** | Receives deliveries, picks orders, counts stock, records damage | Phone, scan-first, minimal typing |
| **Shop manager** | Approves variances, reviews alerts, requests transfers | Tablet or laptop dashboard |
| **Head office planner** | Sets reorder policy, approves transfers, reviews dead stock | Laptop, dense tables and reports |
| **Developer** | Integrates a consuming app | REST API, OpenAPI spec, sandbox |

The operator persona drives more design decisions than any other. If receiving a shipment takes longer than the paper process it replaces, the data stops being entered and every other feature becomes fiction.

## 4. Non-goals

Stating these prevents scope drift later.

- **Not a point-of-sale.** We record counter sales because they change stock, not to run a till, print receipts or take card payments.
- **Not an accounting package.** We post the entries that stock movements create, and export them. We do not do payroll, tax filing or a full general ledger.
- **Not an e-commerce storefront.** The buy/sell app is a separate product that consumes this one.
- **Not a warehouse execution system.** No robotics, conveyor integration or slotting optimisation.
- **Not a supplier marketplace.** We hold supplier records; we do not run discovery or bidding.
- **Not a demand-forecasting product.** We compute reorder points from observed sell-through. Seasonality and machine-learned forecasting are deliberately deferred.

## 5. Product principles

The eight invariants below are the design constants. Every one is cheap to honour from day one and expensive-to-impossible to retrofit. Cite them by number in code review.

1. **Stock is a sum, not a number.** Every change is an immutable ledger row; the balance table is a projection you can delete and rebuild. When they disagree, the ledger wins.
2. **Nothing is ever deleted.** A wrong entry is cancelled by a compensating entry, never by an `UPDATE` or `DELETE`. A history with one quiet edit is not evidence.
3. **One product identity, globally.** Locations hold stock; they do not own identity. A product ID means the same thing in every location and every app.
4. **Goods in transit belong to nobody.** Dispatch decrements the source, receipt increments the destination, and in between the quantity is sellable from neither side.
5. **A ticket cannot close with unexplained variance.** Match, and it closes. Mismatch, and it needs a reason code, an approver and a posted adjustment first.
6. **Every write is idempotent.** The same key produces the same result and no second decrement.
7. **Negative stock is a database constraint**, not a validation. Application guards race; a `CHECK` in Postgres does not.
8. **An internal transfer is not a sale.** Same legal entity means a delivery challan — no revenue, no tax. Only external movement produces a tax invoice.

## 6. Success criteria

Measurable, and baselined before launch so the change is provable rather than asserted.

| Measure | Baseline | Target at 6 months |
|---|---|---|
| SKU-level stock accuracy (system vs physical count) | measure before launch | ≥ 98% |
| Time from a loss occurring to it being visible | weeks | same day |
| Time to receive a 40-line delivery | measure before launch | ≤ 15 minutes |
| Ledger-to-balance reconciliation failures | n/a | zero, ever |
| Oversells attributable to the stock service | measure before launch | zero |
| Dead stock as a share of stock value | measure before launch | reduced and *known* |

The fourth and fifth rows are absolute. Any non-zero value there is an incident, not a metric.

## 7. Scope of v1

**In:** products with variants and units of measure, locations, the stock ledger and balances, batch and expiry tracking, serial tracking (capability built, off by default), movements of all three kinds with ticketing and documents, reservations, physical counting, adjustments and wastage, reorder points and replenishment suggestions, alerts, the operator and manager dashboards, the public API with webhooks and a sandbox, bulk CSV import.

**Deferred, by design:** bins and pick paths, kitting and assembly, demand forecasting with seasonality, consignment ownership, multi-currency, e-way bill integration, offline capture, and the AI agent layer described in the forward sections of documents 03 through 08.

**The agent layer is deferred, not abandoned.** Stock correctness must be proven before anything probabilistic is allowed near it. Documents 03–08 each close with the design for it so that adding it later is additive rather than a rewrite.

## 8. The consuming applications

```
   Buy / sell app        Ops dashboard         Partner / supplier app
   (storefront,          (receiving,           (ASN, delivery
    checkout)             counting, admin)      confirmation)
         │                     │                       │
         └─────────────────────┼───────────────────────┘
                               ▼
                    Inventory Core public API
```

The buy/sell app is the demanding consumer, because it does something the dashboard never does: it takes stock away from a customer who has not paid yet, concurrently with everyone else. The reservation contract in [05 — Action and execution](05-action-and-execution.md) exists for it.

## 9. Open decisions

| Decision | Why it matters | Current assumption |
|---|---|---|
| Does the buy/sell app own order state, or delegate it here? | Sets the boundary between the two systems and therefore the whole API contract | The app owns orders and customers; Inventory Core owns stock, reservations and movements, and knows an order only as a reference on a ledger row |
| Perishables in scope at launch? | Moves batch and expiry from important to mandatory, and makes daily wastage posting non-optional | Yes. Built configurable per product either way |
| Serialised goods at launch? | Different table, different picking flow | Capability built, disabled by default |
| Single country? | Tax identifiers, HSN codes, e-way bills, currency | India first, with fields shaped so a second country is additive |
| Do intra-state transfers need an e-way bill at our values? | A tax invoice is **not** an e-way bill — that is a separate movement permit, generated on the GST portal and checked at the roadside. Thresholds for intra-state movement vary by state | **Open — awaiting confirmation from our accountant.** Until answered, the challan carries every field an e-way bill needs |

The first is worth settling before Phase 3 starts.
