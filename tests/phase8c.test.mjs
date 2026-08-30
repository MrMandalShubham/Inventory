// ============================================================
// SELF-APPROVAL — CONFIRMATION TEST
//
// Migration 0047 relaxes separation of duties for a single-operator
// business. Relaxing a control is exactly where a test earns its keep,
// because the failure mode is silent: everything keeps working, and
// the thing that stopped happening is the check.
//
// So this proves the relaxation is as narrow as it claims:
//
//   • an admin may approve their own request
//   • NOBODY else may, however senior
//   • the setting genuinely switches it off
//   • and every self-approval is recorded, forever
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

let productId, supplierId;

before(async () => {
  await seed();
  const c = await as(AS.admin);
  try {
    productId = (await one(c,
      `insert into catalog.product (name, base_uom_id)
       values ('Self Approval Test', (select id from catalog.uom where code='PCS')) returning id`)).id;
    supplierId = (await one(c,
      "select id from partner.partner where 'SUPPLIER' = any(kinds) limit 1")).id;
  } finally { await c.end(); }
});

/** An import raised BY the given persona. */
async function raiseImport(claims, note = "self approval") {
  const c = await as(claims);
  try {
    return (await one(c,
      `select movement.create_movement('IMPORT',null,$1,$2,$3::jsonb,$4) as id`,
      [ID.locShop1, supplierId,
       JSON.stringify([{ product_id: productId, qty: 10, unit_cost: 100 }]), note])).id;
  } finally { await c.end(); }
}

async function setFlag(value) {
  const c = await as(AS.admin);
  try {
    await q(c, "update platform.setting set value = $1 where key = 'admin_may_self_approve'",
      [String(value)]);
  } finally { await c.end(); }
}

// ─────────────────────── CI guards ───────────────────────

describe("CI checks after relaxing the control", () => {
  for (const check of ["rls-coverage", "definer-scope", "function-overloads", "server-only", "search-path"]) {
    test(`${check} still passes`, async () => {
      const v = await runCheck(check);
      assert.deepEqual(v, [],
        v.map((x) => `  ${x.schema_name}.${x.table_name ?? x.function_name}: ${x.violation}`).join("\n"));
    });
  }
});

// ─────────── the relaxation, and its exact edges ───────────

describe("An admin may approve their own request", () => {
  test("and it works", async () => {
    const id = await raiseImport(AS.admin);
    const c = await as(AS.admin);
    try {
      await q(c, "select movement.approve_movement($1)", [id]);
      const m = await one(c,
        "select status, self_approved, approved_by, raised_by from movement.movement where id=$1", [id]);
      assert.equal(m.status, "APPROVED");
      assert.equal(m.raised_by, m.approved_by, "this test is meaningless unless they are the same person");
    } finally { await c.end(); }
  });

  test("THE POINT — it is recorded, permanently", async () => {
    const id = await raiseImport(AS.admin);
    const c = await as(AS.admin);
    try {
      await q(c, "select movement.approve_movement($1)", [id]);
      const m = await one(c, "select self_approved from movement.movement where id=$1", [id]);

      assert.equal(m.self_approved, true,
        "a relaxed control that leaves no trace is just a missing control — when a " +
        "second approver is hired, these are the movements nobody else ever saw");

      const listed = await q(c, "select * from movement.self_approved_movements(90)");
      assert.ok(listed.some((r) => r.id === id),
        "the governance report did not include it");
    } finally { await c.end(); }
  });

  test("a normally approved movement is NOT flagged", async () => {
    // Raised by the planner, approved by the admin — two people, as
    // the control intends.
    const id = await raiseImport(AS.planner);
    const c = await as(AS.admin);
    try {
      await q(c, "select movement.approve_movement($1)", [id]);
      const m = await one(c, "select self_approved from movement.movement where id=$1", [id]);
      assert.equal(m.self_approved, false,
        "flagging a properly reviewed movement would make the report useless noise");
    } finally { await c.end(); }
  });
});

describe("The relaxation is exactly as narrow as it claims", () => {
  test("a PLANNER still cannot approve their own request", async () => {
    const id = await raiseImport(AS.planner);
    const c = await as(AS.planner);
    try {
      await refused(
        () => c.query("select movement.approve_movement($1)", [id]),
        "SELF_APPROVAL");
    } finally { await c.end(); }
  });

  test("a SHOP MANAGER still cannot", async () => {
    const id = await raiseImport(AS.managerShop1);
    const c = await as(AS.managerShop1);
    try {
      await refused(
        () => c.query("select movement.approve_movement($1)", [id]),
        "SELF_APPROVAL");
    } finally { await c.end(); }
  });

  test("so the control returns by itself the day staff are hired", async () => {
    // Nothing has to be remembered or switched: the exemption is tied
    // to the admin role, and staff are not admins.
    const id = await raiseImport(AS.planner);
    const c = await as(AS.planner);
    try {
      await refused(() => c.query("select movement.approve_movement($1)", [id]), "SELF_APPROVAL");
    } finally { await c.end(); }
  });

  test("an operator still cannot approve anything at all", async () => {
    const id = await raiseImport(AS.admin);
    const c = await as(AS.operatorShop1);
    try {
      await refused(() => c.query("select movement.approve_movement($1)", [id]), "FORBIDDEN_ROLE");
    } finally { await c.end(); }
  });
});

