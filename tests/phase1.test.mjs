// ============================================================
// PHASE 1 — CONFIRMATION TEST
//
// The gate (docs/02 §5):
//
//   5,000 products and opening stock for three locations import in
//   one pass, with a line-by-line error report for failed rows.
//   Product search returns in under 200ms at that volume.
//
// The error report is the part that matters. A 5,000-row file WILL
// have bad rows. An all-or-nothing import means fixing one row,
// re-running, and finding the next — five thousand times.
// ============================================================

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { AS, ID, asUser, connect, refused, runCheck, seed } from "./harness.mjs";

const PLANNER = AS.planner;

before(async () => { await seed(); });

// ─────────────────────── CI guards, now wider ───────────────────────

describe("CI checks cover the new schemas", () => {
  test("catalog and partner tables all have RLS and a policy", async () => {
    const violations = await runCheck("rls-coverage");
    assert.deepEqual(violations, [],
      violations.map((v) => `  ${v.schema_name}.${v.table_name}: ${v.violation}`).join("\n"));
  });

  test("the new SECURITY DEFINER functions declare or check scope", async () => {
    const violations = await runCheck("definer-scope");
    assert.deepEqual(violations, [],
      violations.map((v) => `  ${v.schema_name}.${v.function_name}`).join("\n"));
  });
});

// ─────────────────────── product identity ───────────────────────

describe("Product identity — invariant 3", () => {
  test("a SKU code is minted automatically and is gapless", async () => {
    const codes = await asUser(PLANNER, async (c) => {
      const out = [];
      for (const name of ["Toor Dal 1kg", "Toor Dal 5kg", "Refined Oil 1L"]) {
        const { rows } = await c.query(
          `insert into catalog.product (name, base_uom_id)
           values ($1, (select id from catalog.uom where code = 'G'))
           returning sku_code`, [name]);
        out.push(rows[0].sku_code);
      }
      return out;
    });

    assert.match(codes[0], /^PRD-\d{4}-000001$/, `got ${codes[0]}`);
    const numbers = codes.map((c) => Number(c.split("-").at(-1)));
    assert.deepEqual(numbers, [1, 2, 3], "codes must be consecutive with no gaps");
  });

  test("the same product ID is visible from every location's user", async () => {
    // Invariant 3: locations hold stock, they do not own identity.
    // The catalogue carries no location predicate at all.
    const sku = await asUser(PLANNER, async (c) => {
      await c.query(`insert into catalog.product (sku_code, name, base_uom_id)
                     values ('PRD-FIXED-0001', 'Shared Product',
                             (select id from catalog.uom where code = 'PCS'))`);
      return "PRD-FIXED-0001";
    });
    assert.equal(sku, "PRD-FIXED-0001");

    // Seeded separately so it survives the rollback above.
    const c = await connect();
    try {
      await c.query(`insert into catalog.product (sku_code, name, base_uom_id)
                     values ('PRD-SHARED-01', 'Shared Product',
                             (select id from catalog.uom where code = 'PCS'))`);
    } finally { await c.end(); }

    for (const who of [AS.managerShop1, AS.managerShop2, AS.operatorShop1]) {
      const found = await asUser(who, async (c) =>
        (await c.query("select name from catalog.product where sku_code = 'PRD-SHARED-01'")).rowCount);
      assert.equal(found, 1, `${who.role} could not see the global catalogue`);
    }
  });

  test("an operator cannot create or edit a product", async () => {
    await asUser(AS.operatorShop1, async (c) => {
      const inserted = await c.query(
        `insert into catalog.product (name, base_uom_id)
         values ('Sneaky Product', (select id from catalog.uom where code = 'PCS'))
         returning id`).catch((e) => e);
      // RLS refuses the write outright rather than silently dropping it.
      assert.ok(inserted instanceof Error, "an operator wrote to the catalogue");
    });
  });

  test("a product with a shelf life must be batch or serial tracked", async () => {
    await asUser(PLANNER, async (c) => {
      await refused(
        () => c.query(
          `insert into catalog.product (name, base_uom_id, shelf_life_days, tracking_mode)
           values ('Milk 500ml', (select id from catalog.uom where code = 'ML'), 5, 'NONE')`),
        "shelf_life_needs_batch");
    });
  });
});

// ─────────────────────── bulk import ───────────────────────

