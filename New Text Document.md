# Inventory Management Model

*Extracted from the B2B Business Model & Operating Plan. This file covers **only** stock: how it arrives, where it sits, how it is valued, how it moves, and how it leaves. Credit, pricing, routing and compliance are deliberately out of scope here.*

---

## 1. The one sentence that changes everything

**We own the stock.**

In the old marketplace model, kiranas owned their own stock and we took a commission. We carried no inventory risk. Now we buy goods, hold them, and sell them — so every rupee of stock is our cash sitting still, and every kilo that spoils is our loss.

That single change is where this entire document comes from.

---

## 2. Where stock lives

```
                 HUB  (home city, main shop)
                 • all buying happens here
                 • deep stock and slow movers
                 • overflow for the branches
                          │
                          │  stock transfer
        ┌─────────┬───────┴───────┬─────────┐
        ▼         ▼               ▼         ▼
    Branch 1  Branch 2       Branch 3   Branch N
    stock sized to that area's local demand
```

**Branches hold stock but make no decisions.** What to stock, what it costs, what it sells for, and when to reorder are all decided centrally. A branch picks, hands over, and delivers locally.

That is not a limitation — it is the only way branches stay consistent as their number grows.

---

## 3. The model change in the database

Today one table, `offer.vendor_offer`, holds **both** price and stock in the same row. That was right when competing vendors each set their own price on their own stock. With one seller, the two must come apart:

| | Changes with | Does **not** change with |
|---|---|---|
| **Price** | the customer's tier | the branch |
| **Stock** | the branch | the customer |

A shop pays ₹52/kg and a caterer pays ₹49/kg — **at every branch**. Branch 2 holds 400 kg — **whoever buys it**.

```
            OLD                              NEW
   ┌────────────────────┐      ┌──────────────────────────┐
   │ offer.vendor_offer │      │ pricing.price_list_item  │
   │  ├ vendor_id       │ ───▶ │  price per customer tier │
   │  ├ selling_price   │      ├──────────────────────────┤
   │  ├ stock_on_hand   │      │ inventory.branch_stock   │
   │  ├ stock_reserved  │      │  ├ on_hand               │
   │  └ batch/expiry    │      │  ├ reserved              │
   └────────────────────┘      │  ├ allocated_firm  (new) │
                               │  ├ in_transit      (new) │
                               │  └ weighted_avg_cost(new)│
                               └──────────────────────────┘
```

**This is the riskiest migration in the plan.** `vendor_offer_id` is referenced by order lines, reservations, batches, the search index and the cart. It must happen **before** procurement starts loading it with cost data.

Two things must survive the move rather than be rewritten:

- The `vendor_offer_reserved_within_stock` constraint and the atomic reservation statement — together these are the guarantee that stock is never oversold. **Port them, do not reimplement them.**
- `inventory_mode` stays as a column, but branches are all forced to **QUANTITY**. The looser modes existed for kiranas with unreliable counts. We control our own branches and need true numbers to value the stock.

---

## 4. The five numbers each SKU carries per branch

| Number | Plain meaning |
|---|---|
| `on_hand` | Physically sitting on the shelf |
| `reserved` | Spoken for by an order being placed |
| `allocated_firm` | Promised to a specific customer — typically an event |
| `in_transit` | Left the hub, not yet arrived at the branch |
| `weighted_avg_cost` | What this stock cost us, per unit |

**`in_transit` is a real state and belongs to nobody.** It is not hub stock and not branch stock, and must not be sellable from either. Without it, you order the same goods twice.

---

## 5. How stock arrives — goods receipt

**This is the most important new module in the whole build.**

```
PO (or direct mandi buy)
   → count and quality check
   → short / damage / rejection recorded  ← at receipt, never later
   → batch and expiry captured
   → freight and charges spread across the lines
   → LANDED COST computed and frozen
   → stock valued and added
   → supplier payable posted
```

**Landed cost is goods + freight + charges** — not the invoice price. If ₹20,000 of goods arrive with ₹500 of freight, the stock is worth ₹20,500 from that moment on.

**Every margin number in the business inherits its accuracy from this step.** Gross margin, contribution, per-customer profitability, the P&L. A sloppy goods receipt makes every report downstream a guess.

### Two flows, not one

- **Packaged goods** — formal purchase order, then receipt against it.
- **Fruit and vegetables** — mandi buying is same-day, price discovered on the day, no PO exists. The system must allow **"buy first, record immediately"**.

Forcing mandi purchases through a PO workflow guarantees the data never gets entered at all.

### Valuation method — decided once

**Weighted average cost.** Simpler than FIFO, robust to the constant small purchases this business makes, and standard for grocery distribution. FIFO is more precise for F&V, but not worth the complexity at this scale.

Change this casually later and every historic margin figure becomes incomparable.

---

## 6. How stock moves — hub to branch

```
branch sell-through + reorder point
   → transfer suggestion generated centrally
   → approved → picked at hub
   → delivery challan
   → IN TRANSIT
   → received at branch → discrepancy resolved
   → branch stock updated
```

### Reorder point is the whole game

```
reorder point = (average daily sell-through × lead time in days) + safety stock
```

Calculated **per branch, per SKU**, on a rolling window. Branch stock is sized to local demand — so letting branches guess recreates the exact problem the hub exists to solve.

### Transfers carry no tax

All branches are in **one state under one GSTIN**. So a hub→branch move is a **delivery challan**: no tax invoice, no GST charged, no input-credit hop. The stock keeps its landed cost; only its location changes.

