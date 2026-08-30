// ============================================================
// PHASE 2 — CONFIRMATION TEST
//
// The gate (docs/02 §5):
//
//   Drop the balance table, rebuild it from the ledger alone,
//   reproduce every number exactly — and wire that rebuild into CI.
//   Separately, a physical count that finds a variance posts an
//   adjustment with an approver and a ledger entry, and the count
//   sheet is reproducible afterwards.
//
// This is invariant 1 made testable: stock is a sum, not a number.
// ============================================================

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { AS, ID, asUser, connect, refused, runCheck, seed } from "./harness.mjs";

before(async () => { await seed(); });

const q = (c, sql, params) => c.query(sql, params).then((r) => r.rows);

// ─────────────────────── CI guards ───────────────────────

describe("CI checks after the ledger arrives", () => {
  test("every partition carries the parent's policy", async () => {
    const violations = await runCheck("rls-coverage");
    assert.deepEqual(violations, [],
      violations.map((v) => `  ${v.schema_name}.${v.table_name}: ${v.violation}`).join("\n"));
  });

  test("the definer surface is still fully scoped", async () => {
    const violations = await runCheck("definer-scope");
    assert.deepEqual(violations, [],
      violations.map((v) => `  ${v.schema_name}.${v.function_name}`).join("\n"));
  });

  test("a partition queried BY NAME still enforces the location boundary", async () => {
    // Enabling RLS on a partitioned parent does nothing for a query
    // aimed at a partition directly. This is the regression test for
    // migration 0015.
    // This month's partition specifically — an empty 2025 one would
    // read zero for everybody and the test would prove nothing.
    const partition = await asUser(AS.admin, async (c) =>
      (await q(c, "select 'ledger_' || to_char(now(),'YYYY_MM') as relname"))[0].relname);

    const asAdmin = await asUser(AS.admin, async (c) =>
      (await q(c, `select count(*)::int n from stock.${partition}`))[0].n);
    const asShop = await asUser(AS.managerShop1, async (c) =>
      (await q(c, `select count(*)::int n from stock.${partition}`))[0].n);

    assert.ok(asShop <= asAdmin, "a shop saw more than the whole system holds");
    assert.notEqual(asShop, asAdmin,
      "the shop manager read every row in the partition — RLS is not applied there");
  });
});

// ═══════════════════════ THE GATE ═══════════════════════

describe("THE GATE — the balance rebuilds from the ledger exactly", () => {
  test("post movements, destroy the projection, rebuild it, reproduce every number", async () => {
    // Ordinary activity across two locations, several reasons.
    await asUser(AS.admin, async (c) => {
      await q(c, "select stock.post_movement($1,$2, 60,'RECEIPT',null,'delivery')", [ID.productA, ID.locShop1]);
      await q(c, "select stock.post_movement($1,$2,-25,'ISSUE',null,'counter sales')", [ID.productA, ID.locShop1]);
      await q(c, "select stock.post_movement($1,$2, -4,'WASTAGE',null,'crushed')", [ID.productA, ID.locShop1]);
      await q(c, "select stock.post_movement($1,$2,-30,'TRANSFER_OUT',null,'to shop 2')", [ID.productA, ID.locShop2]);
      await q(c, "select stock.post_movement($1,$2, 12,'RETURN',null,'customer return')", [ID.productB, ID.locShop1]);
    });

    const before = await asUser(AS.admin, async (c) =>
      q(c, `select product_id, location_id, batch_id, on_hand
              from stock.balance order by product_id, location_id`));

    assert.ok(before.length >= 3, "there should be stock to rebuild");

    const rebuilt = await asUser(AS.admin, async (c) =>
      (await q(c, "select stock.rebuild_balances() as n"))[0].n);

    const after = await asUser(AS.admin, async (c) =>
      q(c, `select product_id, location_id, batch_id, on_hand
              from stock.balance order by product_id, location_id`));

    assert.equal(rebuilt, before.length, "the rebuild produced a different number of lines");
    assert.deepEqual(after, before,
      "the projection rebuilt from the ledger does not match what it replaced");
  });

  test("verify_balances reports nothing — the ongoing health check", async () => {
    const drift = await asUser(AS.admin, async (c) => q(c, "select * from stock.verify_balances()"));
    assert.deepEqual(drift, [],
      `balance and ledger disagree on ${drift.length} line(s) — this is a page, not a metric`);
  });

  test("verify_balances DOES catch drift when the projection is corrupted", async () => {
    // Negative control. A health check that has never fired is a
    // health check nobody knows works.
    const c = await connect();
    try {
      await c.query("begin");
      await c.query(`update stock.balance set on_hand = on_hand + 7
                      where id = (select id from stock.balance limit 1)`);
      const { rows } = await c.query("select * from stock.verify_balances()");
      assert.equal(rows.length, 1, "the corruption went unnoticed");
      assert.equal(rows[0].balance_says - rows[0].ledger_says, 7);
    } finally {
      await c.query("rollback").catch(() => {});
      await c.end();
    }
  });
});

