# 08 — Governance and safety

*Who may do what, how it is enforced, and what happens when something goes wrong.*

---

## 1. Access control model

Each business runs its own deployment, so there is no cross-company boundary to police inside the database. **Two dimensions remain, and a permission is granted only when both allow it.**

```
WHO    (role)           →  what kind of operation
WHERE  (location scope) →  at which locations
```

That the company boundary is now physical rather than logical does not make the remaining boundary less important. A shop manager who can adjust another shop's stock is the same failure at a smaller scale, and it fails just as silently.

### Roles

| Role | Can | Cannot |
|---|---|---|
| **Operator** | Receive, pick, count, record wastage and damage at their location | Approve variances, adjust stock, see cost or margin |
| **Shop manager** | Everything an operator can, plus approve variances at their location, request transfers | Approve their own variance, change reorder policy |
| **Planner** | View all locations, set reorder policy, approve transfers and purchase orders | Approve stock adjustments, change permissions |
| **Finance** | View cost, valuation and margin everywhere; approve write-offs | Change stock quantities |
| **Admin** | Manage users, roles, locations, API clients | Bypass the audit log, delete history |
| **API client** | Only its explicit scopes | Anything not scoped; any interactive session |

### Separation of duties

The rules that make the audit trail meaningful rather than decorative:

1. **Nobody approves their own variance.** The person who counted is not the person who signs off the difference.
2. **Operators never adjust stock directly.** They record a count; the variance flows through approval.
3. **Planners set policy; they do not move stock.** They approve movements, but the physical actions belong to operators.
4. **Admins manage access; they do not touch stock.** The person who can grant permissions should not also be able to use them on inventory.

Without these, a single account can create a shortage and approve the explanation for it, and no amount of logging detects that.

## 2. Enforcement lives in the database

Application-layer permission checks are advisory — one missed check in one new endpoint and they are gone. **Row-level security is the enforcement layer.**

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

### The three failure modes to design against

1. **`SECURITY DEFINER` functions bypass RLS entirely.** Every one must check location and role explicitly in its own body. This is the single most likely source of a privilege leak — and it is silent: no error, no crash, just one shop adjusting stock it does not own, discovered later by the shop that lost it.
2. **The service role key skips everything.** It exists for migrations and nothing else. It never reaches a route handler, never reaches the browser, and its use is alerted on.
3. **Tables added without RLS.** A CI query over `pg_policies` fails the build if any table in a stock schema lacks a policy. A convention nobody checks is a convention nobody keeps.

## 3. The audit trail

Two layers, both append-only.

| Layer | Records | Answers |
|---|---|---|
| `stock_ledger` | Every quantity change | "Why is the number what it is?" |
| `audit_log` | Every field change on every entity | "Who changed this setting, and when?" |

The audit log captures actor, timestamp, entity, field, old value, new value, and the request that caused it. It covers permission changes, price and policy changes, product edits, approval actions and API key lifecycle events — everything that is not a quantity.

**Neither table permits `UPDATE` or `DELETE`**, enforced by trigger rather than by convention. Not even an admin can rewrite history; the database refuses.

## 4. Data protection

| Data | Where it appears | Handling |
|---|---|---|
| Staff names, emails | Auth, audit trail, approvals | Retained while employed plus statutory period |
| Customer name, address, phone | Delivery documents, order references | Minimum needed for fulfilment and tax records |
| Supplier contacts | Partner master | Business contact data |
| Cost and margin | Ledger, valuation | Role-restricted; operators never see it |

### Deletion requests versus statutory retention

These conflict, and the conflict has a defined resolution rather than being discovered during an incident.

- **Personal data can be redacted** — a customer's name and address on a historical document are replaced with a tombstone reference.
- **The transaction record cannot be deleted.** Quantities, values, dates and document numbers are statutory records with an 8-year retention obligation.
- **Redaction is itself an audited event**, recorded with who requested it and when.

The commitment made to a customer is therefore: *we will remove your personal details; we cannot remove the fact that a sale occurred.* That is both lawful and honest, and it must be what the privacy notice actually says.

## 5. Secrets and keys

| Secret | Storage | Rotation |
|---|---|---|
| Supabase service role key | Vercel environment, production only, never in code | On any suspected exposure |
| API client keys | Hashed at rest; shown once at creation | Client-initiated, or forced by admin |
| Webhook signing secrets | Per client, hashed | With key rotation |
| Third-party credentials | Vercel environment | Per provider policy |

API keys are hashed like passwords. A database read must not yield a usable key. Every key has a scope set, an optional expiry, and a last-used timestamp so dormant keys can be found and revoked.

## 6. Compliance surface