In the ledger it is simply:

```
INVENTORY (hub)  →  INVENTORY_IN_TRANSIT  →  INVENTORY (branch)
```

No tax leg at all. This removes roughly half of what a transfer module would otherwise have to do.

> **Open exposure — R-9.** An e-way bill is legally required above ₹50,000 even within one state, and that integration is deferred. The challan carries the fields an e-way bill needs, so switching it on later is an API call rather than a redesign. **This is a known gap, not a solved item.**

---

## 7. How stock leaves

Four ways, and all four must reduce stock and post to the ledger:

| Exit | What happens |
|---|---|
| **Sale to a B2B customer** | Revenue + `COGS`, branch stock down |
| **Counter sale** (walk-in) | Same — stock truth, not a POS |
| **Wastage** | `WASTAGE` expense, branch stock down |
| **Stock count variance** | Adjustment posted with a reason |

If any one of these does not reduce stock, the system's number and the shelf's number drift apart, and nobody can tell which is right.

---

## 8. Wastage — the biggest margin leak

| | Staples | Fruit & veg | Beauty |
|---|---|---|---|
| Wastage | ~0.5% | **8–15%** | ~1% |
| Gross margin | 3–8% | 12–25% | 12–25% |
| Stock turns/year | 12–20 | **60–120** | **4–8** |

**F&V wastage is 8–15% against a 12–25% margin.** Wastage decides whether that category makes money at all.

So wastage is **posted daily, per branch, per category** — never a plug figure discovered at month end. If it is not measured daily, F&V margin is unknowable, and F&V is about a quarter of revenue.

**Beauty is the opposite trap:** best margin, worst turns. Overstocking it is the classic way a distributor with healthy margins runs out of cash.

---

## 9. Stock is cash sitting still

At **₹30 lakh monthly revenue**:

| | Days | Cash locked |
|---|---|---|
| Inventory held (DIO) | 20 | ₹18.0 L |
| Receivables (DSO) | 30 | ₹30.0 L |
| Less supplier credit (DPO) | −15 | −₹13.5 L |
| **Net working capital** | **35-day cycle** | **≈ ₹34.5 L** |

**₹34.5 lakh must sit still to run ₹30 lakh a month.** Inventory days are one of the three levers on that number — faster turns and less dead stock release cash directly.

The rule worth adopting now: **never approve a growth push without stating the working capital it consumes and where that cash comes from.** A distributor growing 40% on 30-day credit without funding it runs out of money *while profitable*.

---

## 10. Ledger accounts stock touches

| Account | Type | Scoped by |
|---|---|---|
| `INVENTORY` | Asset | location (hub / branch) |
| `INVENTORY_IN_TRANSIT` | Asset | location |
| `GST_INPUT_CREDIT` | Asset | — |
| `SUPPLIER_PAYABLE` | Liability | supplier |
| `COGS` | Expense | — |
| `WASTAGE` | Expense | — |

Every stock movement posts a balanced entry. Nothing changes stock without also changing the books, so the value of stock on the shelf and the value in the accounts cannot drift.

---

## 11. Build order

### Phase 5 — the split
| Part | What |
|---|---|
| P5.3 | Split `vendor_offer` into central price list + per-branch stock — **riskiest migration in the plan** |

### Phase 7 — procurement & landed cost
*Where margin truth is created. Nothing about profitability is trustworthy until this is right.*

| Part | What |
|---|---|
| P7.1 | Supplier master — GSTIN, terms, credit days, lead time |
| P7.2 | Purchase orders & indents |
| **P7.3** | **Goods receipt & landed cost — the most important new module** |
| P7.4 | Inventory valuation — weighted average cost |
| P7.5 | Mandi / direct purchase — receipt without a PO |
| P7.6 | Schemes & rebates accrued into landed cost |
| P7.7 | Supplier payables |

**Gate:** gross margin on a delivered order is computed from the ledger and ties to a manual calculation, **to the paisa**.

### Phase 8 — stock across locations
| Part | What |
|---|---|
| P8.1 | Branch stock truth — on-hand, reserved, in-transit, allocated |
| P8.2 | Hub↔branch transfer — challan, in-transit, receipt, discrepancy |
| **P8.3** | **Reorder points & replenishment — the hub-and-spoke mechanism** |
| P8.4 | Wastage & shrinkage — daily, per branch, per category |
| P8.5 | Physical stock count — cycle counting, variance approval |
| P8.6 | Counter-sale recording |

**Gate:** a branch's system stock matches a physical count **within 2%**, on a day that included counter sales, and every variance has a posted ledger entry explaining it.

---

## 12. What already exists and gets reused

| Already built | How it is used now |
|---|---|
| `offer.offer_batch` | Batch and expiry from goods receipt — repoint the foreign key |
| FEFO picking | Unchanged — oldest expiry picked first |
| Recall workflow | Unchanged — a bad lot can still be pulled and its customers found |
| Reservation + oversell constraint | **Ported, not rewritten** |
| Variable-weight capture | F&V is always sold by weight |

---

## 13. The four rules worth remembering

1. **Landed cost is fixed at receipt.** Everything downstream inherits its accuracy.
2. **Stock in transit belongs to nobody** and is sellable from nowhere.
3. **Wastage is posted daily**, per branch, per category — never a month-end plug.
4. **Reorder points are central**, per branch, per SKU. Branches hold stock; they do not decide it.