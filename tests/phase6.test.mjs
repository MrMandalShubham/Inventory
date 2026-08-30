// ============================================================
// PHASE 6 — CONFIRMATION TEST
//
// The gate (docs/02 §5):
//
//   Reorder suggestions for one location reproduce a hand calculation
//   for ten products across three demand patterns — fast mover, slow
//   mover, and one with a spike inside the window.
//
// "Hand calculation" is the whole point. A planner who cannot
// reconstruct why the system suggested 240 will override it, and once
// they start overriding they stop reading. So this test does exactly
// what a planner with a calculator would do: take the two published
// numbers, apply the stated formula, and check the answer.
//
//   safety_stock  = ceil( z × stddev_daily × √lead_time )
//   reorder_point = ceil( avg_daily × lead_time ) + safety_stock
// ============================================================

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { AS, ID, connect, refused, runCheck, seed } from "./harness.mjs";

const q = (c, sql, p) => c.query(sql, p).then((r) => r.rows);
const one = async (c, sql, p) => (await q(c, sql, p))[0];

async function as(claims) {
  const c = await connect();
  await c.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(claims)]);
  // SET ROLE, not just the claims. Without it every query here runs as
  // a superuser, row-level security is bypassed, and any test that
  // asserts "this role cannot see that" passes while proving nothing.
  await c.query("set role authenticated");
  return c;
}

/** Sample standard deviation — the same thing stddev_samp computes. */
function stddevSamp(xs) {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const ss = xs.reduce((a, x) => a + (x - mean) ** 2, 0);
  return Math.sqrt(ss / (xs.length - 1));
}

const Z = 2.05;          // service_level_z, from insight.setting
const LEAD = 3;          // no receipts yet, so default_lead_time_days
const WINDOW = 28;

/** Ten products across three patterns, seeded with dated demand. */
const PATTERNS = [
  { key: "fast-a",  kind: "fast",  perDay: 20 },
  { key: "fast-b",  kind: "fast",  perDay: 12 },
  { key: "fast-c",  kind: "fast",  perDay: 35 },
  { key: "slow-a",  kind: "slow",  every: 7, qty: 1 },
  { key: "slow-b",  kind: "slow",  every: 5, qty: 2 },
  { key: "slow-c",  kind: "slow",  every: 14, qty: 3 },
  { key: "spike-a", kind: "spike", onDay: 10, qty: 100 },
  { key: "spike-b", kind: "spike", onDay: 20, qty: 250 },
  { key: "spike-c", kind: "spike", onDay: 4,  qty: 60 },
  { key: "flat",    kind: "fast",  perDay: 1 },
];

let ids = {};
let openDays = 0;

before(async () => {
  await seed();
  const c = await as(AS.admin);
  try {
    // Shop 1 trades every day, so open days = window days and the
    // arithmetic is checkable without a calendar in hand.
    await q(c, "update platform.location set closed_weekdays = '{}' where id = $1", [ID.locShop1]);

    for (const p of PATTERNS) {
      const id = (await one(c,
        `insert into catalog.product (name, base_uom_id)
         values ($1, (select id from catalog.uom where code='PCS')) returning id`,
        [`Pattern ${p.key}`])).id;
      ids[p.key] = id;

      // Opening stock, dated before the window so it is not demand.
      await q(c,
        `select stock.post_movement($1,$2,$3,'OPENING',null,'seed',null,null,
                                    now() - interval '40 days')`,
        [id, ID.locShop1, 5000]);

      // Demand, dated day by day inside the window.
      for (let d = WINDOW; d >= 1; d--) {
        let qty = 0;
        if (p.kind === "fast") qty = p.perDay;
        else if (p.kind === "slow") qty = d % p.every === 0 ? p.qty : 0;
        else if (p.kind === "spike") qty = d === p.onDay ? p.qty : 0;
        if (qty === 0) continue;

        await q(c,
          `select stock.post_movement($1,$2,$3,'ISSUE',null,'demand',null,null,
                                      (now() - make_interval(days => $4))::date + interval '12 hours')`,
          [id, ID.locShop1, -qty, d]);
      }
    }

    await q(c, "select insight.refresh_metrics()");
    openDays = (await one(c,
      `select insight.open_days($1,
              (now() - interval '28 days')::date,
              (now() - interval '1 day')::date) as n`, [ID.locShop1])).n;
  } finally { await c.end(); }
});