// ─────────────────── append-only, enforced ───────────────────

describe("The ledger is append-only — invariant 2", () => {
  test("it cannot be updated, even by a superuser", async () => {
    const c = await connect();
    try {
      await refused(() => c.query("update stock.ledger set qty_delta = 999"), "APPEND_ONLY");
    } finally { await c.end(); }
  });

  test("it cannot be deleted from", async () => {
    const c = await connect();
    try {
      await refused(() => c.query("delete from stock.ledger"), "APPEND_ONLY");
    } finally { await c.end(); }
  });

  test("the balance is not writable by a client at all", async () => {
    await asUser(AS.admin, async (c) => {
      // No write policy exists on stock.balance. The only door is
      // post_movement(), which runs as definer.
      await refused(
        () => c.query(`insert into stock.balance (product_id, location_id, on_hand)
                       values ($1,$2,5)`, [ID.productA, ID.locHub]),
        "row-level security");
    });
  });
});

// ─────────────────── the posting contract ───────────────────

describe("post_movement — the only door", () => {
  test("refuses a location the caller does not hold", async () => {
    await asUser(AS.managerShop1, async (c) => {
      await refused(
        () => c.query("select stock.post_movement($1,$2,5,'RECEIPT')", [ID.productA, ID.locShop2]),
        "FORBIDDEN_LOCATION");
    });
  });

  test("refuses a reason the caller's role may not post", async () => {
    await asUser(AS.operatorShop1, async (c) => {
      await refused(
        () => c.query("select stock.post_movement($1,$2,5,'COUNT')", [ID.productA, ID.locShop1]),
        "FORBIDDEN_ROLE");
    });
  });

  test("refuses a movement in the wrong direction for its reason", async () => {
    await asUser(AS.admin, async (c) => {
      await refused(
        () => c.query("select stock.post_movement($1,$2,5,'WASTAGE')", [ID.productA, ID.locShop1]),
        "WRONG_DIRECTION", c);
      await refused(
        () => c.query("select stock.post_movement($1,$2,-5,'RECEIPT')", [ID.productA, ID.locShop1]),
        "WRONG_DIRECTION", c);
    });
  });

  test("refuses an unknown reason", async () => {
    await asUser(AS.admin, async (c) => {
      await refused(
        () => c.query("select stock.post_movement($1,$2,5,'SHRINKAGE')", [ID.productA, ID.locShop1]),
        "UNKNOWN_REASON");
    });
  });

  test("a refused movement writes no ledger row and moves no stock", async () => {
    const state = await asUser(AS.admin, async (c) => {
      const beforeLedger = (await q(c, "select count(*)::int n from stock.ledger"))[0].n;
      const beforeStock = (await q(c,
        `select on_hand from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`,
        [ID.productA, ID.locShop1]))[0].on_hand;

      await refused(
        () => c.query("select stock.post_movement($1,$2,-99999,'ISSUE')", [ID.productA, ID.locShop1]),
        "violates check constraint");

      return { beforeLedger, beforeStock };
    });

    const after = await asUser(AS.admin, async (c) => ({
      ledger: (await q(c, "select count(*)::int n from stock.ledger"))[0].n,
      stock: (await q(c,
        `select on_hand from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`,
        [ID.productA, ID.locShop1]))[0].on_hand,
    }));

    assert.equal(after.ledger, state.beforeLedger, "a failed post left a ledger row behind");
    assert.equal(after.stock, state.beforeStock, "a failed post moved stock");
  });

  test("a batch-tracked product must name its lot", async () => {
    const productId = await asUser(AS.admin, async (c) => {
      const { rows } = await c.query(
        `insert into catalog.product (name, base_uom_id, tracking_mode, shelf_life_days)
         values ('Perishable Test', (select id from catalog.uom where code='G'), 'BATCH', 5)
         returning id`);
      return rows[0].id;
    });

    // Committed separately so it survives asUser's rollback.
    const c = await connect();
    try {
      const { rows } = await c.query(
        `insert into catalog.product (name, base_uom_id, tracking_mode, shelf_life_days)
         values ('Perishable Committed', (select id from catalog.uom where code='G'), 'BATCH', 5)
         returning id`);
      const pid = rows[0].id;

      await asUser(AS.admin, async (c2) => {
        await refused(
          () => c2.query("select stock.post_movement($1,$2,10,'RECEIPT')", [pid, ID.locShop1]),
          "BATCH_REQUIRED");
      });

      // With a lot named, it lands.
      await asUser(AS.admin, async (c2) => {
        const batch = (await q(c2,
          `insert into stock.batch (product_id, lot_no, expiry_date)
           values ($1,'LOT-A', current_date + 4) returning id`, [pid]))[0].id;
        const id = (await q(c2,
          "select stock.post_movement($1,$2,10,'RECEIPT',$3) as id", [pid, ID.locShop1, batch]))[0].id;
        assert.ok(Number(id) > 0, "a batch-tracked receipt with a lot should succeed");
      });
    } finally {
      await c.end();
    }
    assert.ok(productId);
  });
});

