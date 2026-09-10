// ============================================================
// IMPORT — CONFIRMATION TEST
//
// The import screen is where a shop's whole catalogue arrives, from a
// spreadsheet somebody else exported. So the things worth proving are
// the ones that decide whether that file lands correctly or quietly
// half-lands:
//
//   • a header written the way a human writes it still matches
//   • a column nobody understands is REPORTED, not dropped in silence
//   • money written "₹1,250.50" is 125050 paise, not NaN
//   • the preview writes nothing at all
//   • a price arrives with its MRP, or it does not arrive
//   • stock can name a product the way a person would, and refuses
//     when the name is ambiguous
// ============================================================

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { AS, asUser, connect, seed } from "./harness.mjs";
import { parseCsvDetailed } from "../lib/csv.ts";
import { importProducts, importStock } from "../lib/import.ts";

before(async () => { await seed(); });

// ─────────────────── reading the file ───────────────────

describe("Reading a spreadsheet somebody else exported", () => {
  test("headers are matched the way a human writes them", () => {
    const { rows, present } = parseCsvDetailed(
      "Product Name,MRP (₹),Selling Price,Category,Unit\n" +
      "Haldi Powder,64,58,Oil Ghee & Masala,G");

    assert.equal(rows[0].name, "Haldi Powder");
    assert.equal(rows[0].mrp, 6400, "MRP (₹) should reach the mrp field");
    assert.equal(rows[0].retail, 5800, "Selling Price should reach retail");
    assert.equal(rows[0].base_uom, "G");
    assert.ok(present.includes("name"));
  });

  test("money survives rupee signs and thousands separators", () => {
    const { rows } = parseCsvDetailed(
      "name,retail,mrp\nSteel Bottle,\"₹1,250.50\",\"1,499\"");

    assert.equal(rows[0].retail, 125050, "₹1,250.50 is 125050 paise");
    assert.equal(rows[0].mrp, 149900);
  });

  test("a column nobody understands is reported rather than dropped", () => {
    const { ignored } = parseCsvDetailed(
      "name,Supplier Ref,Shelf Position\nHaldi,ABC-1,Aisle 4");

    // The old parser kept only what it recognised and said nothing.
    // A file with a price column that did not match looked exactly
    // like a file with no prices in it.
    assert.deepEqual(ignored.sort(), ["Shelf Position", "Supplier Ref"]);
  });

  test("a BOM from Excel does not swallow the first header", () => {
    const { rows } = parseCsvDetailed("﻿name,retail\nHaldi,58");
    assert.equal(rows[0].name, "Haldi", "the BOM became part of the header and it stopped matching");
  });

  test("tabs work too, because that is what pasting from a sheet gives you", () => {
    const { rows } = parseCsvDetailed("name\tretail\tmrp\nHaldi\t58\t64");
    assert.equal(rows[0].name, "Haldi");
    assert.equal(rows[0].retail, 5800);
  });

  test("a header alone is not an import", () => {
    assert.equal(parseCsvDetailed("name,retail").rows.length, 0);
  });
});

// ─────────────────── products ───────────────────

describe("Importing products", () => {
  test("a row with a price comes out sellable", async () => {
    await asUser(AS.admin, async (c) => {
      const { rows } = parseCsvDetailed(
        "name,category,base_uom,pack_size,retail,mrp,wholesale\n" +
        "Haldi Powder 200g,Oil Ghee & Masala,G,200 g,58,64,52");

      const result = await importProducts(c, rows);

      assert.equal(result.counts.created, 1, JSON.stringify(result.rows));
      assert.equal(result.counts.priced, 1, "a product with retail and mrp should be priced");

      const sku = result.rows[0].code;
      const { rows: [p] } = await c.query(
        `select p.pack_size, pr.retail_paise, pr.mrp_paise, pr.wholesale_paise
           from catalog.product p
           left join lateral catalog.price_for(p.id, null) pr on true
          where p.sku_code = $1`, [sku]);

      assert.equal(p.pack_size, "200 g", "pack_size is what the customer reads on the label");
      assert.equal(Number(p.retail_paise), 5800);
      assert.equal(Number(p.mrp_paise), 6400);
      assert.equal(Number(p.wholesale_paise), 5200);
    });
  });

  test("a price without its MRP is refused, not guessed", async () => {
    await asUser(AS.admin, async (c) => {
      const { rows } = parseCsvDetailed("name,base_uom,retail\nMystery Masala,G,58");
      const result = await importProducts(c, rows);

      // The product still lands — one missing column should not cost
      // you the row. But it lands unpriced, and says so.
      assert.equal(result.counts.created, 1);
      assert.equal(result.counts.priced, 0);
      assert.match(result.rows[0].extra ?? "", /needs both retail and mrp/);
    });
  });

  test("selling above MRP is refused by the database, and reported per row", async () => {
    await asUser(AS.admin, async (c) => {
      const { rows } = parseCsvDetailed(
        "name,base_uom,retail,mrp\nOverpriced Dal,G,199,99");
      const result = await importProducts(c, rows);

      assert.equal(result.counts.priced, 0, "retail above MRP must not be stored");
      assert.match(result.rows[0].extra ?? "", /price refused/);
    });
  });

  test("one bad row does not take the good ones with it", async () => {
    await asUser(AS.admin, async (c) => {
      const { rows } = parseCsvDetailed(
        "name,base_uom\nGood One,G\n,G\nAnother Good,ML\nBad Unit,WIDGETS");

      const result = await importProducts(c, rows);
      assert.equal(result.counts.created, 2, JSON.stringify(result.rows));
      assert.equal(result.counts.failed, 2);

      // And the failures say which line and why, or fixing them is a
      // guessing game across five thousand rows.
      const bad = result.rows.filter((r) => r.status === "FAILED");
      assert.ok(bad.every((r) => r.row > 0 && r.detail));
    });
  });

  test("an operator may not import, and the refusal comes from the database", async () => {
    await asUser(AS.operatorShop1, async (c) => {
      const { rows } = parseCsvDetailed("name,base_uom\nSneaky Product,G");
      await assert.rejects(() => importProducts(c, rows), /FORBIDDEN_ROLE|permission denied/i);
    });
  });
});

