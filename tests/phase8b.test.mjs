// ============================================================
// PRODUCT IMAGES — CONFIRMATION TEST
//
// The point of storing images here at all is that the customer-facing
// app gets product details AND pictures from one place. So the things
// worth proving are:
//
//   • the bytes decide the type, not what the caller claimed
//   • the same photo stored twice costs one object
//   • a product always has exactly one primary image, including after
//     the primary is deleted
//   • an operator cannot change the catalogue
// ============================================================

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { AS, connect, refused, runCheck, seed } from "./harness.mjs";
import {
  putImage, inspect, keyFor, storage, checksumOf, chooseDriver, MAX_BYTES,
} from "../lib/storage.ts";
import { attachStagedImage } from "../lib/attach-image.ts";

const q = (c, sql, p) => c.query(sql, p).then((r) => r.rows);
const one = async (c, sql, p) => (await q(c, sql, p))[0];

async function as(claims) {
  const c = await connect();
  await c.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(claims)]);
  await c.query("set role authenticated");
  return c;
}

// ── real image bytes, built by hand ──
//
// A 1×1 PNG and a 2×1 PNG, so dimension parsing is tested against
// something with a known answer rather than a fixture nobody can
// check.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");
const PNG_2x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR42mNkYPjPgAcw4pIEAG5NAQlbdKGhAAAAAElFTkSuQmCC",
  "base64");
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64");

let productId, otherProductId;

before(async () => {
  await seed();
  // Start from an empty object store so deduplication is measured
  // rather than inherited from a previous run.
  await rm(join(process.cwd(), ".storage", "products"), { recursive: true, force: true });

  const c = await as(AS.admin);
  try {
    productId = (await one(c,
      `insert into catalog.product (name, base_uom_id)
       values ('Image Test', (select id from catalog.uom where code='PCS')) returning id`)).id;
    otherProductId = (await one(c,
      `insert into catalog.product (name, base_uom_id)
       values ('Image Test Two', (select id from catalog.uom where code='PCS')) returning id`)).id;
  } finally { await c.end(); }
});

// ─────────────────────── CI guards ───────────────────────

describe("CI checks with the image tables", () => {
  test("every table still has RLS and a policy", async () => {
    const v = await runCheck("rls-coverage");
    assert.deepEqual(v, [], v.map((x) => `  ${x.schema_name}.${x.table_name}: ${x.violation}`).join("\n"));
  });

  test("the definer surface is still fully scoped", async () => {
    const v = await runCheck("definer-scope");
    assert.deepEqual(v, [], v.map((x) => `  ${x.schema_name}.${x.function_name}`).join("\n"));
  });

  test("no function was accidentally overloaded", async () => {
    const v = await runCheck("function-overloads");
    assert.deepEqual(v, [],
      v.map((x) => `  ${x.schema_name}.${x.function_name}: ${x.argument_lists}`).join("\n"));
  });
});

// ─────────── the bytes decide, not the caller ───────────

describe("What is actually in the file", () => {
  test("dimensions are read out of the image", () => {
    assert.deepEqual(inspect(PNG_1x1), { mime: "image/png", width: 1, height: 1 });
    assert.deepEqual(inspect(PNG_2x1), { mime: "image/png", width: 2, height: 1 });
    assert.equal(inspect(JPEG)?.mime, "image/jpeg");
  });

  test("a file that is not an image is refused", async () => {
    await assert.rejects(
      () => putImage(Buffer.from("<?php system($_GET['c']); ?>")),
      /NOT_AN_IMAGE/,
      "anything storable here is served back by an unauthenticated route");
  });

  test("a lie about the content type is refused, not quietly corrected", async () => {
    await assert.rejects(
      () => putImage(PNG_1x1, "image/webp"),
      /IMAGE_TYPE_MISMATCH/);
  });

  test("an empty upload is refused", async () => {
    await assert.rejects(() => putImage(Buffer.alloc(0)), /EMPTY_IMAGE/);
  });

  test("an oversized image is refused", async () => {
    // Real PNG header, padded past the limit — so it fails on SIZE
    // rather than on not being an image, which is the check under test.
    const big = Buffer.concat([PNG_1x1, Buffer.alloc(MAX_BYTES + 1)]);
    await assert.rejects(() => putImage(big), /IMAGE_TOO_LARGE/);
  });

  test("the key is the hash of the bytes, so it cannot be guessed", () => {
    const k = keyFor(PNG_1x1, "image/png");
    assert.match(k, /^products\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/);
    assert.equal(k, keyFor(PNG_1x1, "image/png"), "the same bytes must give the same key");
    assert.notEqual(k, keyFor(PNG_2x1, "image/png"), "different bytes, different key");
  });
});

