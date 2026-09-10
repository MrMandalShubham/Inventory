// ============================================================
// RECEIVING A DELIVERY — CONFIRMATION TEST
//
// The screen this covers asks three things: where it arrived, where it
// came from, and what was in it. Everything else about a product was
// decided when the product was created.
//
// So the things worth proving are the ones that stand between a
// shopkeeper and four correct cartons of turmeric:
//
//   • ten packs is ten packs, not ten grams
//   • a delivery with no stated cost is valued at what the shop
//     already values it at, never at zero
//   • perishables get a lot number whether or not one was typed
//   • one bad line does not take the rest of the delivery with it
//   • posting the same delivery twice does not double the stock
// ============================================================

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { AS, ID, asUser, seed } from "./harness.mjs";
import { unitsPerPack } from "../lib/pack.ts";
import { searchProducts, receiveBatch } from "../lib/receive.ts";

before(async () => { await seed(); });

/**
 * The fixture is two PCS products with no pack size and no batch
 * tracking, which is right for the boundary tests it exists for and
 * useless here. A test that needs a 200g batch-tracked product makes
 * one, rather than hunting the demo catalogue for something close and
 * quietly testing whatever it found.
 */
async function make(c, { name, uom = "G", pack = null, tracking = "NONE", shelf = null }) {
  const { rows: [made] } = await c.query(
    "select * from catalog.import_products($1::jsonb)",
    [JSON.stringify([{ name, base_uom: uom, tracking_mode: tracking,
                       ...(shelf ? { shelf_life_days: shelf } : {}) }])]);

  if (made.status === "FAILED") throw new Error(`fixture "${name}": ${made.message}`);

  const { rows: [p] } = await c.query(
    "update catalog.product set pack_size = $2 where sku_code = $1 returning id, sku_code",
    [made.sku_code, pack]);

  return p;
}

// ─────────────────── packs and base units ───────────────────

describe("Ten packs is not ten grams", () => {
  test("a label is read into a multiplier", () => {
    assert.equal(unitsPerPack("200 g", "G"), 200);
    assert.equal(unitsPerPack("1 kg", "G"), 1000);
    assert.equal(unitsPerPack("500 ml", "ML"), 500);
    assert.equal(unitsPerPack("1 L", "ML"), 1000);
    assert.equal(unitsPerPack("6 pcs", "PCS"), 6);
    assert.equal(unitsPerPack("10 pcs", "PCS"), 10);
  });

  test("a label it cannot read returns null rather than a guess", () => {
    // "6 pcs" of something measured in grams does not say what six
    // pieces weigh. A guess here is wrong by an unknown factor, and
    // silently — so the screen falls back to base units and says so.
    assert.equal(unitsPerPack("6 pcs", "G"), null);
    assert.equal(unitsPerPack("family pack", "G"), null);
    assert.equal(unitsPerPack(null, "G"), null);
    assert.equal(unitsPerPack("200 g", null), null);
    assert.equal(unitsPerPack("0 g", "G"), null);
  });

  test("a pack smaller than one base unit is refused, because the ledger holds integers", () => {
    assert.equal(unitsPerPack("0.5 g", "KG"), null);
  });
});

// ─────────────────── the picker ───────────────────

describe("Choosing a product", () => {
  test("search finds a product by name and by SKU", async () => {
    await asUser(AS.admin, async (c) => {
      const { rows: [any] } = await c.query(
        "select name, sku_code from catalog.product order by sku_code limit 1");

      const byName = await searchProducts(c, any.name.slice(0, 5), ID.locShop1);
      assert.ok(byName.length > 0, `nothing matched "${any.name.slice(0, 5)}"`);

      const bySku = await searchProducts(c, any.sku_code, ID.locShop1);
      assert.equal(bySku[0].sku_code, any.sku_code);
    });
  });

  test("each hit carries what the line needs to be filled in", async () => {
    await asUser(AS.admin, async (c) => {
      const [p] = await searchProducts(c, "", ID.locShop1, 1);
      for (const field of ["id", "sku_code", "name", "base_uom", "tracking_mode",
                           "units_per_pack", "cost_paise", "on_hand"]) {
        assert.ok(field in p, `the picker cannot show a product without ${field}`);
      }
    });
  });

  test("a shop manager cannot see another shop's stock through the picker", async () => {
    const mine = await asUser(AS.managerShop1, (c) => searchProducts(c, "", ID.locShop1, 5));
    const theirs = await asUser(AS.managerShop1, (c) => searchProducts(c, "", ID.locShop2, 5));

    // The catalogue is global, so the same products appear. The
    // QUANTITIES must not: Shop 2's on-hand is not Shop 1's business.
    assert.ok(mine.length > 0);
    assert.ok(theirs.every((p) => p.on_hand === 0),
      "another location's on-hand leaked into the picker");
  });
});