// ─────────────────── the preview ───────────────────

describe("The preview writes nothing", () => {
  test("a rolled-back import leaves no product behind", async () => {
    const before = await asUser(AS.admin, async (c) =>
      Number((await c.query("select count(*)::int n from catalog.product")).rows[0].n));

    // asUser already rolls back, which is exactly what withRollback
    // does in the application — same transaction shape, same result.
    await asUser(AS.admin, async (c) => {
      const { rows } = parseCsvDetailed(
        "name,base_uom,retail,mrp\nGhost Product,G,10,12");
      const result = await importProducts(c, rows);
      assert.equal(result.counts.created, 1, "the preview must really run the row");
    });

    const after = await asUser(AS.admin, async (c) =>
      Number((await c.query("select count(*)::int n from catalog.product")).rows[0].n));

    assert.equal(after, before, "a preview left a product behind");

    const c = await connect();
    try {
      const { rows } = await c.query(
        "select 1 from catalog.product where name = 'Ghost Product'");
      assert.equal(rows.length, 0, "the previewed product is still there");
    } finally {
      await c.end();
    }
  });
});

// ─────────────────── opening stock ───────────────────

describe("Importing opening stock", () => {
  test("a product can be named the way a person would name it", async () => {
    await asUser(AS.admin, async (c) => {
      const { rows: made } = await c.query(
        "select sku_code, name from catalog.product order by sku_code limit 1");

      const { rows } = parseCsvDetailed(
        `name,location,quantity,cost\n${made[0].name},SH1,120,14`);

      const result = await importStock(c, rows);
      assert.equal(result.counts.failed, 0, JSON.stringify(result.rows));
      assert.equal(result.counts.created, 1);
    });
  });

  test("an unknown product name is refused with a reason, not a silent skip", async () => {
    await asUser(AS.admin, async (c) => {
      const { rows } = parseCsvDetailed(
        "name,location,quantity,cost\nNo Such Product At All,SH1,10,5");

      const result = await importStock(c, rows);
      assert.equal(result.counts.created, 0);
      assert.match(result.rows[0].detail ?? "", /no product with that name/);
    });
  });

  test("TWO products sharing a name is refused rather than guessed", async () => {
    await asUser(AS.admin, async (c) => {
      // Exactly the situation that already exists on the live project:
      // "Haldi Powder" was created twice. Picking either one puts the
      // stock somewhere nobody can find it.
      await c.query(`select * from catalog.import_products($1::jsonb)`, [JSON.stringify([
        { name: "Twin Product", base_uom: "G" },
        { name: "Twin Product", base_uom: "G" },
      ])]);

      const { rows } = parseCsvDetailed(
        "name,location,quantity,cost\nTwin Product,SH1,10,5");

      const result = await importStock(c, rows);
      assert.equal(result.counts.created, 0);
      assert.match(result.rows[0].detail ?? "", /share this name/);
      assert.match(result.rows[0].detail ?? "", /use the SKU/);
    });
  });

  test("stock actually lands, and the balance says so", async () => {
    await asUser(AS.admin, async (c) => {
      const { rows: [made] } = await c.query(`
        select sku_code from catalog.product
         where not exists (select 1 from stock.balance b where b.product_id = catalog.product.id)
         limit 1`);

      if (!made) return; // every product already has stock; nothing to prove here

      const { rows } = parseCsvDetailed(
        `sku,location,quantity,cost\n${made.sku_code},SH1,250,9`);

      const result = await importStock(c, rows);
      assert.equal(result.counts.failed, 0, JSON.stringify(result.rows));

      const { rows: [bal] } = await c.query(`
        select b.on_hand from stock.balance b
          join catalog.product p on p.id = b.product_id
         where p.sku_code = $1`, [made.sku_code]);

      assert.equal(Number(bal.on_hand), 250);
    });
  });
});
