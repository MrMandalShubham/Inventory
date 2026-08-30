// ============================================================
// STOREFRONT API — CONFIRMATION TEST
//
// What a selling app needs from an inventory, proved at the layer
// that enforces it rather than at the HTTP layer that exposes it:
//
//   • products, prices and stock, per location
//   • an order held whole or refused whole
//   • delivered → stock actually leaves; cancelled → it comes back
//   • a retry after a timeout does not hold the stock twice
//   • and a selling app can never assign a stock number
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

/** The storefront's own key: an api_client bound to one shop. */
const STOREFRONT = {
  sub: "33333333-3333-4333-8333-000000000001",
  role: "api_client",
  location_ids: ID.locShop1,
  all_locations: false,
};

let skuA, skuB;

before(async () => {
  await seed();
  const c = await as(AS.admin);
  try {
    const a = await one(c,
      `insert into catalog.product (name, base_uom_id, category)
       values ('Storefront Milk', (select id from catalog.uom where code='ML'), 'Dairy')
       returning id, sku_code, slug`);
    const b = await one(c,
      `insert into catalog.product (name, base_uom_id, category)
       values ('Storefront Bread', (select id from catalog.uom where code='PCS'), 'Staples')
       returning id, sku_code, slug`);
    skuA = a.sku_code; skuB = b.sku_code;

    await q(c, "select stock.post_movement($1,$2,100,'OPENING',null,'seed',null,1000)",
      [a.id, ID.locShop1]);
    await q(c, "select stock.post_movement($1,$2,40,'OPENING',null,'seed',null,2000)",
      [b.id, ID.locShop1]);
    // Stocked at another shop too, so location scoping is testable.
    await q(c, "select stock.post_movement($1,$2,500,'OPENING',null,'seed',null,1000)",
      [a.id, ID.locHub]);

    await q(c, "select catalog.set_price($1, 2600, 2800, 2200)", [a.id]);
    await q(c, "select catalog.set_price($1, 4000, 4500, 3400)", [b.id]);
  } finally { await c.end(); }
});

// ─────────────────────── CI guards ───────────────────────

describe("CI checks after the storefront surface", () => {
  for (const check of ["rls-coverage", "definer-scope", "function-overloads", "server-only", "search-path"]) {
    test(`${check} still passes`, async () => {
      const v = await runCheck(check);
      assert.deepEqual(v, [],
        v.map((x) => `  ${x.schema_name}.${x.table_name ?? x.function_name}: ${x.violation}`).join("\n"));
    });
  }
});

// ─────────────── catalogue: slugs, categories, prices ───────────────

