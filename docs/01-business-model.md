# 01 — Business model

---

## 1. The problem, and who pays to have it solved

Multi-location retail and distribution businesses lose money in four places at once, and all four trace to the same root cause: **no system owns the stock number, so several systems each own a version of it.**

- **Lost sales** from stockouts nobody saw coming.
- **Trapped cash** in stock that will not sell, discovered at year end.
- **Shrinkage** that surfaces weeks late, by which point the trail is cold.
- **Wastage**, which in fruit and vegetables runs 8–15% against a 12–25% margin and therefore decides whether the category earns anything at all.

The buyer feels this as a cash problem before they feel it as a data problem. At ₹30 lakh monthly revenue with 20 days of inventory, 30 days of receivables and 15 days of supplier credit, roughly **₹34.5 lakh sits still** to run ₹30 lakh a month. Inventory days is one of only three levers on that number, and it is the one most directly under management control.

That is the pitch: this is not a tidiness product, it is a working-capital product.

## 2. Two business models, and the delivery shape we chose

| | **Internal tool** | **Product for other businesses** |
|---|---|---|
| Who pays | Us, as a cost centre | Other businesses, per deployment |
| Success measure | Working capital released, stockouts avoided | Recurring revenue, retention |
| Delivery | One instance, ours | One instance each, same codebase |
| Risk | Sunk cost with no external validation | Distraction from the operating business |

**Decision: one deployment per business — its own database, hosting and instance of the same codebase.**

This is the instance-per-customer pattern, and it is a deliberate trade rather than a default. What it buys:

- **The strongest isolation available.** Not a policy separating two companies' rows — two separate databases. No shared table, no shared connection, no query that could ever cross.
- **A simpler schema.** No organisation column in every table, index and query, for a boundary that would only ever hold one value per deployment.
- **Per-customer freedom.** A customer can be on a different version, or carry a customisation, without it becoming everyone's problem.

What it costs, stated plainly:

- **Operational multiplication.** Every schema change is one migration run per deployment. Every incident is investigated per deployment. Version drift between customers becomes real.
- **A per-instance infrastructure floor** — see §4.
- **The expensive direction of travel.** Single-tenant → multi-tenant later means adding an organisation column to live schemas with years of data. We are choosing the direction that is costly to reverse, with open eyes.

**Comfortable to about five deployments. Past ten it becomes somebody's job**, and that is the point to reconsider — not before.

## 3. Value proposition, quantified

For a business at ₹30 lakh monthly revenue across one hub and four shops:

| Lever | Mechanism | Plausible annual effect |
|---|---|---|
| Fewer stockouts | Reorder points per shop per product replace guesswork | Recovering even 1% of lost sales ≈ ₹3.6 L revenue |
| Less dead stock | Slow movers identified and cleared instead of accumulating | Cash release, one-off, in the lakhs |
| Fewer duplicate orders | In-transit tracking stops the same goods being ordered twice | Direct spend reduction |
| Lower wastage | Expiry visibility drives sell-through or transfer before loss | On F&V, each 1% of wastage avoided is margin kept |
| Less time counting | Scan-based receiving and cycle counting replace full manual counts | Staff hours returned to selling |

**These are modelled, not measured.** The honest commitment in [07 — Evaluation and monitoring](07-evaluation-and-monitoring.md) is to baseline each one before launch so the improvement can be proven rather than claimed.

## 4. Cost structure

The chosen stack keeps fixed cost near zero until there is real usage, which is the right shape for a build that must justify itself.

Because each business gets its own instance, **Supabase cost multiplies with deployments and Vercel cost largely does not** — Vercel bills per seat, with many projects under one account.

| Component | Our deployment | Each additional | At 10 deployments |
|---|---|---|---|
| Supabase (Postgres, auth, storage) | Pro, ~$25/mo | **~$25/mo each** | ~$250/mo |
| Vercel (hosting, cron) | Pro, ~$20/mo | ~$0 — projects share the seat | ~$20–150/mo with usage |
| Domain, email, monitoring | ~$20/mo | ~$5/mo each | ~$70/mo |
| **Infrastructure total** | **≈ $65/mo** | **≈ $30/mo each** | **≈ $340–470/mo** |