// ─────────────────────── CI guards ───────────────────────

describe("CI checks after insight", () => {
  test("every new table has RLS and a policy", async () => {
    const v = await runCheck("rls-coverage");
    assert.deepEqual(v, [], v.map((x) => `  ${x.schema_name}.${x.table_name}: ${x.violation}`).join("\n"));
  });

  test("the definer surface is still fully scoped", async () => {
    const v = await runCheck("definer-scope");
    assert.deepEqual(v, [], v.map((x) => `  ${x.schema_name}.${x.function_name}`).join("\n"));
  });
});

// ═══════════════════════ THE GATE ═══════════════════════

describe("THE GATE — ten products reproduce a hand calculation", () => {
  test("the window really is 28 open days", async () => {
    assert.equal(openDays, WINDOW,
      "Shop 1 was set to trade every day, so open days must equal window days");
  });

  test("lead time falls back to the default until six receipts exist", async () => {
    const c = await as(AS.admin);
    try {
      const lt = (await one(c, "select insight.lead_time_days($1) as n", [ID.locShop1])).n;
      assert.equal(Number(lt), LEAD, "no receipts yet, so the default should apply");
    } finally { await c.end(); }
  });

  for (const p of PATTERNS) {
    test(`${p.key} (${p.kind}) — every published number checks out by hand`, async () => {
      const c = await as(AS.admin);
      try {
        const m = await one(c,
          `select demand_units, open_days, avg_daily, stddev_daily, lead_time_days,
                  safety_stock, reorder_point
             from insight.product_metric
            where product_id = $1 and location_id = $2`, [ids[p.key], ID.locShop1]);

        assert.ok(m, `${p.key} has no metric row`);

        // Rebuild the daily series exactly as it was seeded.
        const days = [];
        for (let d = WINDOW; d >= 1; d--) {
          if (p.kind === "fast") days.push(p.perDay);
          else if (p.kind === "slow") days.push(d % p.every === 0 ? p.qty : 0);
          else days.push(d === p.onDay ? p.qty : 0);
        }
        const total = days.reduce((a, b) => a + b, 0);

        // 1. Demand and the divisor.
        assert.equal(m.demand_units, total, "demand over the window");
        assert.equal(m.open_days, WINDOW, "the divisor must be OPEN days");

        // 2. Sell-through = demand ÷ open days.
        assert.ok(Math.abs(Number(m.avg_daily) - total / WINDOW) < 0.0001,
          `avg_daily ${m.avg_daily} ≠ ${total}/${WINDOW}`);

        // 3. Variability across open days, zeros included.
        assert.ok(Math.abs(Number(m.stddev_daily) - stddevSamp(days)) < 0.0001,
          `stddev ${m.stddev_daily} ≠ ${stddevSamp(days).toFixed(4)}`);

        // 4. Now the planner's calculator, on the system's own
        //    published figures — which is exactly the gate.
        const expectedSafety = Math.ceil(Z * Number(m.stddev_daily) * Math.sqrt(LEAD));
        const expectedReorder =
          Math.ceil(Number(m.avg_daily) * LEAD) + expectedSafety;

        assert.equal(m.safety_stock, expectedSafety,
          `safety = ceil(${Z} × ${m.stddev_daily} × √${LEAD})`);
        assert.equal(m.reorder_point, expectedReorder,
          `reorder = ceil(${m.avg_daily} × ${LEAD}) + ${expectedSafety}`);
      } finally { await c.end(); }
    });
  }

  test("a spiky product carries more safety stock than a steady one at the same average", async () => {
    const c = await as(AS.admin);
    try {
      // spike-a: 100 units once in 28 days ≈ 3.57/day.
      // A steady product at the same average would carry none.
      const spike = await one(c,
        `select avg_daily, stddev_daily, safety_stock from insight.product_metric
          where product_id = $1 and location_id = $2`, [ids["spike-a"], ID.locShop1]);
      const flat = await one(c,
        `select avg_daily, stddev_daily, safety_stock from insight.product_metric
          where product_id = $1 and location_id = $2`, [ids["fast-a"], ID.locShop1]);

      assert.equal(Number(flat.stddev_daily), 0, "a constant seller has no variability");
      assert.equal(flat.safety_stock, 0, "and therefore needs no buffer");
      assert.ok(spike.safety_stock > 0,
        "a product that sells in one burst must carry a buffer — this is the whole point of variance");
    } finally { await c.end(); }
  });
});