describe("The catalogue a storefront reads", () => {
  test("every product gets a stable slug, generated once", async () => {
    const c = await as(AS.admin);
    try {
      const p = await one(c, "select slug from catalog.product where sku_code=$1", [skuA]);
      assert.equal(p.slug, "storefront-milk");

      // Renaming must NOT change the slug — a storefront that builds
      // its own from the name breaks every link the day somebody
      // fixes a typo.
      await q(c, "update catalog.product set name='Storefront Milk 500ml' where sku_code=$1", [skuA]);
      const after = await one(c, "select slug from catalog.product where sku_code=$1", [skuA]);
      assert.equal(after.slug, "storefront-milk", "the slug moved when the name changed");
    } finally { await c.end(); }
  });

  test("categories became real entities with slugs", async () => {
    const c = await as(AS.admin);
    try {
      const cats = await q(c, "select id, name from catalog.category order by id");
      assert.ok(cats.length > 0, "no categories were backfilled from the products");

      const dairy = cats.find((x) => x.id === "dairy");
      assert.ok(dairy, `expected a "dairy" category, got: ${cats.map((x) => x.id).join(", ")}`);

      // And products point at them.
      const p = await one(c,
        "select category_id from catalog.product where sku_code=$1", [skuA]);
      assert.equal(p.category_id, "dairy");
    } finally { await c.end(); }
  });

  test("a price applies everywhere until a shop overrides it", async () => {
    const c = await as(AS.admin);
    try {
      const pid = (await one(c, "select id from catalog.product where sku_code=$1", [skuA])).id;

      const base = await one(c, "select * from catalog.price_for($1, $2)", [pid, ID.locShop1]);
      assert.equal(Number(base.retail_paise), 2600);
      assert.equal(base.is_override, false);

      // Shop 1 charges more.
      await q(c, "select catalog.set_price($1, 2900, 3000, 2200, $2)", [pid, ID.locShop1]);

      const here = await one(c, "select * from catalog.price_for($1, $2)", [pid, ID.locShop1]);
      assert.equal(Number(here.retail_paise), 2900, "the override did not win");
      assert.equal(here.is_override, true);

      const elsewhere = await one(c, "select * from catalog.price_for($1, $2)", [pid, ID.locHub]);
      assert.equal(Number(elsewhere.retail_paise), 2600, "the override leaked to another shop");
    } finally { await c.end(); }
  });

  test("selling above MRP is refused — it is illegal, not a preference", async () => {
    const c = await as(AS.admin);
    try {
      const pid = (await one(c, "select id from catalog.product where sku_code=$1", [skuB])).id;
      await refused(
        () => c.query("select catalog.set_price($1, 5000, 4500)", [pid]),
        "retail_within_mrp");
    } finally { await c.end(); }
  });

  test("a wholesale price above retail is refused", async () => {
    const c = await as(AS.admin);
    try {
      const pid = (await one(c, "select id from catalog.product where sku_code=$1", [skuB])).id;
      await refused(
        () => c.query("select catalog.set_price($1, 4000, 4500, 4400)", [pid]),
        "wholesale_below_retail");
    } finally { await c.end(); }
  });

  test("a product with no price is simply not priced — never zero", async () => {
    const c = await as(AS.admin);
    try {
      const p = await one(c,
        `insert into catalog.product (name, base_uom_id)
         values ('Unpriced Thing', (select id from catalog.uom where code='PCS'))
         returning id`);
      const rows = await q(c, "select * from catalog.price_for($1, null)", [p.id]);
      assert.deepEqual(rows, [],
        "returning zero would put an unpriced product on the shelf for free");
    } finally { await c.end(); }
  });
});

// ═══════════════ THE ORDER LIFECYCLE ═══════════════

