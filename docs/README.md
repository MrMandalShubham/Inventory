# Inventory Core — specification set

A system of record for stock, deployed as one instance per business. Nine documents, written to be built from.

**Stack:** Next.js on Vercel · Supabase Postgres · one deployment per business, with location and role isolation enforced by row-level security.

**Scope decision:** the deterministic core is built and proven first. The AI agent layer is *designed* in documents 03–08 (each closes with a "Forward" section) but **not built in v1** — stock correctness must be provable before anything probabilistic touches it.

---

## Reading order

Start with 09, then 01 and 02. Documents 03–08 can be read in any order after that.

| # | Document | Owns |
|---|---|---|
| **09** | [Product: details and goal](09-product.md) | What we are building, for whom, the eight invariants, non-goals, success criteria |
| **01** | [Business model](01-business-model.md) | Who pays and why, cost structure, pricing, competition, risks |
| **02** | [Implementation plan](02-implementation-plan.md) | Stack constraints, repo structure, the isolation model, the nine build phases and their gates |
| **03** | [Reasoning and planning](03-reasoning-and-planning.md) | Decision logic: reorder points, replenishment, source selection, picking order, allocation priority |
| **04** | [Memory and retrieval](04-memory-and-retrieval.md) | The ledger, balances, retention, query patterns, point-in-time reconstruction, growth plan |
| **05** | [Action and execution](05-action-and-execution.md) | Every state-changing operation, the reservation lifecycle, the ticket state machine, the API surface |
| **06** | [Feedback and adaptation](06-feedback-and-adaptation.md) | How parameters improve from observation, bounded and logged; human overrides as data |
| **07** | [Evaluation and monitoring](07-evaluation-and-monitoring.md) | System, data and business health; the checks that page; continuous gate testing |
| **08** | [Governance and safety](08-governance-and-safety.md) | Roles, location scoping, separation of duties, RLS enforcement, audit, compliance, incident response |

## Integrating

| Document | For |
|---|---|
| [Storefront API](STOREFRONT-API.md) | Anyone building an app that sells from this inventory. Self-contained — keys, endpoints, the reserve/commit/release lifecycle, prices, images, and a working Next.js client |

## The eight invariants

Cited by number throughout. Full statements in [09 — Product](09-product.md) §5.

1. Stock is a sum, not a number
2. Nothing is ever deleted
3. One product identity, globally
4. Goods in transit belong to nobody
5. A ticket cannot close with unexplained variance
6. Every write is idempotent
7. Negative stock is a database constraint
8. An internal transfer is not a sale

## Build phases

| Phase | Delivers | Gate |
|---|---|---|
| 0 | Foundation — roles, location scoping, audit, ID minting | A shop manager cannot touch another location's stock and an operator cannot post an adjustment — proven through every `SECURITY DEFINER` function |
| 1 | Masters — products, locations, partners, bulk import | 5,000 products import in one pass; search under 200ms |
| 2 | Stock truth — ledger, balances, counting | Balance table rebuilds from the ledger exactly, wired into CI |
| 3 | Movement — tickets, documents, reconciliation, **receiving flow** | 100 dispatched, 97 arrive, 2 damaged: cannot close until all 100 explained — **and** an operator beats the paper process on a real delivery |
| 4 | Public API — reservations, webhooks, keys | 200 concurrent reservations against 100 units: exactly 100 succeed, zero oversells |
| 5 | **The product UI** — designed manager and operator surfaces | The working UI from Phases 1–4 is replaced, not extended |
| 6 | Insight and alerts — demand, supply, reorder | Suggestions reproduce a hand calculation for ten products |
| 7 | Cost and value — landed cost, valuation, margin | Gross margin from the ledger ties to a manual calculation to the paisa |
| 8 | Depth — bins, kitting, forecasting, statutory | Scoped per item; nothing here blocks launch |

**Phases 1–3 already constitute a working stock system.** If the build has to stop, it stops somewhere useful.

**Every phase ships a working UI** — plain tables and forms, enough to see and enter the data that phase added. The designed product UI is Phase 5. The one exception is the receiving flow, built properly in Phase 3 because its usability decides whether the system gets adopted at all. See [02 §4](02-implementation-plan.md).

## Open decisions

| Decision | Assumption | Settle by |
|---|---|---|
| Does the buy/sell app own order state, or delegate it here? | App owns orders; Inventory Core owns stock, reservations and movements | Before Phase 3 |
| **Do intra-state transfers need an e-way bill at our values?** | **Open — with our accountant.** A tax invoice is not an e-way bill; thresholds vary by state | **Before go-live**, not Phase 8 |
| Perishables in scope at launch? | Yes; built configurable per product either way | Phase 2 |
| Serialised goods at launch? | Capability built, disabled by default | Phase 2 |
| Single country? | India first, fields shaped so a second is additive | Phase 7 |

## Settled decisions

| Decision | Choice | Recorded in |
|---|---|---|
| Tenancy | **One deployment per business** — own database, own hosting, own instance. Revisit at ten deployments | [01](01-business-model.md) §2, [02](02-implementation-plan.md) §3 |
| AI agent | **Deferred, not abandoned.** Deterministic core proven first; the agent is designed in the forward sections of 03–08 | [09](09-product.md) §7 |