// ─────────── the mistake the divisor exists to avoid ───────────

describe("Open days, not calendar days", () => {
  test("the divisor is open days — dividing by calendar days understates demand", async () => {
    const c = await as(AS.admin);
    try {
      const pid = (await one(c,
        `insert into catalog.product (name, base_uom_id)
         values ('Closure Test', (select id from catalog.uom where code='PCS')) returning id`)).id;

      // Shop 2 trades six days a week.
      await q(c, "update platform.location set closed_weekdays = '{7}' where id = $1", [ID.locShop2]);
      await q(c, `select stock.post_movement($1,$2,2000,'OPENING',null,'seed',null,null,
                                              now() - interval '40 days')`, [pid, ID.locShop2]);

      // Sell 10 a day on the days it is actually open. Asking Postgres
      // which days those are avoids a timezone disagreement between the
      // test and the database about where a day starts.
      const openDates = await q(c,
        `select d::date as day
           from generate_series((now() - interval '28 days')::date,
                                (now() - interval '1 day')::date, interval '1 day') d
          where extract(isodow from d) <> 7`);

      for (const row of openDates) {
        await q(c, `select stock.post_movement($1,$2,-10,'ISSUE',null,'demand',null,null,
                     $3::date + interval '12 hours')`, [pid, ID.locShop2, row.day]);
      }

      await q(c, "select insight.refresh_metrics()");

      const m = await one(c,
        `select open_days, demand_units, avg_daily, reorder_point
           from insight.product_metric where product_id=$1 and location_id=$2`,
        [pid, ID.locShop2]);

      assert.ok(m.open_days < WINDOW, "a Sunday-closed shop has fewer open days than the window");
      assert.equal(m.demand_units, m.open_days * 10);

      // The true rate.
      assert.ok(Math.abs(Number(m.avg_daily) - 10) < 0.0001,
        `avg_daily should be 10/day, got ${m.avg_daily}`);

      // What dividing by calendar days would have produced instead.
      const naive = m.demand_units / WINDOW;
      assert.ok(Number(m.avg_daily) > naive,
        `calendar-day averaging would have said ${naive.toFixed(4)} — a reorder point ` +
        `too low, quietly, in the products that sell best`);
    } finally { await c.end(); }
  });
});

// ─────────────────── suggestions ───────────────────

