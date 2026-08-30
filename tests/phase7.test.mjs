// ============================================================
// PHASE 7 — CONFIRMATION TEST
//
// The gate (docs/02 §5):
//
//   Gross margin on one dispatched order, computed from the ledger,
//   ties to a manual calculation to the paisa.
//
// "To the paisa" is the whole point. Everything in this phase exists
// so that margin is a fact read out of the books rather than a number
// a report recalculates from a price list — because those two answers
// diverge, quietly, and nobody can say which is right.
//
// The scenario, in whole rupees so it can be checked in your head:
//
//   Buy 100 units at ₹40         goods     ₹4,000
//   Freight on the delivery                  ₹500
//   Landed cost per unit         ₹45  ( 4000 + 500 ) / 100
//   Sell 30 units at ₹60         revenue   ₹1,800
//   COGS                         30 × ₹45  ₹1,350
//   GROSS MARGIN                            ₹450   = 25.00%
// ============================================================

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { AS, ID, connect, refused, runCheck, seed } from "./harness.mjs";

const q = (c, sql, p) => c.query(sql, p).then((r) => r.rows);
const one = async (c, sql, p) => (await q(c, sql, p))[0];

async function as(claims) {
  const c = await connect();
  await c.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(claims)]);
  await c.query("set role authenticated");
  return c;
}

const R = (rupees) => rupees * 100;      // paise

let productId, supplierId, customerId;

before(async () => {
  await seed();
  const c = await as(AS.admin);
  try {
    productId = (await one(c,
      `insert into catalog.product (name, base_uom_id)
       values ('Margin Test', (select id from catalog.uom where code='PCS')) returning id`)).id;
    supplierId = (await one(c,
      "select id from partner.partner where 'SUPPLIER' = any(kinds) limit 1")).id;
    customerId = (await one(c,
      "select id from partner.partner where 'CUSTOMER' = any(kinds) limit 1")).id;
  } finally { await c.end(); }
});

// ─────────────────────── CI guards ───────────────────────

describe("CI checks after accounting", () => {
  test("every ledger table has RLS and a policy", async () => {
    const v = await runCheck("rls-coverage");
    assert.deepEqual(v, [], v.map((x) => `  ${x.schema_name}.${x.table_name}: ${x.violation}`).join("\n"));
  });

  test("the definer surface is still fully scoped", async () => {
    const v = await runCheck("definer-scope");
    assert.deepEqual(v, [], v.map((x) => `  ${x.schema_name}.${x.function_name}`).join("\n"));
  });
});

// ═══════════════════════ THE GATE ═══════════════════════