// ─────────────────── receiving ───────────────────

describe("Receiving a delivery", () => {
  test("ten packs of a 200g product puts 2000 grams on the shelf", async () => {
    await asUser(AS.admin, async (c) => {
      const p = await make(c, { name: "Pack Test Haldi 200g", uom: "G", pack: "200 g" });

      const before = Number((await c.query(
        `select coalesce(sum(on_hand),0) n from stock.balance
          where product_id = $1 and location_id = $2`, [p.id, ID.locShop1])).rows[0].n);

      const r = await receiveBatch(c, {
        locationId: ID.locShop1, note: "Sharma Traders — invoice 4471",
        lines: [{ product_id: p.id, quantity: 10, packs: true, unit_cost: 4200 }],
      });

      assert.equal(r.rows[0].status, "RECEIVED", r.rows[0].detail ?? "");
      assert.equal(r.rows[0].units, 2000, "ten packs of 200 g is 2000 g");

      const after = Number((await c.query(
        `select coalesce(sum(on_hand),0) n from stock.balance
          where product_id = $1 and location_id = $2`, [p.id, ID.locShop1])).rows[0].n);

      assert.equal(after, before + 2000);
    });
  });

  test("the note reaches the ledger, because that is what anyone reads later", async () => {
    await asUser(AS.admin, async (c) => {
      const { rows: [p] } = await c.query(
        "select id from catalog.product where tracking_mode = 'NONE' limit 1");

      await receiveBatch(c, {
        locationId: ID.locShop1, note: "Sharma Traders — invoice 4471",
        lines: [{ product_id: p.id, quantity: 5, packs: false, unit_cost: 1000 }],
      });

      const { rows: [entry] } = await c.query(`
        select note, reason_code from stock.ledger
         where product_id = $1 and location_id = $2
         order by id desc limit 1`, [p.id, ID.locShop1]);

      assert.equal(entry.reason_code, "RECEIPT", "a delivery is a receipt, not an adjustment");
      assert.match(entry.note, /Sharma Traders/);
    });
  });

  test("no cost given means it is valued at what the shop already paid", async () => {
    await asUser(AS.admin, async (c) => {
      const p = await make(c, { name: "Costed Once Thing", uom: "G" });

      // Establish a weighted average by receiving with an explicit
      // cost, then receive again saying nothing about cost.
      await receiveBatch(c, {
        locationId: ID.locShop1, note: "first, with an invoice",
        lines: [{ product_id: p.id, quantity: 100, packs: false, unit_cost: 1400 }],
      });

      const { rows: [b] } = await c.query(
        `select weighted_avg_cost as wac from stock.balance
          where product_id = $1 and location_id = $2 and batch_id is null`,
        [p.id, ID.locShop1]);
      assert.ok(Number(b.wac) > 0, "the first receipt did not set a weighted average");

      const r = await receiveBatch(c, {
        locationId: ID.locShop1, note: "no invoice yet",
        lines: [{ product_id: p.id, quantity: 10, packs: false }],
      });

      assert.equal(r.rows[0].status, "RECEIVED", r.rows[0].detail ?? "");
      assert.equal(r.rows[0].value_paise, 10 * Number(b.wac),
        "stock entered at a value the shop does not recognise");
    });
  });

  test("a product never costed here refuses rather than entering at zero", async () => {
    await asUser(AS.admin, async (c) => {
      // A brand new product has no weighted average anywhere. Letting
      // it in at no value reports the delivery as worthless and
      // quietly wrecks the valuation — migration 0032.
      const { rows: [made] } = await c.query(
        `select * from catalog.import_products($1::jsonb)`,
        [JSON.stringify([{ name: "Never Costed Thing", base_uom: "G" }])]);

      const { rows: [p] } = await c.query(
        "select id from catalog.product where sku_code = $1", [made.sku_code]);

      const r = await receiveBatch(c, {
        locationId: ID.locShop1, note: "first ever delivery",
        lines: [{ product_id: p.id, quantity: 100, packs: false }],
      });

      assert.equal(r.rows[0].status, "FAILED");
      assert.match(r.rows[0].detail, /never been costed/);
    });
  });

  test("a perishable gets a lot number even when nobody typed one", async () => {
    await asUser(AS.admin, async (c) => {
      const p = await make(c, { name: "Lot Test Milk 500ml", uom: "ML",
                                pack: "500 ml", tracking: "BATCH", shelf: 5 });

      const r = await receiveBatch(c, {
        locationId: ID.locShop1, note: "dairy run",
        lines: [{ product_id: p.id, quantity: 20, packs: false, unit_cost: 600 }],
      });

      assert.equal(r.rows[0].status, "RECEIVED", r.rows[0].detail ?? "");

      const { rows: [b] } = await c.query(`
        select b.lot_no, b.expiry_date from stock.batch b
         where b.product_id = $1 order by b.created_at desc limit 1`, [p.id]);

      assert.ok(b, "a batch-tracked receipt landed with no batch at all");
      assert.match(b.lot_no, /^\d{4}-\d{2}-\d{2}$/, "the fallback lot is the receipt date");
      assert.ok(b.expiry_date, "shelf life is known, so the expiry should have been worked out");
    });
  });

  test("the same lot arriving twice is one lot, not two", async () => {
    await asUser(AS.admin, async (c) => {
      const p = await make(c, { name: "Same Lot Curd 400g", uom: "G",
                                pack: "400 g", tracking: "BATCH", shelf: 7 });

      for (let i = 0; i < 2; i++) {
        await receiveBatch(c, {
          locationId: ID.locShop1, note: "same lot twice",
          lines: [{ product_id: p.id, quantity: 10, packs: false, unit_cost: 600, lot: "LOT-A" }],
        });
      }

      const { rows } = await c.query(
        "select id from stock.batch where product_id = $1 and lot_no = 'LOT-A'", [p.id]);

      // Two rows for one lot would split a recall in half.
      assert.equal(rows.length, 1);
    });
  });

  test("ONE BAD LINE DOES NOT TAKE THE REST OF THE DELIVERY", async () => {
    await asUser(AS.admin, async (c) => {
      const { rows: good } = await c.query(
        "select id from catalog.product where tracking_mode = 'NONE' limit 2");

      // The middle line is rejected by the database. Without a
      // savepoint per line, Postgres aborts the whole transaction and
      // every line after it fails too — three broken rows reported
      // when one was.
      const r = await receiveBatch(c, {
        locationId: ID.locShop1, note: "mixed delivery",
        lines: [
          { product_id: good[0].id, quantity: 5, packs: false, unit_cost: 1000 },
          { product_id: good[0].id, quantity: -5, packs: false, unit_cost: 1000 },
          { product_id: good[1].id, quantity: 7, packs: false, unit_cost: 1000 },
        ],
      });

      assert.equal(r.rows[0].status, "RECEIVED", r.rows[0].detail ?? "");
      assert.equal(r.rows[1].status, "FAILED");
      assert.equal(r.rows[2].status, "RECEIVED",
        `the line after a failure was lost: ${r.rows[2].detail}`);
    });
  });

  test("posting the same delivery twice does not double the stock", async () => {
    await asUser(AS.admin, async (c) => {
      const { rows: [p] } = await c.query(
        "select id from catalog.product where tracking_mode = 'NONE' limit 1");

      const before = Number((await c.query(
        `select coalesce(sum(on_hand),0) n from stock.balance
          where product_id = $1 and location_id = $2`, [p.id, ID.locShop1])).rows[0].n);

      const batch = {
        locationId: ID.locShop1, note: "double click",
        reference: "test-ref-" + Date.now(),
        lines: [{ product_id: p.id, quantity: 40, packs: false, unit_cost: 1000 }],
      };

      await receiveBatch(c, batch);
      await receiveBatch(c, batch);

      const after = Number((await c.query(
        `select coalesce(sum(on_hand),0) n from stock.balance
          where product_id = $1 and location_id = $2`, [p.id, ID.locShop1])).rows[0].n);

      assert.equal(after, before + 40, "a retry posted the delivery a second time");
    });
  });

  test("an operator may receive — it is an everyday job", async () => {
    await asUser(AS.operatorShop1, async (c) => {
      const { rows: [p] } = await c.query(
        "select id from catalog.product where tracking_mode = 'NONE' limit 1");

      const r = await receiveBatch(c, {
        locationId: ID.locShop1, note: "morning delivery",
        lines: [{ product_id: p.id, quantity: 12, packs: false, unit_cost: 1000 }],
      });

      assert.equal(r.rows[0].status, "RECEIVED", r.rows[0].detail ?? "");
    });
  });

  test("but not into a shop they do not work at", async () => {
    await asUser(AS.operatorShop1, async (c) => {
      const { rows: [p] } = await c.query(
        "select id from catalog.product where tracking_mode = 'NONE' limit 1");

      const r = await receiveBatch(c, {
        locationId: ID.locShop2, note: "wrong shop",
        lines: [{ product_id: p.id, quantity: 12, packs: false, unit_cost: 1000 }],
      });

      assert.equal(r.rows[0].status, "FAILED");
      assert.match(r.rows[0].detail, /may not move stock|FORBIDDEN/i);
    });
  });
});