describe("An order is held whole or refused whole", () => {
  test("a normal order holds every line", async () => {
    const c = await as(STOREFRONT);
    try {
      const rows = await q(c,
        "select * from stock.reserve_order($1,$2,$3::jsonb)",
        ["ord-001", ID.locShop1,
         JSON.stringify([{ sku: skuA, quantity: 4 }, { sku: skuB, quantity: 2 }])]);

      assert.ok(rows.every((r) => r.ok), JSON.stringify(rows));
      assert.equal(rows.length, 2);
      assert.ok(rows.every((r) => r.reservation_id));
    } finally { await c.end(); }
  });

  test("the held stock is off the shelf but not yet gone", async () => {
    const c = await as(AS.admin);
    try {
      const b = await one(c,
        `select b.on_hand, b.reserved, b.on_hand - b.reserved - b.allocated - b.damaged as available
           from stock.balance b join catalog.product p on p.id = b.product_id
          where p.sku_code=$1 and b.location_id=$2`, [skuA, ID.locShop1]);

      assert.equal(b.on_hand, 100, "a hold must not reduce what is physically there");
      assert.equal(b.reserved, 4);
      assert.equal(b.available, 96, "but it must reduce what can be promised");
    } finally { await c.end(); }
  });

  test("THE GATE — one short line refuses the WHOLE order, holding nothing", async () => {
    const c = await as(STOREFRONT);
    try {
      const rows = await q(c,
        "select * from stock.reserve_order($1,$2,$3::jsonb)",
        ["ord-002", ID.locShop1,
         JSON.stringify([{ sku: skuA, quantity: 5 }, { sku: skuB, quantity: 9999 }])]);

      assert.ok(rows.every((r) => !r.ok), "a short line did not refuse the order");

      // Every line comes back, so the storefront can show the customer
      // exactly what is short rather than the first failure only.
      assert.equal(rows.length, 2);
      const shortLine = rows.find((r) => r.sku === skuB);
      assert.equal(shortLine.problem, "insufficient stock");
      // The property, not a fixed number: an earlier test holds some
      // of this product, so a literal would drift with test order.
      assert.ok(shortLine.available < shortLine.requested,
        `available ${shortLine.available} should be under the ${shortLine.requested} asked for`);

      // And the line that COULD have been met was not held.
      const held = Number((await one(c,
        "select count(*)::int n from stock.reservation where order_ref='ord-002'")).n);
      assert.equal(held, 0,
        "a partial hold means a customer pays for two things and one arrives");
    } finally { await c.end(); }
  });

  test("an unknown product refuses the order rather than being skipped", async () => {
    const c = await as(STOREFRONT);
    try {
      const rows = await q(c,
        "select * from stock.reserve_order($1,$2,$3::jsonb)",
        ["ord-003", ID.locShop1,
         JSON.stringify([{ sku: skuA, quantity: 1 }, { sku: "NOPE-999", quantity: 1 }])]);

      assert.ok(rows.every((r) => !r.ok));
      assert.equal(rows.find((r) => r.sku === "NOPE-999").problem, "no such product");
    } finally { await c.end(); }
  });

  test("a retry after a timeout returns the SAME holds, not a second set", async () => {
    const c = await as(STOREFRONT);
    try {
      const first = await q(c, "select * from stock.reserve_order($1,$2,$3::jsonb)",
        ["ord-retry", ID.locShop1, JSON.stringify([{ sku: skuA, quantity: 3 }])]);
      const again = await q(c, "select * from stock.reserve_order($1,$2,$3::jsonb)",
        ["ord-retry", ID.locShop1, JSON.stringify([{ sku: skuA, quantity: 3 }])]);

      assert.equal(again[0].reservation_id, first[0].reservation_id,
        "the retry held a second set of stock — a timeout would cost real inventory");
      assert.equal(again[0].problem, "already reserved");

      const total = Number((await one(c,
        `select coalesce(sum(quantity),0)::int n from stock.reservation
          where order_ref='ord-retry' and status='HELD'`)).n);
      assert.equal(total, 3);
    } finally { await c.end(); }
  });
});

