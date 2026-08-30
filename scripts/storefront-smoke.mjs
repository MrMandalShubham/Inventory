// HTTP smoke test for the storefront API.
//
//   npm run dev              # in one terminal
//   npm run storefront:smoke # in another
//
// The database layer is proved by tests/phase9.test.mjs. This
// exercises what only a real request can: the exact JSON shape the
// selling app will parse, the status codes it will branch on, and the
// key scoping it depends on.

import "./env.mjs";
import pg from "pg";
import { connectionOptions } from "./db-config.mjs";

const BASE = process.env.STOREFRONT_BASE ?? "http://127.0.0.1:3100";
const ADMIN = { sub: "22222222-2222-4222-8222-000000000005", role: "admin",
                location_ids: "", all_locations: true };

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✖ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

const db = new pg.Client(connectionOptions());
await db.connect();
await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(ADMIN)]);

const shop = (await db.query("select id, code from platform.location where code='SH1'")).rows[0];

// A storefront key: bound to ONE shop, and without cost:read.
const key = (await db.query(
  `select * from platform.create_api_client('Storefront smoke',
     array['catalog:read','catalog:write','pricing:write','stock:read','reservations:write'],
     $1::uuid[], 'LIVE')`, [[shop.id]])).rows[0];

// And one that may see cost, to prove the difference.
const costKey = (await db.query(
  `select * from platform.create_api_client('Storefront cost',
     array['catalog:read','cost:read'], $1::uuid[], 'LIVE')`, [[shop.id]])).rows[0];

const H = (k) => ({ Authorization: `Bearer ${k}`, "Content-Type": "application/json" });
const call = async (path, opts = {}) => {
  const res = await fetch(BASE + path, opts);
  let body = null;
  try { body = await res.json(); } catch { /* empty */ }
  return { status: res.status, body };
};

console.log(`\nStorefront API — ${BASE}\n`);

// ── auth ──
console.log("Authentication");
{
  const none = await call("/api/products");
  ok("no key is 401", none.status === 401, `got ${none.status}`);
  ok("and says to keep the key server-side",
    /never from the browser/i.test(none.body?.message ?? ""), none.body?.message);

  const bad = await call("/api/products", { headers: H("ic_live_nope") });
  ok("a bad key is 401", bad.status === 401);
}

// ── locations ──
console.log("\nLocations");
let locations;
{
  const r = await call("/api/locations", { headers: H(key.api_key) });
  locations = r.body;
  ok("returns the shops", r.status === 200 && Array.isArray(r.body) && r.body.length > 0,
    JSON.stringify(r.body)?.slice(0, 120));
  ok("each carries an id the storefront can send back",
    r.body?.every?.((l) => typeof l.id === "string"));
}

// ── categories ──
console.log("\nCategories");
{
  const r = await call("/api/categories?location=SH1", { headers: H(key.api_key) });
  ok("returns categories", r.status === 200 && Array.isArray(r.body));
  ok("shaped as { id, name, icon }",
    r.body?.every?.((c) => "id" in c && "name" in c && "icon" in c),
    JSON.stringify(r.body?.[0]));
  ok("the id is a usable slug",
    r.body?.every?.((c) => /^[a-z0-9-]+$/.test(c.id)),
    r.body?.map((c) => c.id).join(", "));
}