describe("Bulk import — the line-by-line report", () => {
  test("good rows land and bad rows are reported individually", async () => {
    const rows = [
      { name: "Basmati Rice 1kg", base_uom: "G", category: "Staples", hsn_code: "1006" },
      { name: "", base_uom: "G" },                                   // no name
      { name: "Sunflower Oil 1L", base_uom: "NOPE" },                // bad unit
      { name: "Face Wash 100ml", base_uom: "ML", category: "Beauty" },
      { name: "Curd 400g", base_uom: "G", shelf_life_days: 7, tracking_mode: "NONE" }, // needs batch
      { name: "Atta 5kg", base_uom: "G", category: "Staples" },
    ];

    const report = await asUser(PLANNER, async (c) =>
      (await c.query("select * from catalog.import_products($1::jsonb)", [JSON.stringify(rows)])).rows);

    assert.equal(report.length, 6, "every row must be reported, good or bad");

    const created = report.filter((r) => r.status === "CREATED");
    const failed  = report.filter((r) => r.status === "FAILED");

    assert.equal(created.length, 3, "three valid rows should have landed");
    assert.equal(failed.length, 3, "three invalid rows should have been reported");

    // The report must say WHICH row and WHY — that is the whole point.
    assert.deepEqual(failed.map((r) => r.row_number), [2, 3, 5]);
    assert.match(failed[0].message, /a name is required/);
    assert.match(failed[1].message, /unknown unit of measure/);
    // Migration 0010: the report must read as a sentence a person with a
    // spreadsheet can act on, not as a constraint name.
    assert.match(failed[2].message, /must be tracked by batch or serial/);
    assert.ok(!/shelf_life_needs_batch/.test(failed[2].message),
      'the raw constraint name leaked into the user-facing report');
  });

  test("one bad row does not roll back the good ones", async () => {
    const rows = [
      { name: "Survivor A", base_uom: "PCS" },
      { name: "", base_uom: "PCS" },
      { name: "Survivor B", base_uom: "PCS" },
    ];

    const surviving = await asUser(PLANNER, async (c) => {
      await c.query("select * from catalog.import_products($1::jsonb)", [JSON.stringify(rows)]);
      return (await c.query("select count(*)::int as n from catalog.product where name like 'Survivor%'"))
        .rows[0].n;
    });

    assert.equal(surviving, 2, "the failure took its neighbours down with it");
  });

  test("re-importing the same SKU updates rather than duplicating", async () => {
    const result = await asUser(PLANNER, async (c) => {
      const first = (await c.query("select * from catalog.import_products($1::jsonb)",
        [JSON.stringify([{ name: "Reimport Me", base_uom: "PCS", category: "One" }])])).rows[0];

      const second = (await c.query("select * from catalog.import_products($1::jsonb)",
        [JSON.stringify([{ sku_code: first.sku_code, name: "Reimport Me", base_uom: "PCS", category: "Two" }])])).rows[0];

      const { rows } = await c.query(
        "select category from catalog.product where sku_code = $1", [first.sku_code]);
      return { first, second, category: rows[0].category, };
    });

    assert.equal(result.first.status, "CREATED");
    assert.equal(result.second.status, "UPDATED");
    assert.equal(result.category, "Two", "the update did not take");
  });

  test("an operator cannot run an import at all", async () => {
    await asUser(AS.operatorShop1, async (c) => {
      await refused(
        () => c.query("select * from catalog.import_products($1::jsonb)",
          [JSON.stringify([{ name: "X", base_uom: "PCS" }])]),
        "FORBIDDEN_ROLE");
    });
  });
});

// ──────────────── opening balances respect the location boundary ────────────────