describe("Delivered, and cancelled", () => {
  test("delivering an order takes the stock off the shelf for real", async () => {
    const before = await (async () => {
      const c = await as(AS.admin);
      try {
        return await one(c,
          `select b.on_hand from stock.balance b join catalog.product p on p.id=b.product_id
            where p.sku_code=$1 and b.location_id=$2`, [skuA, ID.locShop1]);
      } finally { await c.end(); }
    })();

    const c = await as(STOREFRONT);
    try {
      const rows = await q(c, "select * from stock.commit_order($1)", ["ord-001"]);
      assert.equal(rows.length, 2);
      assert.ok(rows.every((r) => Number(r.ledger_id) > 0),
        "a delivery must write a ledger entry — that is what makes it real");
    } finally { await c.end(); }

    const admin = await as(AS.admin);
    try {
      const after = await one(admin,
        `select b.on_hand, b.reserved from stock.balance b
           join catalog.product p on p.id=b.product_id
          where p.sku_code=$1 and b.location_id=$2`, [skuA, ID.locShop1]);

      assert.equal(after.on_hand, before.on_hand - 4, "the goods did not leave");
      assert.equal(after.reserved, 3, "only the other order's hold should remain");
    } finally { await admin.end(); }
  });

  test("cancelling an order puts the stock back", async () => {
    const c = await as(STOREFRONT);
    try {
      const n = await one(c, "select stock.release_order($1,$2) as n",
        ["ord-retry", "customer cancelled"]);
      assert.equal(Number(n.n), 1);
    } finally { await c.end(); }

    const admin = await as(AS.admin);
    try {
      const b = await one(admin,
        `select b.reserved, b.on_hand - b.reserved - b.allocated - b.damaged as available
           from stock.balance b join catalog.product p on p.id=b.product_id
          where p.sku_code=$1 and b.location_id=$2`, [skuA, ID.locShop1]);
      assert.equal(b.reserved, 0, "cancelled stock stayed held — it is sellable to nobody");
    } finally { await admin.end(); }
  });

  test("committing an order that never existed is an error, not a silent success", async () => {
    const c = await as(STOREFRONT);
    try {
      await refused(() => c.query("select * from stock.commit_order($1)", ["never-existed"]),
        "NO_SUCH_ORDER");
    } finally { await c.end(); }
  });

  test("order_status answers 'did my reserve land?' after a timeout", async () => {
    const c = await as(STOREFRONT);
    try {
      const rows = await q(c, "select * from stock.order_status($1)", ["ord-001"]);
      assert.equal(rows.length, 2);
      assert.ok(rows.every((r) => r.status === "CONSUMED"));
    } finally { await c.end(); }
  });
});

// ─────────────── the boundaries that must hold ───────────────

describe("What a selling app may NOT do", () => {
  test("it cannot hold stock at a shop its key does not cover", async () => {
    const c = await as(STOREFRONT);
    try {
      await refused(
        () => c.query("select * from stock.reserve_order($1,$2,$3::jsonb)",
          ["ord-hub", ID.locHub, JSON.stringify([{ sku: skuA, quantity: 1 }])]),
        "FORBIDDEN_LOCATION");
    } finally { await c.end(); }
  });

  test("it cannot see stock at a shop its key does not cover", async () => {
    const c = await as(STOREFRONT);
    try {
      const rows = await q(c,
        `select b.on_hand from stock.balance b
          where b.location_id = $1`, [ID.locHub]);
      assert.deepEqual(rows, [], "the storefront read another location's stock");
    } finally { await c.end(); }
  });

  test("IT CANNOT ASSIGN A STOCK NUMBER — stock is a sum, not a field", async () => {
    const c = await as(STOREFRONT);
    try {
      // The whole design rests on this. RLS gives stock.balance no
      // write policy, so the UPDATE matches nothing rather than
      // raising — which is how a policy declines.
      await q(c, "update stock.balance set on_hand = 999999");

      const admin = await as(AS.admin);
      try {
        const b = await one(admin,
          `select b.on_hand from stock.balance b join catalog.product p on p.id=b.product_id
            where p.sku_code=$1 and b.location_id=$2`, [skuA, ID.locShop1]);
        assert.notEqual(b.on_hand, 999999,
          "a selling app rewrote a stock level — the ledger and the balance can now disagree");
      } finally { await admin.end(); }
    } finally { await c.end(); }
  });

  test("nor delete a ledger entry to cover its tracks", async () => {
    const c = await as(STOREFRONT);
    try {
      const before = Number((await one(c,
        "select count(*)::int n from stock.ledger")).n);

      // Row-level security declines by matching NO ROWS, not by
      // raising — the append-only trigger never even gets the chance
      // to fire. Both refusals are correct; only one of them throws,
      // so the assertion has to be about what survived.
      await q(c, "delete from stock.ledger");

      const after = Number((await one(c,
        "select count(*)::int n from stock.ledger")).n);
      assert.equal(after, before, "a selling app deleted ledger history");
    } finally { await c.end(); }
  });
});

// ─────────────── everything still reconciles ───────────────

describe("After a day of selling", () => {
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