// ─────────────────── idempotency ───────────────────

describe("Idempotency — a retry must not take a second unit", () => {
  test("the same key returns the original ledger id and moves nothing", async () => {
    const c = await connect();
    try {
      await c.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(AS.admin)]);

      const key = "retry-" + Date.now();
      const before = (await q(c,
        `select on_hand from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`,
        [ID.productA, ID.locShop1]))[0].on_hand;

      const first = (await q(c,
        `select stock.post_movement($1,$2,-3,'ISSUE',null,'sale',null,null,now(),$3) as id`,
        [ID.productA, ID.locShop1, key]))[0].id;

      const afterFirst = (await q(c,
        `select on_hand from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`,
        [ID.productA, ID.locShop1]))[0].on_hand;

      // The client times out and retries with the same key.
      const second = (await q(c,
        `select stock.post_movement($1,$2,-3,'ISSUE',null,'sale',null,null,now(),$3) as id`,
        [ID.productA, ID.locShop1, key]))[0].id;

      const afterSecond = (await q(c,
        `select on_hand from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`,
        [ID.productA, ID.locShop1]))[0].on_hand;

      assert.equal(second, first, "the retry created a second ledger entry");
      assert.equal(afterFirst, before - 3, "the first call should have moved 3");
      assert.equal(afterSecond, afterFirst, "the retry took a second unit off the shelf");
    } finally { await c.end(); }
  });
});

// ─────────────────── point in time ───────────────────

describe("Point-in-time reconstruction", () => {
  test("the position on a past date is recoverable", async () => {
    const c = await connect();
    try {
      await c.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(AS.admin)]);

      const cut = (await q(c, "select now() as t"))[0].t;
      const at = (await q(c,
        `select on_hand from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`,
        [ID.productA, ID.locShop1]))[0].on_hand;

      await q(c, "select stock.post_movement($1,$2,50,'RECEIPT',null,'later delivery')",
        [ID.productA, ID.locShop1]);

      const asOf = (await q(c,
        `select on_hand from stock.balance_as_of($1)
          where product_id=$2 and location_id=$3 and batch_id is null`,
        [cut, ID.productA, ID.locShop1]))[0].on_hand;

      const now = (await q(c,
        `select on_hand from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`,
        [ID.productA, ID.locShop1]))[0].on_hand;

      assert.equal(asOf, at, "the historical position was not reproduced");
      assert.equal(now, at + 50, "the current position is wrong");
    } finally { await c.end(); }
  });
});

// ─────────────────── cycle counting ───────────────────