// ── products ──
console.log("\nProducts");
let sample;
{
  const r = await call("/api/products?location=SH1&limit=5", { headers: H(key.api_key) });
  sample = r.body?.[0];
  ok("returns products", r.status === 200 && Array.isArray(r.body) && r.body.length > 0);

  const want = ["id","sku","name","category","unit","retailPrice","mrp","stock","image_url"];
  ok("carries every field the storefront asked for",
    want.every((f) => sample && f in sample),
    `missing: ${want.filter((f) => sample && !(f in sample)).join(", ")}`);

  ok("stock is a number, per location", typeof sample?.stock === "number",
    `got ${typeof sample?.stock}`);

  ok("COST IS ABSENT without the cost:read scope", !("cost" in (sample ?? {})),
    "landed cost leaked to a key that may not see it — that publishes your margin");

  const withCost = await call("/api/products?location=SH1&limit=1", { headers: H(costKey.api_key) });
  ok("and present with it", "cost" in (withCost.body?.[0] ?? {}));

  const search = await call("/api/products?location=SH1&search=dal", { headers: H(key.api_key) });
  ok("search filters", search.status === 200 && Array.isArray(search.body));

  const cat = await call(`/api/products?location=SH1&category=${sample?.category}`,
    { headers: H(key.api_key) });
  ok("category filters",
    cat.status === 200 && cat.body.every?.((p) => p.category === sample?.category));
}

// ── one product ──
console.log("\nSingle product");
{
  const bySlug = await call(`/api/products/${sample.slug}?location=SH1`, { headers: H(key.api_key) });
  ok("fetch by SEO slug", bySlug.status === 200 && bySlug.body?.sku === sample.sku,
    `${bySlug.status} ${bySlug.body?.sku}`);

  const bySku = await call(`/api/products/${sample.sku}?location=SH1`, { headers: H(key.api_key) });
  ok("fetch by SKU code", bySku.status === 200 && bySku.body?.slug === sample.slug);

  const missing = await call("/api/products/no-such-thing", { headers: H(key.api_key) });
  ok("unknown product is 404", missing.status === 404);
}

// ── pricing ──
console.log("\nPricing");
{
  const set = await call(`/api/products/${sample.sku}`, {
    method: "PUT", headers: H(key.api_key),
    body: JSON.stringify({ retailPrice: 41.5, mrp: 45, wholesalePrice: 35 }),
  });
  ok("a price can be set", set.status === 200 && set.body?.retailPrice === 41.5,
    JSON.stringify(set.body));

  const read = await call(`/api/products/${sample.sku}?location=SH1`, { headers: H(key.api_key) });
  ok("and reads back", read.body?.retailPrice === 41.5 && read.body?.mrp === 45);

  const illegal = await call(`/api/products/${sample.sku}`, {
    method: "PUT", headers: H(key.api_key),
    body: JSON.stringify({ retailPrice: 99, mrp: 45 }),
  });
  ok("selling above MRP is refused", illegal.status >= 400, `got ${illegal.status}`);
}

