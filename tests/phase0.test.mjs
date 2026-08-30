// ============================================================
// PHASE 0 — CONFIRMATION TEST
//
// The gate (docs/02 §4):
//
//   A shop manager cannot read or write another location's stock,
//   and an operator cannot post an adjustment — proven by a test
//   that tries both, THROUGH EVERY SECURITY DEFINER FUNCTION, not
//   merely through the normal query path. A query over pg_policies
//   fails the build if any stock table is missing a policy.
//
// Positive controls are included deliberately. A suite where
// everything is denied would pass every negative test while the
// product did nothing — so each boundary is tested from both sides.
// ============================================================

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { AS, ID, asUser, connect, refused, runCheck, seed } from "./harness.mjs";

before(async () => { await seed(); });

// ─────────────────────── CI checks ───────────────────────

describe("CI checks", () => {
  test("every table in platform and stock has RLS enabled and a policy", async () => {
    const violations = await runCheck("rls-coverage");
    assert.deepEqual(
      violations, [],
      `RLS coverage violations:\n${violations.map((v) => `  ${v.schema_name}.${v.table_name}: ${v.violation}`).join("\n")}`,
    );
  });

  test("every SECURITY DEFINER function checks scope or declares an exemption", async () => {
    const violations = await runCheck("definer-scope");
    assert.deepEqual(
      violations, [],
      `SECURITY DEFINER functions without a scope check:\n${violations.map((v) => `  ${v.schema_name}.${v.function_name}(${v.args})`).join("\n")}`,
    );
  });
});

// ──────────────── the location boundary, normal path ────────────────

describe("Location boundary — through row-level security", () => {
  test("shop manager sees only their own location's stock", async () => {
    const rows = await asUser(AS.managerShop1, async (c) =>
      (await c.query("select location_id, on_hand from stock.balance")).rows);

    assert.equal(rows.length, 2, "Shop 1 holds two products");
    assert.ok(
      rows.every((r) => r.location_id === ID.locShop1),
      "a row from another location leaked through the policy",
    );
  });

  test("the other manager sees a different set — the boundary is real, not empty", async () => {
    const rows = await asUser(AS.managerShop2, async (c) =>
      (await c.query("select location_id, on_hand from stock.balance")).rows);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].location_id, ID.locShop2);
    assert.equal(rows[0].on_hand, 250);
  });

  test("planner sees every location — the global-scope exception works", async () => {
    const rows = await asUser(AS.planner, async (c) =>
      (await c.query("select location_id from stock.balance")).rows);

    assert.equal(rows.length, 3, "planner should see all three stock lines");
  });

  test("shop manager cannot UPDATE another location's stock directly", async () => {
    const changed = await asUser(AS.managerShop1, async (c) =>
      (await c.query(
        "update stock.balance set on_hand = 9999 where location_id = $1 returning id",
        [ID.locShop2],
      )).rowCount);

    // RLS makes the row invisible, so the UPDATE matches nothing.
    assert.equal(changed, 0, "an update reached another location's row");
  });
});

// ──────── the location boundary, through SECURITY DEFINER ────────
//
// This is the part that matters. RLS does not apply inside these
// functions — if the body forgets its check, the boundary is gone
// and nothing reports it.

describe("Location boundary — through SECURITY DEFINER functions", () => {
  test("get_balance refuses a location the caller does not hold", async () => {
    await asUser(AS.managerShop1, async (c) => {
      await refused(
        () => c.query("select stock.get_balance($1,$2)", [ID.productA, ID.locShop2]),
        "FORBIDDEN_LOCATION",
      );
    });
  });

  test("get_balance allows the caller's own location", async () => {
    const value = await asUser(AS.managerShop1, async (c) =>
      (await c.query("select stock.get_balance($1,$2) as v", [ID.productA, ID.locShop1])).rows[0].v);

    assert.equal(value, 100, "positive control: the function must work where it is allowed");
  });

  test("post_adjustment refuses another location — THE GATE", async () => {
    await asUser(AS.managerShop1, async (c) => {
      await refused(
        () => c.query("select stock.post_adjustment($1,$2,$3,$4)",
          [ID.productA, ID.locShop2, -50, "stock count variance"]),
        "FORBIDDEN_LOCATION",
      );
    });

    // And the stock at Shop 2 is untouched.
    const after = await asUser(AS.planner, async (c) =>
      (await c.query("select on_hand from stock.balance where location_id = $1 and product_id = $2",
        [ID.locShop2, ID.productA])).rows[0].on_hand);

    assert.equal(after, 250, "Shop 2 stock changed despite the refusal");
  });

  test("post_adjustment allows the caller's own location", async () => {
    const after = await asUser(AS.managerShop1, async (c) =>
      (await c.query("select stock.post_adjustment($1,$2,$3,$4) as v",
        [ID.productA, ID.locShop1, -6, "damaged in store"])).rows[0].v);

    assert.equal(after, 94, "positive control: a legitimate adjustment must work");
  });

  test("ensure_balance refuses another location", async () => {
    await asUser(AS.managerShop1, async (c) => {
      await refused(
        () => c.query("select stock.ensure_balance($1,$2,$3)", [ID.productB, ID.locShop2, 10]),
        "FORBIDDEN_LOCATION",
      );
    });
  });
});

// ─────────────────── separation of duties ───────────────────