describe("THE GATE — margin from the books, to the paisa", () => {
  let importId, exportId;

  test("goods arrive, and the freight lands on the stock", async () => {
    const raiser = await as(AS.planner);
    try {
      importId = (await one(raiser,
        `select movement.create_movement('IMPORT',null,$1,$2,$3::jsonb,'gate purchase') as id`,
        [ID.locShop1, supplierId,
         JSON.stringify([{ product_id: productId, qty: 100, unit_cost: R(40) }])])).id;

      // ₹500 of freight on the delivery. Through the function — there
      // is no UPDATE policy on movement.movement, and a raw write here
      // would silently affect zero rows.
      await q(raiser, "select movement.set_charges($1, $2)", [importId, R(500)]);
    } finally { await raiser.end(); }

    const c = await as(AS.admin);
    try {
      await q(c, "select movement.approve_movement($1)", [importId]);
      const line = (await one(c, "select id from movement.line where movement_id=$1", [importId])).id;
      const res = (await one(c, "select movement.receive_movement($1,$2::jsonb) as s",
        [importId, JSON.stringify([{ line_id: line, qty_received: 100 }])])).s;
      assert.equal(res, "CLOSED");

      // Landed cost = goods + freight, spread over what arrived.
      const l = await one(c,
        "select unit_cost, landed_unit_cost from movement.line where id=$1", [line]);
      assert.equal(Number(l.unit_cost), R(40), "the invoice price is unchanged");
      assert.equal(Number(l.landed_unit_cost), R(45),
        "landed cost must be (₹4,000 + ₹500) ÷ 100 = ₹45, not the ₹40 on the invoice");

      // And the shelf is valued at it.
      const b = await one(c,
        `select on_hand, weighted_avg_cost from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`,
        [productId, ID.locShop1]);
      assert.equal(b.on_hand, 100);
      assert.equal(Number(b.weighted_avg_cost), R(45),
        "stock is worth ₹4,500 the moment it arrives, not ₹4,000");
    } finally { await c.end(); }
  });

  test("the purchase posted a balanced journal", async () => {
    const c = await as(AS.admin);
    try {
      const rows = await q(c,
        `select e.account_code, e.debit_paise, e.credit_paise
           from ledger.journal j join ledger.entry e on e.journal_id = j.id
          where j.source_id = $1 order by e.account_code`, [importId]);

      const inv = rows.find((r) => r.account_code === "INVENTORY");
      const pay = rows.find((r) => r.account_code === "SUPPLIER_PAYABLE");

      assert.equal(Number(inv.debit_paise), R(4500), "inventory rises by the LANDED value");
      assert.equal(Number(pay.credit_paise), R(4500), "and the supplier is owed it");
    } finally { await c.end(); }
  });

  test("30 units are sold at ₹60", async () => {
    const raiser = await as(AS.planner);
    try {
      exportId = (await one(raiser,
        `select movement.create_movement('EXPORT',$1,null,$2,$3::jsonb,'gate sale') as id`,
        [ID.locShop1, customerId,
         JSON.stringify([{ product_id: productId, qty: 30, unit_cost: R(60) }])])).id;
    } finally { await raiser.end(); }

    const c = await as(AS.admin);
    try {
      await q(c, "select movement.approve_movement($1)", [exportId]);
      await q(c, "select movement.dispatch_movement($1)", [exportId]);

      const m = await one(c, "select status from movement.movement where id=$1", [exportId]);
      assert.equal(m.status, "CLOSED", "an export ends when the goods leave");
    } finally { await c.end(); }
  });

  test("the goods left at COST, not at the price the customer paid", async () => {
    const c = await as(AS.admin);
    try {
      const entry = await one(c,
        `select unit_cost, total_value, qty_delta from stock.ledger
          where movement_id = $1 and reason_code = 'ISSUE'`, [exportId]);

      assert.equal(entry.qty_delta, -30);
      assert.equal(Number(entry.unit_cost), R(45),
        "the stock movement must carry the weighted average, not the ₹60 selling price");
      assert.equal(Number(entry.total_value), R(1350), "30 × ₹45");

      // And the average did not move on the way out.
      const b = await one(c,
        `select on_hand, weighted_avg_cost from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`,
        [productId, ID.locShop1]);
      assert.equal(b.on_hand, 70);
      assert.equal(Number(b.weighted_avg_cost), R(45),
        "stock leaving at the average does not change the average");
    } finally { await c.end(); }
  });

  test("THE GATE — margin from the ledger ties to the hand calculation", async () => {
    const c = await as(AS.admin);
    try {
      const m = await one(c, "select * from movement.order_margin($1)", [exportId]);
      assert.ok(m, "no margin row — the sale posted nothing");

      // The hand calculation, in paise.
      const revenue = 30 * R(60);          // 180,000
      const cogs    = 30 * R(45);          // 135,000
      const margin  = revenue - cogs;      //  45,000

      assert.equal(Number(m.revenue_paise), revenue, "revenue: 30 × ₹60 = ₹1,800");
      assert.equal(Number(m.cogs_paise),    cogs,    "COGS: 30 × ₹45 = ₹1,350");
      assert.equal(Number(m.margin_paise),  margin,  "margin: ₹1,800 − ₹1,350 = ₹450");
      assert.equal(Number(m.margin_pct),    25.00,   "25.00%");
    } finally { await c.end(); }
  });

  test("and the freight is the difference — costing at invoice price would have overstated it", async () => {
    const c = await as(AS.admin);
    try {
      const m = await one(c, "select * from movement.order_margin($1)", [exportId]);

      // Had the freight been ignored, COGS would have been 30 × ₹40.
      const naiveCogs = 30 * R(40);
      const naiveMargin = 30 * R(60) - naiveCogs;

      assert.ok(Number(m.margin_paise) < naiveMargin,
        "ignoring freight would have reported a higher margin than the business earned");
      assert.equal(naiveMargin - Number(m.margin_paise), 30 * R(5),
        "the gap is exactly the freight carried by the 30 units sold");
    } finally { await c.end(); }
  });
});

// ─────────────── charges close when the goods land ───────────────