describe("The setting actually switches it", () => {
  test("turning it off restores the original refusal, for the admin too", async () => {
    await setFlag(false);
    try {
      const id = await raiseImport(AS.admin);
      const c = await as(AS.admin);
      try {
        await refused(
          () => c.query("select movement.approve_movement($1)", [id]),
          "SELF_APPROVAL");
      } finally { await c.end(); }
    } finally {
      await setFlag(true);
    }
  });

  test("and turning it back on works", async () => {
    const id = await raiseImport(AS.admin);
    const c = await as(AS.admin);
    try {
      await q(c, "select movement.approve_movement($1)", [id]);
      const m = await one(c, "select status from movement.movement where id=$1", [id]);
      assert.equal(m.status, "APPROVED");
    } finally { await c.end(); }
  });

  test("only an admin may change the setting", async () => {
    const c = await as(AS.planner);
    try {
      const before = (await one(c,
        "select value from platform.setting where key='admin_may_self_approve'")).value;

      // RLS refuses the write silently — the UPDATE matches no rows
      // rather than raising, which is how a policy declines.
      await q(c, "update platform.setting set value='false' where key='admin_may_self_approve'");

      const admin = await as(AS.admin);
      try {
        const after = (await one(admin,
          "select value from platform.setting where key='admin_may_self_approve'")).value;
        assert.equal(after, before, "a planner changed which controls apply");
      } finally { await admin.end(); }
    } finally { await c.end(); }
  });

  test("everyone can READ the setting — a control nobody can see is not a control", async () => {
    const c = await as(AS.operatorShop1);
    try {
      const rows = await q(c, "select * from platform.setting where key='admin_may_self_approve'");
      assert.equal(rows.length, 1);
    } finally { await c.end(); }
  });
});

// ─────────── the variance, which is the riskier half ───────────

describe("Resolving a discrepancy you caused", () => {
  /** A transfer dispatched short, so it lands in DISCREPANCY. */
  async function shortTransfer(receiver) {
    const admin = await as(AS.admin);
    let id;
    try {
      await q(admin, "select stock.post_movement($1,$2,50,'OPENING',null,'stock',null,100)",
        [productId, ID.locHub]);

      id = (await one(admin,
        `select movement.create_movement('TRANSFER',$1,$2,null,$3::jsonb,'short') as id`,
        [ID.locHub, ID.locShop1, JSON.stringify([{ product_id: productId, qty: 10 }])])).id;
    } finally { await admin.end(); }

    // Raised by admin, approved by planner — a clean approval, so the
    // only self-approval in play is the variance itself.
    const planner = await as(AS.planner);
    try {
      await q(planner, "select movement.approve_movement($1)", [id]);
    } finally { await planner.end(); }

    // Dispatched from the HUB by somebody who holds it — a shop
    // manager holds only their shop, so they cannot send from the
    // warehouse. The receiver is the persona under test.
    let line;
    const hub = await as(AS.admin);
    try {
      await q(hub, "select movement.dispatch_movement($1)", [id]);
      line = (await one(hub, "select id from movement.line where movement_id=$1", [id])).id;
    } finally { await hub.end(); }

    const c = await as(receiver);
    try {
      // Two short.
      const status = (await one(c, "select movement.receive_movement($1,$2::jsonb) as s",
        [id, JSON.stringify([{ line_id: line, qty_received: 8 }])])).s;
      assert.equal(status, "DISCREPANCY");
    } finally { await c.end(); }

    return id;
  }

  test("an admin may close a variance they received", async () => {
    const id = await shortTransfer(AS.admin);
    const c = await as(AS.admin);
    try {
      const n = await one(c, "select movement.resolve_discrepancy($1,$2) as n",
        [id, "carrier confirmed two cartons short"]);
      assert.equal(Number(n.n), 2);

      const m = await one(c,
        "select status, self_approved from movement.movement where id=$1", [id]);
      assert.equal(m.status, "CLOSED");
      assert.equal(m.self_approved, true, "closing your own variance must be recorded");
    } finally { await c.end(); }
  });

  test("the write-off still comes out of TRANSIT, not off the shelf", async () => {
    const c = await as(AS.admin);
    try {
      // The goods never reached Shop 1, so they were never on that
      // shelf — this is the invariant the relaxation must not disturb.
      const drift = await q(c, "select * from movement.verify_transit()");
      assert.deepEqual(drift, [], "transit did not empty");
    } finally { await c.end(); }
  });

  test("a shop manager still cannot close their own variance", async () => {
    const id = await shortTransfer(AS.managerShop1);
    const c = await as(AS.managerShop1);
    try {
      await refused(
        () => c.query("select movement.resolve_discrepancy($1,$2)", [id, "shrinkage"]),
        "SELF_APPROVAL");
    } finally { await c.end(); }
  });

  test("and a reason is still required", async () => {
    const id = await shortTransfer(AS.admin);
    const c = await as(AS.admin);
    try {
      await refused(
        () => c.query("select movement.resolve_discrepancy($1,$2)", [id, "   "]),
        "REASON_REQUIRED");
    } finally { await c.end(); }
  });
});

// ─────────── the books are unaffected ───────────

describe("Nothing else moved", () => {
  test("stock, transit, reservations and the books all still reconcile", async () => {
    const c = await as(AS.admin);
    try {
      assert.deepEqual(await q(c, "select * from stock.verify_balances()"), []);
      assert.deepEqual(await q(c, "select * from movement.verify_transit()"), []);
      assert.deepEqual(await q(c, "select * from stock.verify_reservations()"), []);
      assert.deepEqual(await q(c, "select * from ledger.verify_balanced()"), []);
    } finally { await c.end(); }
  });
});