describe("Roles — separation of duties", () => {
  test("an operator cannot post an adjustment at their OWN location — THE GATE", async () => {
    await asUser(AS.operatorShop1, async (c) => {
      await refused(
        () => c.query("select stock.post_adjustment($1,$2,$3,$4)",
          [ID.productA, ID.locShop1, -5, "shrinkage"]),
        "FORBIDDEN_ROLE",
      );
    });
  });

  test("an operator cannot post an adjustment anywhere else either", async () => {
    await asUser(AS.operatorShop1, async (c) => {
      await refused(
        () => c.query("select stock.post_adjustment($1,$2,$3,$4)",
          [ID.productA, ID.locShop2, -5, "shrinkage"]),
        "FORBIDDEN",
      );
    });
  });

  test("an operator can still read their own location's stock", async () => {
    const value = await asUser(AS.operatorShop1, async (c) =>
      (await c.query("select stock.get_balance($1,$2) as v", [ID.productA, ID.locShop1])).rows[0].v);

    assert.equal(value, 100, "positive control: operators must be able to see their shelf");
  });

  test("an adjustment without a reason is refused", async () => {
    await asUser(AS.managerShop1, async (c) => {
      await refused(
        () => c.query("select stock.post_adjustment($1,$2,$3,$4)",
          [ID.productA, ID.locShop1, -5, "   "]),
        "REASON_REQUIRED",
      );
    });
  });
});

// ─────────────────── invariant 7, in the database ───────────────────

describe("Constraints — invariant 7", () => {
  test("stock cannot go negative, even via the definer function", async () => {
    // Which constraint fires is not the claim — that the database
    // refuses it is. Driving on_hand below zero also breaks
    // claims_within_stock (0 <= negative is false), and Postgres
    // reports whichever it evaluates first. Asserting a specific
    // name here would make the test brittle about something the
    // system is entitled to change.
    await asUser(AS.planner, async (c) => {
      await refused(
        () => c.query("select stock.post_adjustment($1,$2,$3,$4)",
          [ID.productA, ID.locShop1, -500, "impossible write-off"]),
        "violates check constraint",
      );
    });

    const after = await asUser(AS.planner, async (c) =>
      (await c.query("select on_hand from stock.balance where product_id = $1 and location_id = $2",
        [ID.productA, ID.locShop1])).rows[0].on_hand);

    assert.equal(after, 100, "the refused write must leave the shelf untouched");
  });

  test("claims on stock cannot exceed what is on hand", async () => {
    const c = await connect();
    try {
      await refused(
        () => c.query(
          "update stock.balance set reserved = 500 where product_id = $1 and location_id = $2",
          [ID.productA, ID.locShop1]),
        "claims_within_stock",
      );
    } finally {
      await c.end();
    }
  });
});

// ─────────────────── gapless numbering ───────────────────

describe("Gapless numbering", () => {
  test("consecutive calls produce consecutive numbers", async () => {
    const c = await connect();
    try {
      const seen = [];
      for (let i = 0; i < 5; i++) {
        const { rows } = await c.query("select platform.next_number('test_seq','TST') as n");
        seen.push(Number(rows[0].n.split("-").at(-1)));
      }
      assert.deepEqual(seen, [1, 2, 3, 4, 5], `got ${seen.join(",")}`);
    } finally {
      await c.end();
    }
  });

  test("a rolled-back transaction does NOT consume a number", async () => {
    // This is the whole reason for a counter table rather than a
    // SEQUENCE. A sequence would leak 6 here and leave a permanent
    // hole an auditor has to ask about.
    const a = await connect();
    const b = await connect();
    try {
      await a.query("begin");
      const inside = await a.query("select platform.next_number('test_seq','TST') as n");
      assert.equal(Number(inside.rows[0].n.split("-").at(-1)), 6, "should take 6 inside the txn");
      await a.query("rollback");

      const after = await b.query("select platform.next_number('test_seq','TST') as n");
      assert.equal(
        Number(after.rows[0].n.split("-").at(-1)), 6,
        "the rolled-back number was leaked — this is exactly what a SEQUENCE would do",
      );
    } finally {
      await a.end();
      await b.end();
    }
  });

  test("the formatted number is human-readable and zero-padded", async () => {
    const c = await connect();
    try {
      const { rows } = await c.query("select platform.next_number('fmt_seq','TRF') as n");
      assert.match(rows[0].n, /^TRF-\d{4}-000001$/, `got ${rows[0].n}`);
    } finally {
      await c.end();
    }
  });
});

// ─────────────────── the audit trail ───────────────────

describe("Audit log — invariant 2", () => {
  test("a role change is recorded with the old and new value", async () => {
    const c = await connect();
    try {
      await c.query("begin");
      await c.query("select set_config('request.jwt.claims', $1, true)",
        [JSON.stringify(AS.admin)]);
      await c.query("update platform.app_user set role = 'planner' where id = $1", [ID.userMgr2]);

      const { rows } = await c.query(
        `select field, old_value, new_value, actor_id
           from platform.audit_log
          where entity_table = 'app_user' and entity_id = $1 and action = 'UPDATE'`,
        [ID.userMgr2]);

      assert.equal(rows.length, 1, "exactly one field changed, so exactly one row");
      assert.equal(rows[0].field, "role");
      assert.equal(rows[0].old_value, "shop_manager");
      assert.equal(rows[0].new_value, "planner");
      assert.equal(rows[0].actor_id, ID.userAdmin, "the change must be attributable");
      await c.query("rollback");
    } finally {
      await c.end();
    }
  });

  test("the audit log cannot be updated — not even by a superuser", async () => {
    const c = await connect();
    try {
      await refused(
        () => c.query("update platform.audit_log set new_value = 'tampered'"),
        "APPEND_ONLY",
      );
    } finally {
      await c.end();
    }
  });

  test("the audit log cannot be deleted from", async () => {
    const c = await connect();
    try {
      await refused(() => c.query("delete from platform.audit_log"), "APPEND_ONLY");
    } finally {
      await c.end();
    }
  });
});
