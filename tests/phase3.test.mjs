// ============================================================
// PHASE 3 — CONFIRMATION TEST
//
// The gate, part one (docs/02 §5):
//
//   A transfer of 100 units where 97 arrive and 2 are damaged cannot
//   reach CLOSED until all 100 are accounted for. After closing,
//   ledger entries across source, destination and transit sum to
//   zero and the transit bucket is empty.
//
// The gate, part two is a stopwatch and a real delivery. It cannot
// be automated and is not attempted here — see the report.
//
// The canonical story from docs/05 §5:
//
//   Ordered 100. The hub dispatched 98 — two were already damaged on
//   the shelf. The shop counted 97 arriving; one lost in transit.
//   Of those, 3 were crushed, so 94 accepted and 3 rejected.
// ============================================================

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { AS, ID, asUser, connect, refused, runCheck, seed } from "./harness.mjs";

const q = (c, sql, params) => c.query(sql, params).then((r) => r.rows);
const one = async (c, sql, params) => (await q(c, sql, params))[0];

/** A committed connection acting as a given persona. */
async function as(claims) {
  const c = await connect();
  await c.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(claims)]);
  return c;
}

before(async () => {
  await seed();
  // Stock at the hub for transfers to draw on.
  const c = await as(AS.admin);
  try {
    await q(c, "select stock.post_movement($1,$2,500,'OPENING',null,'hub opening')",
      [ID.productA, ID.locHub]);
    await q(c, "select stock.post_movement($1,$2,300,'OPENING',null,'hub opening')",
      [ID.productB, ID.locHub]);
  } finally { await c.end(); }
});

// ─────────────────────── CI guards ───────────────────────

describe("CI checks after the movement schema", () => {
  test("every movement table has RLS and a policy", async () => {
    const v = await runCheck("rls-coverage");
    assert.deepEqual(v, [], v.map((x) => `  ${x.schema_name}.${x.table_name}: ${x.violation}`).join("\n"));
  });

  test("the definer surface is still fully scoped", async () => {
    const v = await runCheck("definer-scope");
    assert.deepEqual(v, [], v.map((x) => `  ${x.schema_name}.${x.function_name}`).join("\n"));
  });
});

// ═══════════════════════ THE GATE ═══════════════════════