// ── the order lifecycle ──
console.log("\nOrder lifecycle");
const ORDER = "smoke-" + Date.now();
{
  // Two different numbers, and mixing them is easy: the API returns
  // AVAILABLE (what may be promised), the database holds ON_HAND
  // (what is physically there). A hold moves the first and not the
  // second; a delivery moves both.
  const before = (await call(`/api/products/${sample.sku}?location=SH1`,
    { headers: H(key.api_key) })).body.stock;

  const onHandBefore = (await db.query(
    `select b.on_hand from stock.balance b join catalog.product p on p.id=b.product_id
      where p.sku_code=$1 and b.location_id=$2`, [sample.sku, shop.id])).rows[0].on_hand;

  const r = await call("/api/inventory/reserve", {
    method: "POST", headers: H(key.api_key),
    body: JSON.stringify({ order_id: ORDER, location: "SH1",
                           items: [{ sku: sample.sku, quantity: 2 }] }),
  });
  ok("reserve holds the order", r.status === 201 && r.body?.ok === true,
    JSON.stringify(r.body)?.slice(0, 160));

  const after = (await call(`/api/products/${sample.sku}?location=SH1`,
    { headers: H(key.api_key) })).body.stock;
  ok("held stock is no longer sellable", after === before - 2, `${before} → ${after}`);

  const retry = await call("/api/inventory/reserve", {
    method: "POST", headers: H(key.api_key),
    body: JSON.stringify({ order_id: ORDER, location: "SH1",
                           items: [{ sku: sample.sku, quantity: 2 }] }),
  });
  const still = (await call(`/api/products/${sample.sku}?location=SH1`,
    { headers: H(key.api_key) })).body.stock;
  ok("a retry does not hold it twice", still === after, `${after} → ${still}`);
  void retry;

  const status = await call(`/api/inventory/order/${ORDER}`, { headers: H(key.api_key) });
  ok("order status says 'held'", status.body?.status === "held", JSON.stringify(status.body));

  const short = await call("/api/inventory/reserve", {
    method: "POST", headers: H(key.api_key),
    body: JSON.stringify({ order_id: ORDER + "-short", location: "SH1",
                           items: [{ sku: sample.sku, quantity: 1 },
                                   { sku: sample.sku, quantity: 999999 }] }),
  });
  ok("a short line refuses the WHOLE order with 409", short.status === 409,
    `got ${short.status}`);
  ok("and lists every line so a substitute can be offered",
    Array.isArray(short.body?.items) && short.body.items.length === 2);

  const commit = await call("/api/inventory/commit", {
    method: "POST", headers: H(key.api_key),
    body: JSON.stringify({ order_id: ORDER }),
  });
  ok("commit delivers it", commit.status === 200 && commit.body?.ok);
  ok("and writes a ledger entry",
    Number(commit.body?.items?.[0]?.ledger_entry_id) > 0,
    JSON.stringify(commit.body?.items?.[0]));

  const onHandAfter = (await db.query(
    `select b.on_hand from stock.balance b join catalog.product p on p.id=b.product_id
      where p.sku_code=$1 and b.location_id=$2`, [sample.sku, shop.id])).rows[0].on_hand;
  ok("the goods actually left the shelf", onHandAfter === onHandBefore - 2,
    `on_hand ${onHandBefore} → ${onHandAfter}, expected a drop of 2`);

  const again = await call("/api/inventory/commit", {
    method: "POST", headers: H(key.api_key),
    body: JSON.stringify({ order_id: ORDER }),
  });
  ok("committing twice does not reduce stock twice",
    again.status === 200 && again.body?.already_committed === true);
}

// ── cancellation ──
console.log("\nCancellation");
{
  const O = "smoke-cancel-" + Date.now();
  await call("/api/inventory/reserve", {
    method: "POST", headers: H(key.api_key),
    body: JSON.stringify({ order_id: O, location: "SH1",
                           items: [{ sku: sample.sku, quantity: 1 }] }),
  });
  const held = (await call(`/api/products/${sample.sku}?location=SH1`,
    { headers: H(key.api_key) })).body.stock;

  const rel = await call("/api/inventory/release", {
    method: "POST", headers: H(key.api_key),
    body: JSON.stringify({ order_id: O, reason: "customer cancelled" }),
  });
  ok("release returns the stock", rel.status === 200 && rel.body?.released === 1);

  const back = (await call(`/api/products/${sample.sku}?location=SH1`,
    { headers: H(key.api_key) })).body.stock;
  ok("and it is sellable again", back === held + 1, `${held} → ${back}`);
}

// ── the boundary ──
console.log("\nWhat the storefront may not do");
{
  const other = (await db.query("select code from platform.location where code='HUB'")).rows[0];

  const r = await call("/api/inventory/reserve", {
    method: "POST", headers: H(key.api_key),
    body: JSON.stringify({ order_id: "smoke-hub-" + Date.now(), location: other.code,
                           items: [{ sku: sample.sku, quantity: 1 }] }),
  });
  ok("cannot hold stock at a shop its key does not cover", r.status === 403,
    `got ${r.status} ${JSON.stringify(r.body)?.slice(0, 90)}`);

  const noScope = await call("/api/inventory/reserve", {
    method: "POST", headers: H(costKey.api_key),
    body: JSON.stringify({ order_id: "x", location: "SH1", items: [] }),
  });
  ok("a read-only key cannot reserve", noScope.status === 403);
}

const drift = (await db.query("select count(*)::int n from stock.verify_reservations()")).rows[0].n;
ok("the reserved counter still agrees with live holds", drift === 0, `${drift} drifted`);

await db.end();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