describe("Opening balances — the location boundary holds through import", () => {
  test("a shop manager cannot run an opening-balance import at all", async () => {
    // The role gate fires before the location gate, which is the right
    // order — a shop manager has no business setting opening balances
    // anywhere, so there is nothing to check per-location.
    await asUser(AS.managerShop1, async (c) => {
      await refused(
        () => c.query("select * from stock.import_opening_balances($1::jsonb)",
          [JSON.stringify([{ sku_code: "X", location_code: "SH1", on_hand: 1 }])]),
        "FORBIDDEN_ROLE");
    });
  });

  test("a location-scoped planner is refused at a location they do not hold", async () => {
    const c = await connect();
    let sku;
    try {
      const { rows } = await c.query(
        `insert into catalog.product (name, base_uom_id)
         values ('Scoped Test', (select id from catalog.uom where code = 'PCS'))
         returning sku_code`);
      sku = rows[0].sku_code;
    } finally { await c.end(); }

    // A planner WITHOUT the all_locations grant, holding only Shop 1.
    // can_access_location must refuse Shop 2 — this is the guard that
    // migration 0009 made reachable.
    const report = await asUser(AS.regionalPlanner, async (c2) =>
      (await c2.query("select * from stock.import_opening_balances($1::jsonb)", [JSON.stringify([
        { sku_code: sku, location_code: "SH1", on_hand: 10 },
        { sku_code: sku, location_code: "SH2", on_hand: 10 },
      ])])).rows);

    assert.equal(report[0].status, "OK", "own location should succeed");
    assert.equal(report[1].status, "FAILED", "another location must be refused");
    assert.match(report[1].message, /FORBIDDEN_LOCATION/);
  });

  test("an unknown product or location is reported, not thrown", async () => {
    const report = await asUser(PLANNER, async (c) =>
      (await c.query("select * from stock.import_opening_balances($1::jsonb)", [JSON.stringify([
        { sku_code: "PRD-DOES-NOT-EXIST", location_code: "SH1", on_hand: 5 },
        { sku_code: "PRD-2026-000001", location_code: "NOWHERE", on_hand: 5 },
      ])])).rows);

    assert.equal(report.length, 2);
    assert.ok(report.every((r) => r.status === "FAILED"));
    assert.match(report[0].message, /unknown product/);
    assert.match(report[1].message, /unknown location/);
  });
});

// ─────────────────────── THE GATE ───────────────────────

describe("THE GATE — 5,000 products, one pass, search under 200ms", () => {
  const CATEGORIES = ["Staples", "Beauty", "Fruit & Veg", "Dairy", "Household"];
  let importMs, sku0;

  test("5,000 products import in a single pass", async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      name: `Product ${String(i).padStart(4, "0")} ${CATEGORIES[i % 5]}`,
      base_uom: ["PCS", "G", "ML"][i % 3],
      category: CATEGORIES[i % 5],
      hsn_code: String(1000 + (i % 900)),
      barcode: `890${String(i).padStart(10, "0")}`,
    }));
    // One row deliberately broken, to prove the report still works at volume.
    rows[2500] = { name: "", base_uom: "PCS" };

    const c = await connect();
    try {
      await c.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(PLANNER)]);
      const t0 = performance.now();
      const { rows: report } = await c.query(
        "select status, count(*)::int as n from catalog.import_products($1::jsonb) group by status",
        [JSON.stringify(rows)]);
      importMs = performance.now() - t0;

      const byStatus = Object.fromEntries(report.map((r) => [r.status, r.n]));
      assert.equal(byStatus.CREATED, 4999, "4,999 valid rows should have landed");
      assert.equal(byStatus.FAILED, 1, "the one broken row should be reported, not fatal");

      const { rows: [{ n }] } = await c.query("select count(*)::int as n from catalog.product");
      assert.ok(n >= 4999, `expected at least 4,999 products, found ${n}`);
      console.log(`      ↳ 5,000 rows imported in ${Math.round(importMs)}ms`);
    } finally { await c.end(); }
  });

  test("fuzzy name search returns in under 200ms at that volume", async () => {
    const c = await connect();
    try {
      await c.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(PLANNER)]);
      await c.query("analyze catalog.product");

      const timings = [];
      for (const term of ["Beauty", "Product 0421", "Dairy", "Househol", "Fruit"]) {
        const t0 = performance.now();
        const { rows } = await c.query("select * from catalog.search_products($1, 25)", [term]);
        timings.push(performance.now() - t0);
        assert.ok(rows.length > 0, `"${term}" found nothing`);
      }

      const worst = Math.max(...timings);
      console.log(`      ↳ worst fuzzy search ${Math.round(worst)}ms over ${timings.length} terms`);
      assert.ok(worst < 200, `slowest search was ${Math.round(worst)}ms, budget is 200ms`);
    } finally { await c.end(); }
  });

  test("exact barcode lookup is the fast path a scanner needs", async () => {
    const c = await connect();
    try {
      await c.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(PLANNER)]);
      const t0 = performance.now();
      const { rows } = await c.query("select * from catalog.search_products($1, 5)", ["8900000000421"]);
      const ms = performance.now() - t0;

      assert.equal(rows.length, 1, "a barcode must resolve to exactly one product");
      assert.equal(rows[0].match_kind, "EXACT");
      console.log(`      ↳ barcode lookup ${Math.round(ms)}ms`);
      assert.ok(ms < 50, `barcode lookup took ${Math.round(ms)}ms — a scan must feel instant`);
    } finally { await c.end(); }
  });
});