describe("Charges", () => {
  async function draftImport() {
    const c = await as(AS.planner);
    try {
      return (await one(c,
        `select movement.create_movement('IMPORT',null,$1,$2,$3::jsonb,'charges') as id`,
        [ID.locShop1, supplierId,
         JSON.stringify([{ product_id: productId, qty: 10, unit_cost: R(10) }])])).id;
    } finally { await c.end(); }
  }

  test("an operator may not price a delivery", async () => {
    const id = await draftImport();
    const c = await as(AS.operatorShop1);
    try {
      await refused(
        () => c.query("select movement.set_charges($1,$2)", [id, R(100)]),
        "FORBIDDEN");
    } finally { await c.end(); }
  });

  test("a negative charge is not a discount", async () => {
    const id = await draftImport();
    const c = await as(AS.planner);
    try {
      await refused(
        () => c.query("select movement.set_charges($1,$2)", [id, -1]),
        "NEGATIVE_CHARGE");
    } finally { await c.end(); }
  });

  test("charges are refused once the goods have been counted in", async () => {
    const id = await draftImport();
    const c = await as(AS.admin);
    try {
      await q(c, "select movement.approve_movement($1)", [id]);
      const line = (await one(c, "select id from movement.line where movement_id=$1", [id])).id;
      await q(c, "select movement.receive_movement($1,$2::jsonb)",
        [id, JSON.stringify([{ line_id: line, qty_received: 10 }])]);

      // Landed cost is fixed at receipt. Editing it now would leave
      // the average and the books telling different stories.
      await refused(
        () => c.query("select movement.set_charges($1,$2)", [id, R(100)]),
        "COST_ALREADY_FIXED");
    } finally { await c.end(); }
  });
});

// ─────────────── weighted average, properly ───────────────

describe("Weighted average cost", () => {
  test("two receipts at different prices produce the weighted average, not the latest", async () => {
    const c = await as(AS.admin);
    try {
      const p = (await one(c,
        `insert into catalog.product (name, base_uom_id)
         values ('WAC Test', (select id from catalog.uom where code='PCS')) returning id`)).id;

      // 100 @ ₹10, then 100 @ ₹20 → ₹15, not ₹20.
      await q(c, "select stock.post_movement($1,$2,100,'OPENING',null,'first',null,$3)",
        [p, ID.locShop1, R(10)]);
      await q(c, "select stock.post_movement($1,$2,100,'RECEIPT',null,'second',null,$3)",
        [p, ID.locShop1, R(20)]);

      const b = await one(c,
        `select on_hand, weighted_avg_cost from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`, [p, ID.locShop1]);

      assert.equal(b.on_hand, 200);
      assert.equal(Number(b.weighted_avg_cost), R(15),
        "(100×₹10 + 100×₹20) ÷ 200 = ₹15");
    } finally { await c.end(); }
  });

  test("an uneven split still weights correctly", async () => {
    const c = await as(AS.admin);
    try {
      const p = (await one(c,
        `insert into catalog.product (name, base_uom_id)
         values ('WAC Uneven', (select id from catalog.uom where code='PCS')) returning id`)).id;

      // 300 @ ₹10 and 100 @ ₹30 → (3000 + 3000) / 400 = ₹15.
      await q(c, "select stock.post_movement($1,$2,300,'OPENING',null,'bulk',null,$3)",
        [p, ID.locShop1, R(10)]);
      await q(c, "select stock.post_movement($1,$2,100,'RECEIPT',null,'pricey',null,$3)",
        [p, ID.locShop1, R(30)]);

      const b = await one(c,
        `select weighted_avg_cost from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`, [p, ID.locShop1]);
      assert.equal(Number(b.weighted_avg_cost), R(15));
    } finally { await c.end(); }
  });
});

// ─────────────── invariant 8, in the books ───────────────