describe("Replenishment suggestions", () => {
  test("a line below its reorder point is suggested, sized to last past the next run", async () => {
    const c = await as(AS.admin);
    try {
      // Draw fast-a down below its reorder point.
      const m0 = await one(c,
        `select reorder_point, on_hand from insight.product_metric
          where product_id=$1 and location_id=$2`, [ids["fast-a"], ID.locShop1]);

      await q(c, "select stock.post_movement($1,$2,$3,'ISSUE',null,'drawdown')",
        [ids["fast-a"], ID.locShop1, -(m0.on_hand - Math.floor(m0.reorder_point / 2))]);
      await q(c, "select insight.refresh_metrics()");

      const s = await one(c,
        `select * from insight.suggestions($1) where product_id = $2`,
        [ID.locShop1, ids["fast-a"]]);

      assert.ok(s, "a line below its reorder point should be suggested");

      const m = await one(c,
        `select avg_daily, reorder_point, on_hand, in_transit, on_order
           from insight.product_metric where product_id=$1 and location_id=$2`,
        [ids["fast-a"], ID.locShop1]);
      const review = Number((await one(c,
        "select insight.setting('review_period_days') as v")).v);

      const expected = Math.max(
        m.reorder_point + Math.ceil(Number(m.avg_daily) * review)
          - m.on_hand - m.in_transit - m.on_order, 0);

      assert.equal(s.suggested_qty, expected,
        `suggested = reorder(${m.reorder_point}) + ceil(${m.avg_daily}×${review}) − on_hand(${m.on_hand}) − transit − order`);
    } finally { await c.end(); }
  });

  test("stock already on the way is subtracted — nobody orders the same pallet twice", async () => {
    const c = await as(AS.admin);
    try {
      const before = await one(c,
        `select * from insight.suggestions($1) where product_id = $2`,
        [ID.locShop1, ids["fast-a"]]);

      // Put some on the road toward Shop 1.
      const t = (await one(c,
        `select movement.create_movement('TRANSFER',$1,$2,null,$3::jsonb,'top up') as id`,
        [ID.locHub, ID.locShop1,
         JSON.stringify([{ product_id: ids["fast-a"], qty: 50 }])])).id;

      // The raiser cannot approve their own, so switch identity.
      const c2 = await as(AS.planner);
      try { await q(c2, "select movement.approve_movement($1)", [t]); }
      finally { await c2.end(); }

      await q(c, `select stock.post_movement($1,$2,500,'OPENING',null,'hub stock')`,
        [ids["fast-a"], ID.locHub]);
      await q(c, "select movement.dispatch_movement($1)", [t]);
      await q(c, "select insight.refresh_metrics()");

      const after = await one(c,
        `select * from insight.suggestions($1) where product_id = $2`,
        [ID.locShop1, ids["fast-a"]]);

      if (after) {
        assert.ok(after.suggested_qty < before.suggested_qty,
          "50 units in transit did not reduce the suggestion");
      }
      // Disappearing entirely is also correct — it means the transit
      // covers the shortfall.
    } finally { await c.end(); }
  });

  test("the derivation is available line by line", async () => {
    const c = await as(AS.admin);
    try {
      const rows = await q(c, "select * from insight.explain_reorder($1,$2)",
        [ids["fast-a"], ID.locShop1]);

      const steps = rows.map((r) => r.step);
      for (const want of ["Open days", "Sell-through", "Lead time",
                          "Safety stock", "REORDER POINT", "In transit", "SUGGESTED"]) {
        assert.ok(steps.includes(want), `the explanation is missing "${want}"`);
      }

      const rp = rows.find((r) => r.step === "REORDER POINT");
      assert.match(rp.detail, /ceil\(.+ × .+\) \+ /,
        "the reorder point must show its arithmetic, not just its answer");
    } finally { await c.end(); }
  });

  test("a shop cannot see another location's suggestions", async () => {
    const c = await as(AS.managerShop1);
    try {
      const rows = await q(c, "select * from insight.suggestions($1)", [ID.locShop2]);
      assert.deepEqual(rows, [], "a Shop 1 manager read Shop 2's replenishment");
    } finally { await c.end(); }
  });

  test("explain_reorder refuses a location the caller does not hold", async () => {
    const c = await as(AS.managerShop1);
    try {
      await refused(
        () => c.query("select * from insight.explain_reorder($1,$2)",
          [ids["fast-a"], ID.locShop2]),
        "FORBIDDEN_LOCATION");
    } finally { await c.end(); }
  });
});

// ─────────────────── alerts ───────────────────