The Supabase line is the one to watch: a **per-project floor of roughly $25/month** applies whether the instance is busy or idle. Ten quiet customers still cost $250/month before a single query runs. The free tier does not substitute — it pauses inactive projects, which is disqualifying for production.

**Infrastructure is still not the cost that matters.** Engineering and support time are, and under this model they scale with deployment count harder than infrastructure does: N migrations, N monitoring dashboards, N incident investigations. Any price charged to another business has to cover that operational multiplication before it covers servers.

Two further cost risks specific to this stack: Supabase database size grows monotonically because the ledger is append-only and never deleted (see the partitioning and archival plan in [04 — Memory and retrieval](04-memory-and-retrieval.md)), and Vercel function invocations scale with API traffic from consuming apps — the one variable a third-party integrator controls rather than us.

## 5. Pricing, if and when it becomes a product

A **base fee per deployment** — covering the instance, its migrations and its support — plus a **per-location fee**, because location count is the honest proxy for both value delivered and load created.

Not per user. Charging per seat punishes exactly the shop-floor adoption the system depends on, and shop-floor adoption is the difference between accurate stock and expensive fiction.

| Tier | Shape | Rough position |
|---|---|---|
| **Starter** | 1 location, core stock and movements, no API | Entry, land the single-shop operator |
| **Growth** | Up to 5 locations, transfers, reorder points, alerts, API read access | The main tier |
| **Business** | Unlimited locations, full API with webhooks, batch and serial tracking, priority support | Where the working-capital argument lands |

Unlimited users on every tier. Charge for locations and for API write access, not for seats.

## 6. Competitive position

| Alternative | Where it wins | Where it leaves a gap |
|---|---|---|
| **Spreadsheets** | Free, universally understood | No concurrency, no audit trail, no API, breaks past one location |
| **Tally / Vyapar** | Accounting-first, accountant-familiar, cheap | Stock is a byproduct of billing; weak multi-location, no usable API |
| **Zoho Inventory** | Broad, mature, good integrations | Generic; per-order pricing; not built for perishables or Indian multi-shop transfer patterns |
| **Unicommerce / Increff** | Strong for e-commerce fulfilment | Priced and shaped for scale we do not have; heavy to adopt |
| **Custom build per business** | Fits exactly | Every business pays the full build cost, and gets a system one person understands |

**Our differentiation is the API and the audit trail.** Most tools in this segment treat integration as an afterthought and history as a report. We treat the API as the product and the ledger as the foundation. For a buyer who already runs a storefront or plans one, that is the difference between a tool they use and a system they build on.

The realistic competitive truth: we are not going to out-feature Zoho. We win on being the stock brain that other applications plug into, and on getting perishable, multi-location Indian retail right in a way generic tools do not.

## 7. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Operators do not enter data, so the system drifts from the shelf | **High** — this is the classic failure | Scan-first mobile flows, receiving faster than paper, cycle counting from day one |
| Build takes longer than the operating business can wait | Medium | Phase gates with usable output at each; Phase 1–3 is already a working stock system |
| Per-deployment operations outgrow us | **Medium–high past 5 customers** | Migrations scripted and run against all instances from one command; version drift tracked; reconsider the model at ten |
| Supabase or Vercel pricing shifts | Low–medium | Everything is standard Postgres and standard Node; no proprietary lock-in beyond auth, which is replaceable |
| Building an AI agent too early, on numbers not yet trustworthy | Medium | Explicitly deferred; deterministic core proven first |
| Scope creep into POS or accounting | **High** — customers will ask | Non-goals listed in [09 — Product](09-product.md) and defended |

## 8. What would make this a bad idea

Stated plainly, because a business model document that cannot fail is not a business model document.

- If the operation is small enough that one person genuinely knows the stock, this is overhead.
- If nobody will scan, no software fixes the accuracy problem.
- If the buy/sell app never gets built, the API — our main differentiator — is speculative work.

The first two are testable inside a month of running Phase 3. The third is a decision, not a risk.