describe("A transfer is not a sale — invariant 8", () => {
  test("moving stock between our own shops posts no revenue and no tax", async () => {
    const raiser = await as(AS.planner);
    let t;
    try {
      await (async () => {
        const c = await as(AS.admin);
        try {
          await q(c, "select stock.post_movement($1,$2,200,'OPENING',null,'hub',null,$3)",
            [productId, ID.locHub, R(45)]);
        } finally { await c.end(); }
      })();

      t = (await one(raiser,
        `select movement.create_movement('TRANSFER',$1,$2,null,$3::jsonb,'internal') as id`,
        [ID.locHub, ID.locShop1,
         JSON.stringify([{ product_id: productId, qty: 50 }])])).id;
    } finally { await raiser.end(); }

    const c = await as(AS.admin);
    try {
      await q(c, "select movement.approve_movement($1)", [t]);
      await q(c, "select movement.dispatch_movement($1)", [t]);
      const line = (await one(c, "select id from movement.line where movement_id=$1", [t])).id;
      await q(c, "select movement.receive_movement($1,$2::jsonb)",
        [t, JSON.stringify([{ line_id: line, qty_received: 50 }])]);

      const accounts = await q(c,
        `select distinct e.account_code
           from ledger.journal j join ledger.entry e on e.journal_id = j.id
          where j.source_id = $1`, [t]);
      const codes = accounts.map((a) => a.account_code);

      assert.ok(!codes.includes("REVENUE"), "a transfer must not create revenue");
      assert.ok(!codes.includes("GST_OUTPUT_TAX"), "you cannot charge yourself tax");
      assert.ok(!codes.includes("COGS"), "moving stock is not a cost of sale");
      assert.ok(codes.includes("INVENTORY_IN_TRANSIT"),
        "value should pass through transit, owned by nobody");

      // And the challan carries no tax.
      const doc = await one(c,
        "select kind, tax_paise from movement.document where movement_id=$1", [t]);
      assert.equal(doc.kind, "DELIVERY_CHALLAN");
      assert.equal(doc.tax_paise, null);
    } finally { await c.end(); }
  });

  test("value is not created or destroyed by the move", async () => {
    const c = await as(AS.admin);
    try {
      // Transit must be empty of value once everything has arrived.
      const t = await one(c,
        `select coalesce(sum(debit_paise) - sum(credit_paise), 0)::bigint as bal
           from ledger.entry where account_code = 'INVENTORY_IN_TRANSIT'`);
      assert.equal(Number(t.bal), 0,
        "transit still holds value — something left one shop and reached neither");
    } finally { await c.end(); }
  });

  test("posting revenue for a transfer is refused outright", async () => {
    const c = await as(AS.admin);
    try {
      const t = await one(c,
        "select id from movement.movement where type='TRANSFER' limit 1");
      await refused(
        () => c.query("select movement.post_sale_revenue($1)", [t.id]),
        "NOT_A_SALE");
    } finally { await c.end(); }
  });
});

// ─────────────── the books hold together ───────────────

describe("The books", () => {
  test("every journal balances", async () => {
    const c = await as(AS.admin);
    try {
      const bad = await q(c, "select * from ledger.verify_balanced()");
      assert.deepEqual(bad, [], "debits and credits differ somewhere");
    } finally { await c.end(); }
  });

  test("an unbalanced journal cannot be committed", async () => {
    const c = await connect();
    try {
      await c.query("begin");
      // The balance check is DEFERRED — a journal is written line by
      // line and is only meant to balance once complete. So the write
      // succeeds and the COMMIT is what refuses it, which is the
      // behaviour that actually protects the books.
      await c.query(
        `select ledger.post('MANUAL','deliberately lopsided',$1::jsonb)`,
        [JSON.stringify([
          { account: "INVENTORY", debit: 1000 },
          { account: "COGS", credit: 900 },
        ])]);
      await refused(() => c.query("commit"), "UNBALANCED_JOURNAL");
    } finally {
      await c.query("rollback").catch(() => {});
      await c.end();
    }
  });

  test("...and 100 paise going missing is enough to stop it", async () => {
    const c = await connect();
    try {
      await c.query("begin");
      await c.query(
        `select ledger.post('MANUAL','one rupee adrift',$1::jsonb)`,
        [JSON.stringify([
          { account: "INVENTORY", debit: 100000 },
          { account: "SUPPLIER_PAYABLE", credit: 99900 },
        ])]);
      await refused(() => c.query("commit"), "UNBALANCED_JOURNAL");
    } finally {
      await c.query("rollback").catch(() => {});
      await c.end();
    }
  });

  test("the inventory account ties to what the shelves are worth", async () => {
    const c = await as(AS.admin);
    try {
      const books = Number((await one(c,
        `select coalesce(sum(debit_paise) - sum(credit_paise), 0)::bigint as v
           from ledger.entry where account_code = 'INVENTORY'`)).v);

      const shelves = Number((await one(c,
        `select coalesce(sum(value_paise), 0)::bigint as v from stock.valuation()`)).v);

      // Nothing changes stock without also changing the books — that
      // is the entire reason for migration 0029.
      assert.equal(books, shelves,
        `the books say ${books} paise and the shelves say ${shelves} — they must not drift`);
    } finally { await c.end(); }
  });

  test("the ledger is append-only, like the stock ledger", async () => {
    const c = await connect();
    try {
      await refused(() => c.query("update ledger.journal set description='x'"), "APPEND_ONLY");
      await refused(() => c.query("delete from ledger.journal"), "APPEND_ONLY");
    } finally { await c.end(); }
  });

  test("a trial balance comes out", async () => {
    const c = await as(AS.admin);
    try {
      const rows = await q(c, "select * from ledger.trial_balance()");
      assert.ok(rows.length > 0, "no accounts have any movement");

      const dr = rows.reduce((a, r) => a + Number(r.debit_paise), 0);
      const cr = rows.reduce((a, r) => a + Number(r.credit_paise), 0);
      assert.equal(dr, cr, "a trial balance that does not balance is not a trial balance");
    } finally { await c.end(); }
  });
});