describe("Alerts", () => {
  test("an out-of-stock line raises an alert", async () => {
    const c = await as(AS.admin);
    try {
      const bal = await one(c,
        `select on_hand from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`,
        [ids["slow-a"], ID.locShop1]);
      await q(c, "select stock.post_movement($1,$2,$3,'ISSUE',null,'sold out')",
        [ids["slow-a"], ID.locShop1, -bal.on_hand]);

      await q(c, "select insight.refresh_metrics()");
      await q(c, "select * from alerting.evaluate()");

      const a = await one(c,
        `select rule_code, severity, state from alerting.alert
          where product_id=$1 and location_id=$2 and rule_code='OUT_OF_STOCK'
            and state <> 'RESOLVED'`, [ids["slow-a"], ID.locShop1]);

      assert.ok(a, "no out-of-stock alert was raised");
      assert.equal(a.severity, "ACT_NOW");
    } finally { await c.end(); }
  });

  test("evaluating twice does not duplicate it", async () => {
    const c = await as(AS.admin);
    try {
      await q(c, "select * from alerting.evaluate()");
      await q(c, "select * from alerting.evaluate()");
      const n = (await one(c,
        `select count(*)::int as n from alerting.alert
          where product_id=$1 and rule_code='OUT_OF_STOCK' and state <> 'RESOLVED'`,
        [ids["slow-a"]])).n;
      assert.equal(n, 1, "a list that grows on every run is a list nobody reads");
    } finally { await c.end(); }
  });

  test("THE PROPERTY THAT MATTERS — an alert resolves itself when the condition clears", async () => {
    const c = await as(AS.admin);
    try {
      await q(c, "select stock.post_movement($1,$2,500,'RECEIPT',null,'restocked')",
        [ids["slow-a"], ID.locShop1]);
      await q(c, "select insight.refresh_metrics()");
      await q(c, "select * from alerting.evaluate()");

      const open = await q(c,
        `select 1 from alerting.alert
          where product_id=$1 and rule_code='OUT_OF_STOCK' and state <> 'RESOLVED'`,
        [ids["slow-a"]]);
      assert.deepEqual(open, [], "the alert stayed open after the shelf was refilled");

      const closed = await one(c,
        `select state, resolution, resolved_at from alerting.alert
          where product_id=$1 and rule_code='OUT_OF_STOCK'
          order by id desc limit 1`, [ids["slow-a"]]);
      assert.equal(closed.state, "RESOLVED");
      assert.equal(closed.resolution, "condition cleared");
      assert.ok(closed.resolved_at, "the time it cleared should be recorded");
    } finally { await c.end(); }
  });

  test("acknowledging is not the same as resolving", async () => {
    const c = await as(AS.admin);
    try {
      const bal = await one(c,
        `select on_hand from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`,
        [ids["slow-b"], ID.locShop1]);
      await q(c, "select stock.post_movement($1,$2,$3,'ISSUE',null,'sold out')",
        [ids["slow-b"], ID.locShop1, -bal.on_hand]);
      await q(c, "select insight.refresh_metrics()");
      await q(c, "select * from alerting.evaluate()");

      const a = await one(c,
        `select id from alerting.alert where product_id=$1 and rule_code='OUT_OF_STOCK'
            and state <> 'RESOLVED'`, [ids["slow-b"]]);
      await q(c, "select alerting.acknowledge($1)", [a.id]);

      const after = await one(c, "select state from alerting.alert where id=$1", [a.id]);
      assert.equal(after.state, "ACKNOWLEDGED",
        "acknowledging says somebody is dealing with it — only the condition clearing resolves it");
    } finally { await c.end(); }
  });

  test("a shop manager sees only their own alerts", async () => {
    const c = await as(AS.managerShop1);
    try {
      const rows = await q(c,
        `select location_id from alerting.alert
          where state <> 'RESOLVED' and location_id is not null`);
      assert.ok(rows.every((r) => r.location_id === ID.locShop1),
        "an alert about another shop leaked");
    } finally { await c.end(); }
  });
});

// ─────────────────── still square ───────────────────

describe("After all of that", () => {
  test("balance, transit and reservations all reconcile", async () => {
    const c = await as(AS.admin);
    try {
      assert.deepEqual(await q(c, "select * from stock.verify_balances()"), []);
      assert.deepEqual(await q(c, "select * from movement.verify_transit()"), []);
      assert.deepEqual(await q(c, "select * from stock.verify_reservations()"), []);
    } finally { await c.end(); }
  });
});