describe("THE GATE — 100 ordered, 98 sent, 97 arrive, 3 crushed", () => {
  let ticket, lineId;

  test("a transfer is raised and approved by someone else", async () => {
    const raiser = await as(AS.planner);
    try {
      ticket = (await one(raiser,
        `select movement.create_movement('TRANSFER',$1,$2,null,$3::jsonb,'gate scenario') as id`,
        [ID.locHub, ID.locShop1, JSON.stringify([{ product_id: ID.productA, qty: 100 }])])).id;

      lineId = (await one(raiser, "select id from movement.line where movement_id = $1", [ticket])).id;

      // Separation of duties: not your own approval.
      await refused(
        () => raiser.query("select movement.approve_movement($1)", [ticket]),
        "SELF_APPROVAL");
    } finally { await raiser.end(); }

    const approver = await as(AS.admin);
    try {
      await q(approver, "select movement.approve_movement($1)", [ticket]);
      const m = await one(approver, "select status from movement.movement where id = $1", [ticket]);
      assert.equal(m.status, "APPROVED");
    } finally { await approver.end(); }
  });

  test("dispatching 98 empties the source and fills transit", async () => {
    const c = await as(AS.admin);
    try {
      const before = (await one(c,
        `select on_hand from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`,
        [ID.productA, ID.locHub])).on_hand;

      // Two were already damaged on the hub shelf, so 98 go.
      const sent = (await one(c,
        "select movement.dispatch_movement($1,$2::jsonb) as n",
        [ticket, JSON.stringify([{ line_id: lineId, qty: 98 }])])).n;
      assert.equal(sent, 98);

      const after = (await one(c,
        `select on_hand from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`,
        [ID.productA, ID.locHub])).on_hand;
      const transit = (await one(c,
        `select coalesce(sum(on_hand),0)::int as n from stock.balance
          where product_id=$1 and location_id = movement.transit_location()`,
        [ID.productA])).n;

      assert.equal(after, before - 98, "the source did not give up 98 units");
      assert.equal(transit, 98, "transit is not holding the 98 units");

      const m = await one(c, "select status from movement.movement where id = $1", [ticket]);
      assert.equal(m.status, "IN_TRANSIT");
    } finally { await c.end(); }
  });

  test("goods in transit are sellable from neither end", async () => {
    const c = await as(AS.admin);
    try {
      // The destination still holds exactly what the fixture gave it.
      // None of the 98 in transit have arrived, so none are countable
      // there — which is the whole of invariant 4.
      const destQty = (await one(c,
        `select on_hand from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`,
        [ID.productA, ID.locShop1])).on_hand;

      const dispatched = (await one(c,
        "select qty_dispatched from movement.line where id = $1", [lineId])).qty_dispatched;

      assert.equal(dispatched, 98);
      assert.equal(destQty, 100,
        "the destination is already counting goods that are still on the road");
    } finally { await c.end(); }
  });

  test("a dispatched ticket can no longer be cancelled", async () => {
    const c = await as(AS.admin);
    try {
      await refused(
        () => c.query("select movement.cancel_movement($1,'changed my mind')", [ticket]),
        "WRONG_STATUS");
    } finally { await c.end(); }
  });

  test("rejecting units without a reason is refused", async () => {
    const c = await as(AS.managerShop1);
    try {
      await refused(
        () => c.query("select movement.receive_movement($1,$2::jsonb)",
          [ticket, JSON.stringify([{ line_id: lineId, qty_received: 97, qty_rejected: 3 }])]),
        "REJECT_REASON_REQUIRED");
    } finally { await c.end(); }
  });

  test("receiving 97 with 3 crushed lands 94 usable and opens a discrepancy", async () => {
    const c = await as(AS.managerShop1);
    try {
      const result = (await one(c,
        "select movement.receive_movement($1,$2::jsonb) as s",
        [ticket, JSON.stringify([{
          line_id: lineId, qty_received: 97, qty_rejected: 3,
          reject_reason: "crushed in transit",
        }])])).s;

      assert.equal(result, "DISCREPANCY",
        "a ticket with a shortage and rejects must not reconcile itself");

      const line = await one(c,
        `select qty_ordered, qty_dispatched, qty_received, qty_rejected,
                qty_accepted, qty_lost
           from movement.line where id = $1`, [lineId]);

      assert.equal(line.qty_ordered, 100);
      assert.equal(line.qty_dispatched, 98);
      assert.equal(line.qty_received, 97);
      assert.equal(line.qty_rejected, 3);
      assert.equal(line.qty_accepted, 94, "94 should have joined usable stock");
      assert.equal(line.qty_lost, 1, "one unit left and never arrived");
    } finally { await c.end(); }
  });

  test("the 3 rejected units are on the shelf but not sellable", async () => {
    const c = await as(AS.admin);
    try {
      const b = await one(c,
        `select on_hand, damaged, available from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`,
        [ID.productA, ID.locShop1]);

      assert.equal(b.damaged, 3, "the rejected units are not recorded as damaged");
      assert.equal(b.on_hand - b.damaged, b.available,
        "damaged stock is being offered for sale");
    } finally { await c.end(); }
  });

  test("THE GATE — it cannot close while a unit is unexplained", async () => {
    const c = await as(AS.admin);
    try {
      const m = await one(c, "select status from movement.movement where id = $1", [ticket]);
      assert.equal(m.status, "DISCREPANCY");

      // No path from DISCREPANCY to CLOSED except through resolution.
      await refused(
        () => c.query("select movement.dispatch_movement($1)", [ticket]),
        "WRONG_STATUS");
      await refused(
        () => c.query("select movement.resolve_discrepancy($1,'')", [ticket]),
        "REASON_REQUIRED");

      // And transit still visibly holds the missing unit.
      const transit = (await one(c,
        `select coalesce(sum(on_hand),0)::int as n from stock.balance
          where product_id=$1 and location_id = movement.transit_location()`,
        [ID.productA])).n;
      assert.equal(transit, 1, "the lost unit should still be sitting in transit");
    } finally { await c.end(); }
  });

  test("the receiver may not approve their own variance", async () => {
    const c = await as(AS.managerShop1);   // Meena received it
    try {
      await refused(
        () => c.query("select movement.resolve_discrepancy($1,'carrier lost one')", [ticket]),
        "SELF_APPROVAL");
    } finally { await c.end(); }
  });

  test("resolved by someone else, it closes and transit empties", async () => {
    const c = await as(AS.admin);
    try {
      const written = (await one(c,
        "select movement.resolve_discrepancy($1,'carrier query raised, one unit lost') as n",
        [ticket])).n;
      assert.equal(written, 1, "the lost unit should have been written off");

      const m = await one(c,
        "select status, resolved_by, received_by from movement.movement where id = $1", [ticket]);
      assert.equal(m.status, "CLOSED");
      assert.notEqual(m.resolved_by, m.received_by, "receiver and resolver must differ");

      const transit = (await one(c,
        `select coalesce(sum(on_hand),0)::int as n from stock.balance
          where product_id=$1 and location_id = movement.transit_location()`,
        [ID.productA])).n;
      assert.equal(transit, 0, "THE TRANSIT BUCKET MUST BE EMPTY");
    } finally { await c.end(); }
  });

  test("every one of the 98 dispatched units is accounted for", async () => {
    const c = await as(AS.admin);
    try {
      const l = await one(c,
        `select qty_dispatched, qty_accepted, qty_rejected, qty_lost
           from movement.line where id = $1`, [lineId]);

      assert.equal(
        l.qty_accepted + l.qty_rejected + l.qty_lost, l.qty_dispatched,
        "94 accepted + 3 rejected + 1 lost must equal the 98 sent");

      // And the ledger tells the same story from the other side.
      const legs = await q(c,
        `select loc.code, sum(l.qty_delta)::int as net
           from stock.ledger l join platform.location loc on loc.id = l.location_id
          where l.movement_id = $1 group by loc.code order by loc.code`, [ticket]);

      const net = Object.fromEntries(legs.map((r) => [r.code, r.net]));
      assert.equal(net.HUB, -98, "the hub gave up 98");
      assert.equal(net.SH1, 97, "the shop took in 97 — 94 usable plus 3 damaged");
      assert.equal(net.TRANSIT, 0, "transit is square");
      assert.equal(net.HUB + net.SH1 + net.TRANSIT, -1,
        "the net across all three legs is the one unit genuinely lost");
    } finally { await c.end(); }
  });

  test("balance and transit health checks are both clean afterwards", async () => {
    const c = await as(AS.admin);
    try {
      assert.deepEqual(await q(c, "select * from stock.verify_balances()"), [],
        "the ledger and the projection disagree after a transfer");
      assert.deepEqual(await q(c, "select * from movement.verify_transit()"), [],
        "transit holds stock no open ticket claims");
    } finally { await c.end(); }
  });
});