// ─────────────── storing ───────────────

describe("Storing", () => {
  test("the same photo twice costs one object", async () => {
    const first = await putImage(PNG_1x1);
    assert.equal(first.deduplicated, false, "the first upload wrote nothing");

    const again = await putImage(PNG_1x1);
    assert.equal(again.deduplicated, true,
      "the same bytes were stored a second time — content addressing is not working");
    assert.equal(again.key, first.key);

    const keys = await storage().list("products");
    assert.equal(keys.filter((k) => k === first.key).length, 1);
  });

  test("what goes in comes back out unchanged", async () => {
    const { key } = await putImage(JPEG);
    const got = await storage().get(key);
    assert.ok(got, "the object was not readable after being written");
    assert.equal(got.mime, "image/jpeg");
    assert.ok(got.data.equals(JPEG), "the bytes changed in storage");
  });
});

// ─────────────── attaching to a product ───────────────

describe("A product's gallery", () => {
  test("the first image is automatically the primary one", async () => {
    const img = await putImage(PNG_1x1);
    const c = await as(AS.admin);
    try {
      await q(c, "select catalog.attach_product_image($1,$2,null,$3,$4,$5,$6,$7,$8,null)",
        [productId, img.key, img.mime, img.bytes, img.width, img.height, img.checksum,
         "a single grey pixel"]);

      const row = await one(c,
        "select * from catalog.product_image where product_id=$1", [productId]);
      assert.equal(row.is_primary, true,
        "a product with photos and no primary renders as a blank tile");
      assert.equal(row.alt_text, "a single grey pixel");
      assert.equal(row.width, 1);
    } finally { await c.end(); }
  });

  test("two images cannot both be primary", async () => {
    const img = await putImage(PNG_2x1);
    const c = await as(AS.admin);
    try {
      await q(c, "select catalog.attach_product_image($1,$2,null,$3,$4,$5,$6,$7,$8,true)",
        [productId, img.key, img.mime, img.bytes, img.width, img.height, img.checksum, "wider"]);

      const n = Number((await one(c,
        `select count(*)::int n from catalog.product_image
          where product_id=$1 and is_primary`, [productId])).n);
      assert.equal(n, 1, "the customer app would render whichever row came back first");

      // And the index refuses it even if something bypassed the function.
      await refused(
        () => c.query(
          "update catalog.product_image set is_primary = true where product_id=$1", [productId]),
        "duplicate key");
    } finally { await c.end(); }
  });

  test("the same file cannot be attached twice to one product", async () => {
    const img = await putImage(PNG_1x1);
    const c = await as(AS.admin);
    try {
      await refused(
        () => c.query("select catalog.attach_product_image($1,$2,null,$3,$4,$5,$6,$7,null,null)",
          [productId, img.key, img.mime, img.bytes, img.width, img.height, img.checksum]),
        "duplicate key");
    } finally { await c.end(); }
  });

  test("but the same file CAN be shared by two products", async () => {
    const img = await putImage(PNG_1x1);
    const c = await as(AS.admin);
    try {
      const id = await one(c,
        "select catalog.attach_product_image($1,$2,null,$3,$4,$5,$6,$7,null,null) as id",
        [otherProductId, img.key, img.mime, img.bytes, img.width, img.height, img.checksum]);
      assert.ok(id.id, "a supplier photo reused for two pack sizes is legitimate");
    } finally { await c.end(); }
  });

  test("removing the primary promotes another — a product does not lose its picture", async () => {
    const c = await as(AS.admin);
    try {
      const primary = await one(c,
        "select id from catalog.product_image where product_id=$1 and is_primary", [productId]);

      await q(c, "select catalog.remove_product_image($1)", [primary.id]);

      const left = await q(c,
        "select id, is_primary from catalog.product_image where product_id=$1", [productId]);
      assert.equal(left.length, 1);
      assert.equal(left[0].is_primary, true,
        "the product still has a photo but nothing marked primary — it renders blank");
    } finally { await c.end(); }
  });

  test("removing an image does NOT delete bytes another product is using", async () => {
    const c = await as(AS.admin);
    try {
      const shared = await one(c,
        "select id, storage_key from catalog.product_image where product_id=$1", [otherProductId]);

      // Still referenced, so the bytes must stay.
      const referenced = await one(c,
        "select catalog.image_key_referenced($1) as yes", [shared.storage_key]);
      assert.equal(referenced.yes, true);

      const got = await storage().get(shared.storage_key);
      assert.ok(got, "the shared object was deleted and another product's photo is now broken");
    } finally { await c.end(); }
  });

  test("an unreferenced key is reported as collectable", async () => {
    const c = await as(AS.admin);
    try {
      const r = await one(c,
        "select catalog.image_key_referenced($1) as yes", ["products/de/ad/deadbeef.png"]);
      assert.equal(r.yes, false);
    } finally { await c.end(); }
  });
});