| Requirement | What the system must hold | Status |
|---|---|---|
| **GST** | Tax identifiers on partners, HSN codes on products, correct invoice vs delivery-note distinction | Built in v1 |
| **E-way bill** | A separate movement permit generated on the GST portal — **not** the same as a tax invoice, and checked at the roadside rather than at filing. Generally required above ₹50,000, including intra-state, though several states set their own intra-state threshold | **Open, not closed.** Awaiting our accountant's answer on our state's threshold and whether same-GSTIN stock transfers need one at our values. Challan already carries every required field, so enabling it is an API call, not a redesign |
| **FSSAI batch traceability** | Batch, expiry, and the ability to trace a lot to every recipient | Built in v1 |
| **Statutory record retention** | 8 years for tax-relevant documents | Built into retention policy |
| **Weights and measures** | Variable-weight capture for goods sold by weight | Built in v1 |

**On the e-way bill, one distinction is worth stating flatly**, because it is the assumption that catches people: having a proper tax invoice for goods does **not** satisfy the e-way bill requirement. They are different documents doing different jobs — one proves a sale and its tax, the other permits goods to be in transit, and only the second is what an officer stopping a vehicle asks for.

The case most easily missed is our own core operation: a **warehouse-to-shop transfer under one GSTIN**. There is no sale, so there is no tax invoice at all — only a delivery challan — and the e-way bill requirement can still apply on consignment value. The consequence of getting it wrong is not a filing correction; it is a detained vehicle and a penalty.

Two questions to put to our accountant, and this row closes or moves:

1. What is the **intra-state** e-way bill threshold in our state?
2. Do **stock transfers under a single GSTIN** require one at our typical consignment values?

If the answer is no, this is marked closed. If yes, it leaves Phase 8 — at that point it is not a missing feature, it is exposure running in production.

## 7. Incident response

The incident that matters most in this system is **"the numbers are wrong."**

1. **Contain.** Freeze the affected scope — a location, a product, or the whole instance. Better a blocked operation than a compounding error.
2. **Establish truth.** The ledger is authoritative. Rebuild the balance from it and compare. If the ledger itself is wrong, physical count is the only remaining truth.
3. **Correct forward.** Compensating entries, never edits. The wrong number stays visible with its correction beside it.
4. **Notify.** Any consuming app that read wrong data during the window is told, via webhook and directly. A silent correction is how a partner's data quietly diverges from ours.
5. **Record.** Every incident gets a written record: what happened, the blast radius, root cause, and the specific check added so it is caught automatically next time.

**Rule: never fix data by hand in production without a written record and a second person.** Direct SQL against the ledger is how an incident becomes an unrecoverable one.

## 8. Change management

- **Migrations are forward-only**, reviewed, and never edited once run anywhere.
- **A migration touching the ledger must be additive.** Rewriting historical rows breaks invariant 2 and invalidates every point-in-time query.
- **Every migration ships with its rollback plan written down**, even when the plan is "restore from point-in-time backup".
- **Point-in-time recovery enabled** on the production database, with restore drills performed rather than assumed.
- **Permission changes are audited** and reviewed quarterly — dormant accounts and unused API keys are revoked.

---

## 9. Forward: agent safety

> **Not built in v1.** This section is the precondition for building it.

### The threat model

Even in a single-company deployment, **text the company did not write reaches the agent's context.** Product descriptions arrive from suppliers and catalogues, note fields are typed by staff and partners, and document references pass through third parties. None of it is authored with the agent in mind, and some of it may be authored against it.

| Threat | Mitigation |
|---|---|
| **Prompt injection** via product or supplier text | Untrusted content is passed as clearly delimited data, never as instruction. The agent is told explicitly that record content is data. Tool permissions are enforced server-side, so a successful injection still cannot exceed the agent's scope |
| **Scope escape** | Agent runs under a scoped key like any other client. Retrieval, including vector search, carries the same location and role filters. Adversarial scope-escape prompts are part of the eval set at a 100% bar |
| **Fabricated figures** | Every number in a response is re-queried and verified before display; a mismatch suppresses the response |
| **Runaway actions** | Agent writes go to an approval queue, never to the ledger. Per-hour proposal caps and a value ceiling that escalates approval |
| **Data exfiltration via output** | Responses scanned for credentials and bulk personal data before display |
| **Cost or abuse** | Per-deployment rate and spend limits, monitored |

### Non-negotiables

1. **No privileged path.** The agent uses the public API with a scoped key. Whatever a third-party integrator cannot do, the agent cannot do.
2. **No unsupervised writes.** Every stock-changing proposal requires human approval, and executes under that human's identity with the agent recorded as originator.
3. **No agent in the critical path.** Receiving, picking, reserving and closing tickets must work identically with the agent disabled. It is an accessory, never a dependency.
4. **A kill switch that is drilled**, not merely documented — revoking the agent's key must be a single action requiring no deploy.
5. **Every interaction logged in full** and retained for review.

### The governing sentence

**The agent is a client of this system, not a component of it.** Everything above follows from that placement, and it is what makes the agent layer safe to add later — and safe to remove if it does not earn its place.