// ─────────────────── the clean path ───────────────────

describe("A clean transfer closes itself", () => {
  test("counts that match need nobody's attention", async () => {
    const raiser = await as(AS.planner);
    let ticket, line;
    try {
      ticket = (await one(raiser,
        `select movement.create_movement('TRANSFER',$1,$2,null,$3::jsonb,'clean run') as id`,
        [ID.locHub, ID.locShop1, JSON.stringify([{ product_id: ID.productB, qty: 40 }])])).id;
      line = (await one(raiser, "select id from movement.line where movement_id=$1", [ticket])).id;
    } finally { await raiser.end(); }

    const c = await as(AS.admin);
    try {
      await q(c, "select movement.approve_movement($1)", [ticket]);
      await q(c, "select movement.dispatch_movement($1)", [ticket]);
      const result = (await one(c, "select movement.receive_movement($1,$2::jsonb) as s",
        [ticket, JSON.stringify([{ line_id: line, qty_received: 40 }])])).s;

      assert.equal(result, "CLOSED", "a matching count should close without a human");

      const transit = (await one(c,
        `select coalesce(sum(on_hand),0)::int as n from stock.balance
          where product_id=$1 and location_id = movement.transit_location()`,
        [ID.productB])).n;
      assert.equal(transit, 0);
    } finally { await c.end(); }
  });
});

// ─────────── invariant 8: a transfer is not a sale ───────────

describe("Documents — invariant 8", () => {
  test("a transfer produces a delivery challan with no tax", async () => {
    const c = await as(AS.admin);
    try {
      const doc = await one(c,
        `select d.kind, d.tax_paise, d.doc_no
           from movement.document d
           join movement.movement m on m.id = d.movement_id
          where m.type = 'TRANSFER' order by d.issued_at desc limit 1`);

      assert.equal(doc.kind, "DELIVERY_CHALLAN",
        "an internal transfer must not raise a tax invoice");
      assert.equal(doc.tax_paise, null, "you cannot charge yourself tax");
      assert.match(doc.doc_no, /^DC-\d{4}-\d{6}$/);
    } finally { await c.end(); }
  });

  test("an export to a customer produces a tax invoice", async () => {
    const raiser = await as(AS.planner);
    let ticket;
    try {
      const customer = (await one(raiser,
        "select id from partner.partner where 'CUSTOMER' = any(kinds) limit 1")).id;
      ticket = (await one(raiser,
        `select movement.create_movement('EXPORT',$1,null,$2,$3::jsonb,'sale') as id`,
        [ID.locHub, customer, JSON.stringify([{ product_id: ID.productA, qty: 5, unit_cost: 4200 }])])).id;
    } finally { await raiser.end(); }

    const c = await as(AS.admin);
    try {
      await q(c, "select movement.approve_movement($1)", [ticket]);
      await q(c, "select movement.dispatch_movement($1)", [ticket]);

      const doc = await one(c,
        "select kind, doc_no, goods_value_paise from movement.document where movement_id = $1", [ticket]);
      assert.equal(doc.kind, "TAX_INVOICE");
      assert.match(doc.doc_no, /^INV-\d{4}-\d{6}$/);

      const m = await one(c, "select status from movement.movement where id = $1", [ticket]);
      assert.equal(m.status, "CLOSED", "an export ends when the goods leave");

      // Nothing of ours is in transit — it left the business.
      assert.deepEqual(await q(c, "select * from movement.verify_transit()"), []);
    } finally { await c.end(); }
  });
});