// ─────────────── who may change the catalogue ───────────────

describe("Permissions", () => {
  test("an operator cannot attach an image", async () => {
    const img = await putImage(PNG_2x1);
    const c = await as(AS.operatorShop1);
    try {
      await refused(
        () => c.query("select catalog.attach_product_image($1,$2,null,$3,$4,$5,$6,$7,null,null)",
          [productId, img.key, img.mime, img.bytes, img.width, img.height, img.checksum]),
        "FORBIDDEN_ROLE");
    } finally { await c.end(); }
  });

  test("an operator cannot delete one either", async () => {
    const c = await as(AS.operatorShop1);
    try {
      const any = await one(c, "select id from catalog.product_image limit 1");
      await refused(
        () => c.query("select catalog.remove_product_image($1)", [any.id]),
        "FORBIDDEN_ROLE");
    } finally { await c.end(); }
  });

  test("but an operator CAN see them — the catalogue is global", async () => {
    const c = await as(AS.operatorShop1);
    try {
      const rows = await q(c, "select id from catalog.product_image");
      assert.ok(rows.length > 0,
        "an operator must see product photos: they are how a person confirms " +
        "the box in their hand is the right one");
    } finally { await c.end(); }
  });

  test("a planner can", async () => {
    const c = await as(AS.planner);
    try {
      const img = await putImage(JPEG);
      const id = await one(c,
        "select catalog.attach_product_image($1,$2,null,$3,$4,$5,$6,$7,null,null) as id",
        [otherProductId, img.key, img.mime, img.bytes, img.width, img.height, img.checksum]);
      assert.ok(id.id);
    } finally { await c.end(); }
  });
});

// ─────────────── ordering ───────────────

describe("Gallery order", () => {
  test("images can be reordered, and the order is what the API returns", async () => {
    const c = await as(AS.admin);
    try {
      const before = (await q(c,
        `select id from catalog.product_image where product_id=$1
          order by position, created_at`, [otherProductId])).map((r) => r.id);
      assert.ok(before.length >= 2, "need at least two images to reorder");

      const reversed = [...before].reverse();
      const n = await one(c, "select catalog.reorder_product_images($1,$2::uuid[]) as n",
        [otherProductId, reversed]);
      assert.equal(Number(n.n), reversed.length);

      const after = (await q(c,
        `select id from catalog.product_image where product_id=$1
          order by position, created_at`, [otherProductId])).map((r) => r.id);
      assert.deepEqual(after, reversed);
    } finally { await c.end(); }
  });
});

// ─────────── staging: a photo before its product exists ───────────