// ─────────────── opening stock is not a loss ───────────────

describe("Opening stock", () => {
  test("goes to equity, not to an expense account", async () => {
    const c = await as(AS.admin);
    try {
      const rows = await q(c,
        `select e.account_code, e.debit_paise, e.credit_paise
           from ledger.journal j
           join ledger.entry e on e.journal_id = j.id
          where j.description like 'OPENING%'`);

      assert.ok(rows.length > 0, "no opening stock was posted at all");

      const codes = new Set(rows.map((r) => r.account_code));
      assert.ok(codes.has("OPENING_BALANCE"),
        "opening stock must land in equity — it is the balance the business started with");
      assert.ok(!codes.has("STOCK_ADJUSTMENT"),
        "opening stock filed as a count variance reports the whole starting inventory " +
        "as value that went missing, and puts a phantom expense in the P&L");
      assert.ok(!codes.has("WASTAGE"), "opening stock is not spoilage either");
    } finally { await c.end(); }
  });

  test("a real count variance still goes to the adjustment account", async () => {
    const c = await as(AS.admin);
    try {
      const p = (await one(c,
        `insert into catalog.product (name, base_uom_id)
         values ('Variance Test', (select id from catalog.uom where code='PCS')) returning id`)).id;

      await q(c, "select stock.post_movement($1,$2,50,'OPENING',null,'start',null,$3)",
        [p, ID.locShop1, R(20)]);
      // Two units short on the shelf.
      await q(c, "select stock.post_movement($1,$2,-2,'ADJUST',null,'short on count')",
        [p, ID.locShop1]);

      const rows = await q(c,
        `select e.account_code, e.debit_paise
           from ledger.journal j
           join ledger.entry e on e.journal_id = j.id
          where j.description like 'ADJUST%' and e.debit_paise > 0`);

      const adj = rows.find((r) => r.account_code === "STOCK_ADJUSTMENT");
      assert.ok(adj, "a count variance must be visible as one — that is the whole finding");
      assert.equal(Number(adj.debit_paise), 2 * R(20), "2 units at ₹20");
    } finally { await c.end(); }
  });
});

// ─────────────── money is role-restricted ───────────────

describe("Money is not for everyone", () => {
  test("an operator cannot read the accounting entries", async () => {
    const c = await as(AS.operatorShop1);
    try {
      const rows = await q(c, "select * from ledger.entry limit 5");
      assert.deepEqual(rows, [],
        "an operator read the books — docs/08 says operators never see cost or margin");
    } finally { await c.end(); }
  });

  test("an operator gets no margin figure", async () => {
    const c = await as(AS.operatorShop1);
    try {
      const t = await one(c, "select id from movement.movement where type='EXPORT' limit 1");
      const rows = await q(c, "select * from movement.order_margin($1)", [t.id]);
      assert.deepEqual(rows, [], "margin leaked to an operator");
    } finally { await c.end(); }
  });

  test("finance can", async () => {
    const c = await as({ ...AS.admin, role: "finance" });
    try {
      const rows = await q(c, "select * from ledger.trial_balance()");
      assert.ok(rows.length > 0, "finance must be able to read the books");
    } finally { await c.end(); }
  });
});

// ─────────────── everything still reconciles ───────────────

describe("After all of that", () => {
  test("stock, transit, reservations and the books all agree", async () => {
    const c = await as(AS.admin);
    try {
      assert.deepEqual(await q(c, "select * from stock.verify_balances()"), []);
      assert.deepEqual(await q(c, "select * from movement.verify_transit()"), []);
      assert.deepEqual(await q(c, "select * from stock.verify_reservations()"), []);
      assert.deepEqual(await q(c, "select * from ledger.verify_balanced()"), []);
    } finally { await c.end(); }
  });
});