// ─────────────────── the location boundary ───────────────────

describe("The boundary holds across a movement", () => {
  test("a shop cannot dispatch from a location it does not hold", async () => {
    const raiser = await as(AS.planner);
    let ticket;
    try {
      ticket = (await one(raiser,
        `select movement.create_movement('TRANSFER',$1,$2,null,$3::jsonb,'boundary') as id`,
        [ID.locHub, ID.locShop1, JSON.stringify([{ product_id: ID.productA, qty: 5 }])])).id;
    } finally { await raiser.end(); }

    const approver = await as(AS.admin);
    try { await q(approver, "select movement.approve_movement($1)", [ticket]); }
    finally { await approver.end(); }

    // Meena holds Shop 1, not the hub.
    const meena = await as(AS.managerShop1);
    try {
      await refused(
        () => meena.query("select movement.dispatch_movement($1)", [ticket]),
        "FORBIDDEN_LOCATION");
    } finally { await meena.end(); }
  });

  test("a shop cannot receive at a location it does not hold", async () => {
    const raiser = await as(AS.planner);
    let ticket, line;
    try {
      ticket = (await one(raiser,
        `select movement.create_movement('TRANSFER',$1,$2,null,$3::jsonb,'boundary 2') as id`,
        [ID.locHub, ID.locShop2, JSON.stringify([{ product_id: ID.productA, qty: 5 }])])).id;
      line = (await one(raiser, "select id from movement.line where movement_id=$1", [ticket])).id;
    } finally { await raiser.end(); }

    const admin = await as(AS.admin);
    try {
      await q(admin, "select movement.approve_movement($1)", [ticket]);
      await q(admin, "select movement.dispatch_movement($1)", [ticket]);
    } finally { await admin.end(); }

    // Meena holds Shop 1; this is going to Shop 2.
    const meena = await as(AS.managerShop1);
    try {
      await refused(
        () => meena.query("select movement.receive_movement($1,$2::jsonb)",
          [ticket, JSON.stringify([{ line_id: line, qty_received: 5 }])]),
        "FORBIDDEN_LOCATION");
    } finally { await meena.end(); }
  });

  test("an operator cannot raise a movement", async () => {
    const c = await as(AS.operatorShop1);
    try {
      await refused(
        () => c.query(`select movement.create_movement('TRANSFER',$1,$2,null,$3::jsonb)`,
          [ID.locShop1, ID.locHub, JSON.stringify([{ product_id: ID.productA, qty: 1 }])]),
        "FORBIDDEN_ROLE");
    } finally { await c.end(); }
  });
});

// ─────────────────── shape rules ───────────────────

describe("The three types are genuinely different shapes", () => {
  test("a transfer to itself is refused", async () => {
    const c = await as(AS.planner);
    try {
      await refused(
        () => c.query(`select movement.create_movement('TRANSFER',$1,$1,null,$2::jsonb)`,
          [ID.locHub, JSON.stringify([{ product_id: ID.productA, qty: 1 }])]),
        "transfer_shape");
    } finally { await c.end(); }
  });

  test("an import cannot be dispatched — it arrives", async () => {
    const raiser = await as(AS.planner);
    let ticket;
    try {
      const supplier = (await one(raiser,
        "select id from partner.partner where 'SUPPLIER' = any(kinds) limit 1")).id;
      ticket = (await one(raiser,
        `select movement.create_movement('IMPORT',null,$1,$2,$3::jsonb,'delivery') as id`,
        [ID.locShop1, supplier, JSON.stringify([{ product_id: ID.productA, qty: 20 }])])).id;
    } finally { await raiser.end(); }

    const c = await as(AS.admin);
    try {
      await q(c, "select movement.approve_movement($1)", [ticket]);
      await refused(
        () => c.query("select movement.dispatch_movement($1)", [ticket]),
        "NOT_DISPATCHABLE");

      // It is received instead, and that works.
      const line = (await one(c, "select id from movement.line where movement_id=$1", [ticket])).id;
      const result = (await one(c, "select movement.receive_movement($1,$2::jsonb) as s",
        [ticket, JSON.stringify([{ line_id: line, qty_received: 20 }])])).s;
      assert.equal(result, "CLOSED");
    } finally { await c.end(); }
  });

  test("a movement with no lines is refused", async () => {
    const c = await as(AS.planner);
    try {
      await refused(
        () => c.query(`select movement.create_movement('TRANSFER',$1,$2,null,'[]'::jsonb)`,
          [ID.locHub, ID.locShop1]),
        "NO_LINES");
    } finally { await c.end(); }
  });
});
