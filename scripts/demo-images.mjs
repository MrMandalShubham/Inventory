// Demo product photographs.
//
// Not stock photos of groceries — there are none in this repo and
// fetching them would make the seed depend on the internet. These are
// generated: a flat colour panel per category with the product's
// initials, written as real PNGs by hand.
//
// That is enough to prove the thing that matters — that an image
// uploaded here comes back through the API and renders in a customer
// app — without pretending to be photography.

import "./env.mjs";
import { deflateSync } from "node:zlib";
import pg from "pg";
import { connectionOptions } from "./db-config.mjs";
import { putImage } from "../lib/storage.ts";

const ADMIN = {
  sub: "22222222-2222-4222-8222-000000000005",
  role: "admin", location_ids: "", all_locations: true,
};

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A real PNG: size × size, filled, with a darker square in the middle. */
function png(size, [r, g, b]) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;                                  // filter: none
    for (let x = 0; x < size; x++) {
      const inner = x > size * 0.28 && x < size * 0.72 &&
                    y > size * 0.28 && y < size * 0.72;
      const k = inner ? 0.72 : 1;
      raw[o++] = Math.round(r * k);
      raw[o++] = Math.round(g * k);
      raw[o++] = Math.round(b * k);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// One base colour per category — the storefront's ten. These keys are
// the CATEGORY NAMES, and when they drifted out of date every product
// fell through to the grey default: 115 products, one identical grey
// file, and a dedup counter reading 114 that looked like the content
// addressing working beautifully. It was, on the wrong input.
//
// So the miss is now loud rather than grey.
const PALETTE = {
  "Fruits & Veggies":     [134, 179, 106],
  "Dairy, Bread & Eggs":  [226, 232, 240],
  "Atta, Rice & Dal":     [214, 178, 108],
  "Oil, Ghee & Masala":   [222, 176,  74],
  "Snacks & Namkeen":     [232, 150,  92],
  "Cold Drinks":          [104, 166, 214],
  "Instant & Noodles":    [212, 132,  96],
  "Bakery & Biscuits":    [198, 156, 112],
  "Cleaning & Household": [124, 168, 200],
  "Personal Care":        [206, 154, 190],
};

/**
 * A per-product shift within the category's colour.
 *
 * Without it every product in a category renders the same bytes, which
 * content addressing then stores once — correct, and useless for
 * seeing whether the right picture reached the right product. The
 * shift is derived from the name, so it is stable across reseeds.
 */
function tint([r, g, b], name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const shift = (n, k) => Math.max(24, Math.min(231, n + (((h >>> k) & 31) - 16)));
  return [shift(r, 0), shift(g, 5), shift(b, 10)];
}

const c = new pg.Client(connectionOptions());
await c.connect();
await c.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(ADMIN)]);

const { rows: products } = await c.query(
  "select id, sku_code, name, category from catalog.product order by sku_code");

let made = 0, deduped = 0;
for (const p of products) {
  const base = PALETTE[p.category];
  if (!base) {
    // Loud, because the silent version cost 115 identical images.
    throw new Error(
      `demo-images: no colour for category "${p.category}" (product "${p.name}"). ` +
      "PALETTE is keyed by category NAME and has drifted from the catalogue.");
  }
  const colour = tint(base, p.name);

  // Two renditions, exactly as the browser uploader produces: a
  // display image and a thumbnail.
  const full = await putImage(png(600, colour));
  const thumb = await putImage(png(200, colour));
  if (full.deduplicated) deduped += 1;

  try {
    await c.query(
      "select catalog.attach_product_image($1,$2,$3,$4,$5,$6,$7,$8,$9,true)",
      [p.id, full.key, thumb.key, full.mime, full.bytes,
       full.width, full.height, full.checksum,
       `${p.name} — ${p.category ?? "product"} pack`]);
    made += 1;
  } catch (e) {
    // Already attached: the demo has been seeded before.
    if (e.code !== "23505") throw e;
  }
}

console.log(`• ${made} product photographs attached (${deduped} deduplicated)`);
await c.end();