describe("Adding a photograph while creating the product", () => {
  test("bytes can be stored before there is anything to attach them to", async () => {
    // The whole reason content addressing makes this work: the object
    // is identified by what it IS, not by what it belongs to.
    const staged = await putImage(PNG_2x1);
    assert.ok(staged.key);
    assert.ok(await storage().get(staged.key), "the staged bytes were not readable");
  });

  test("the product is created, then the staged photo is attached to it", async () => {
    const c = await as(AS.admin);
    try {
      const staged = await putImage(JPEG);

      const report = await one(c, "select * from catalog.import_products($1::jsonb)",
        [JSON.stringify([{ name: "Staged Photo Product", base_uom: "PCS" }])]);
      assert.equal(report.status, "CREATED");

      const id = await attachStagedImage(c, report.sku_code, {
        key: staged.key,
        thumbKey: null,
        alt: "staged before the product existed",
      });
      assert.ok(id);

      const row = await one(c,
        `select i.* from catalog.product_image i
           join catalog.product p on p.id = i.product_id
          where p.sku_code = $1`, [report.sku_code]);

      assert.equal(row.is_primary, true, "the first photo must be the primary one");
      assert.equal(row.alt_text, "staged before the product existed");
      assert.equal(row.mime, "image/jpeg");
    } finally { await c.end(); }
  });

  test("THE FACTS COME FROM THE BYTES, not from the form", async () => {
    const c = await as(AS.admin);
    try {
      const staged = await putImage(PNG_2x1);

      const report = await one(c, "select * from catalog.import_products($1::jsonb)",
        [JSON.stringify([{ name: "Honest Metadata Product", base_uom: "PCS" }])]);

      await attachStagedImage(c, report.sku_code, { key: staged.key });

      const row = await one(c,
        `select i.width, i.height, i.byte_size, i.mime, i.checksum
           from catalog.product_image i
           join catalog.product p on p.id = i.product_id
          where p.sku_code = $1`, [report.sku_code]);

      // The caller supplied NOTHING but a key. A form that could also
      // state the size would let a 20MB image be recorded as 2KB, and
      // every consumer sizing a layout would believe it.
      assert.equal(row.width, 2);
      assert.equal(row.height, 1);
      assert.equal(Number(row.byte_size), PNG_2x1.length);
      assert.equal(row.mime, "image/png");
      assert.equal(row.checksum, checksumOf(PNG_2x1));
    } finally { await c.end(); }
  });

  test("a key pointing at nothing is refused, not written as a broken image", async () => {
    const c = await as(AS.admin);
    try {
      const report = await one(c, "select * from catalog.import_products($1::jsonb)",
        [JSON.stringify([{ name: "Missing Bytes Product", base_uom: "PCS" }])]);

      await assert.rejects(
        () => attachStagedImage(c, report.sku_code, { key: "products/00/00/nothing.png" }),
        /IMAGE_NOT_STAGED/);

      const n = Number((await one(c,
        `select count(*)::int n from catalog.product_image i
           join catalog.product p on p.id = i.product_id
          where p.sku_code = $1`, [report.sku_code])).n);
      assert.equal(n, 0, "a row was written pointing at bytes that do not exist");
    } finally { await c.end(); }
  });

  test("a missing thumbnail degrades to the full image rather than breaking", async () => {
    const c = await as(AS.admin);
    try {
      const staged = await putImage(PNG_1x1);

      const report = await one(c, "select * from catalog.import_products($1::jsonb)",
        [JSON.stringify([{ name: "Absent Thumb Product", base_uom: "PCS" }])]);

      await attachStagedImage(c, report.sku_code, {
        key: staged.key,
        thumbKey: "products/00/00/not-there.png",
      });

      const row = await one(c,
        `select i.thumb_key from catalog.product_image i
           join catalog.product p on p.id = i.product_id
          where p.sku_code = $1`, [report.sku_code]);

      assert.equal(row.thumb_key, null,
        "a thumbnail key pointing at nothing renders as a broken picture in every listing");
    } finally { await c.end(); }
  });
});

// ─────────── the storage contract, whichever driver ───────────

describe("The storage driver contract", () => {
  test("a driver reports whether it can serve a public URL", () => {
    const d = storage();
    const url = d.publicUrl("products/aa/bb/cc.png");
    // Local has no public endpoint; Supabase does. Either is valid —
    // what matters is that the answer is null or a real URL, never a
    // path that only happens to work in one deployment.
    assert.ok(url === null || /^https?:\/\//.test(url), String(url));
  });

  test("the local driver is refused on Vercel", () => {
    // The failure it prevents is invisible in development and total in
    // production: the write succeeds and the file is gone by the next
    // request. Asserted against the real rule, not a restatement of
    // it — a test that reimplements its own condition still passes
    // when the code it checks is deleted.
    const d = chooseDriver({ VERCEL: "1" });
    assert.equal(d.name, "local");
    assert.match(d.refuse ?? "", /ephemeral/);
  });

  test("supabase without credentials refuses rather than falling back to disk", () => {
    const d = chooseDriver({ STORAGE_DRIVER: "supabase" });
    assert.match(d.refuse ?? "", /SUPABASE_SERVICE_ROLE_KEY/);

    const ok = chooseDriver({
      STORAGE_DRIVER: "supabase",
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
    });
    assert.equal(ok.refuse, undefined);
  });

  test("supabase is chosen automatically when a project is configured", () => {
    const d = chooseDriver({
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
    });
    assert.equal(d.name, "supabase");
    assert.equal(d.refuse, undefined);
  });
});