describe("Cycle counting — blind, and approved by someone else", () => {
  test("an operator cannot read the expected quantity", async () => {
    const sheet = await asUser(AS.managerShop1, async (c) =>
      (await q(c, "select stock.open_count_sheet($1,'monthly') as id", [ID.locShop1]))[0].id);
    assert.ok(sheet);

    // Sheet above rolled back; make a committed one for the operator.
    const c = await connect();
    let committed;
    try {
      await c.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(AS.managerShop1)]);
      committed = (await q(c, "select stock.open_count_sheet($1,'monthly') as id", [ID.locShop1]))[0].id;
    } finally { await c.end(); }

    await asUser(AS.operatorShop1, async (c2) => {
      // Direct read: no policy grants operators the raw lines.
      const raw = await q(c2, "select * from stock.count_line where count_sheet_id = $1", [committed]);
      assert.equal(raw.length, 0, "an operator read the expected quantities directly");

      // The blind function is their only route, and it has no
      // expected column at all.
      const blind = await q(c2, "select * from stock.count_sheet_lines_blind($1)", [committed]);
      assert.ok(blind.length > 0, "the blind sheet should list lines to count");
      assert.ok(!("expected_qty" in blind[0]),
        "the blind sheet leaked the expected quantity — the count now measures nothing");
    });
  });

  test("a variance needs a different person to approve it, and posts to the ledger", async () => {
    const c = await connect();
    try {
      // Meena opens and counts.
      await c.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(AS.managerShop1)]);
      const sheet = (await q(c,
        "select stock.open_count_sheet($1,'spot check',$2) as id",
        [ID.locShop1, [ID.productA]]))[0].id;

      const line = (await q(c, "select * from stock.count_sheet_lines_blind($1)", [sheet]))[0];
      const expected = (await q(c,
        "select expected_qty from stock.count_line where id = $1", [line.line_id]))[0].expected_qty;

      // Counts three short of what the system believes.
      await q(c, "select stock.record_count($1,$2)", [line.line_id, expected - 3]);
      const variances = (await q(c, "select stock.submit_count_sheet($1) as n", [sheet]))[0].n;
      assert.equal(variances, 1, "one line should show a variance");

      // Meena tries to approve her own count.
      await refused(
        () => c.query("select stock.approve_count_sheet($1)", [sheet]),
        "SELF_APPROVAL");

      // Someone else approves.
      const ledgerBefore = (await q(c, "select count(*)::int n from stock.ledger"))[0].n;
      await c.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(AS.admin)]);
      const posted = (await q(c, "select stock.approve_count_sheet($1) as n", [sheet]))[0].n;

      assert.equal(posted, 1, "the variance should have posted one ledger entry");

      const entry = (await q(c,
        `select qty_delta, reason_code, actor_id from stock.ledger
          order by id desc limit 1`))[0];
      assert.equal(entry.qty_delta, -3, "the ledger entry does not match the variance");
      assert.equal(entry.reason_code, "COUNT");
      assert.equal(entry.actor_id, AS.admin.sub, "the approver must be recorded as the actor");

      const ledgerAfter = (await q(c, "select count(*)::int n from stock.ledger"))[0].n;
      assert.equal(ledgerAfter, ledgerBefore + 1);

      // And the sheet is still reproducible afterwards.
      const sheetAfter = (await q(c,
        `select status, counted_by, approved_by from stock.count_sheet where id = $1`, [sheet]))[0];
      assert.equal(sheetAfter.status, "POSTED");
      assert.notEqual(sheetAfter.counted_by, sheetAfter.approved_by);
    } finally { await c.end(); }
  });

  test("a sheet cannot be submitted while lines are uncounted", async () => {
    const c = await connect();
    try {
      await c.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(AS.managerShop1)]);
      const sheet = (await q(c, "select stock.open_count_sheet($1,'incomplete') as id", [ID.locShop1]))[0].id;
      await refused(
        () => c.query("select stock.submit_count_sheet($1)", [sheet]),
        "INCOMPLETE_COUNT");
    } finally { await c.end(); }
  });

  test("after all that, balance and ledger still agree", async () => {
    const drift = await asUser(AS.admin, async (c) => q(c, "select * from stock.verify_balances()"));
    assert.deepEqual(drift, [], "counting broke the invariant it exists to protect");
  });
});
