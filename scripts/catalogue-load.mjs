// Bring a database's catalogue up to date, without emptying it.
//
//   npm run catalogue:load                       # local container
//   npm run catalogue:load -- --target=<host>    # a real project
//
// ── Why this is not the seed ──
//
// seed.mjs truncates and rebuilds. That is right for a test database
// and wrong for a deployed one, which has real stock counts, movement
// tickets, ledger history and API clients that nobody wants to lose to
// a catalogue change.
//
// So this only ADDS: the ten categories, any product missing by name,
// its price and pack size, and opening stock for products that have
// none anywhere. It never deletes, never re-prices a product that
// already has a price, and never touches a balance that already
// exists.
//
// ── Matching is by NAME, deliberately ──
//
// catalog.import_products() matches on sku_code, and a row without one
// is always an insert — so running it twice over this list would
// create a hundred duplicate products with fresh SKUs. Name is the
// only stable identity these rows have before they exist.

import "./env.mjs";
import pg from "pg";
import { CONNECTION, isLocal, connectionOptions } from "./db-config.mjs";
import { CATEGORIES, PRODUCTS, countByCategory } from "./catalogue.mjs";

const ADMIN = {
  sub: "22222222-2222-4222-8222-000000000005",
  role: "admin", location_ids: "", all_locations: true,
};

let host = "?";
try { host = new URL(CONNECTION).hostname; } catch { /* unparseable */ }

// Additive, so this is nothing like as dangerous as a seed — but it
// does write to the catalogue every app reads, and doing that to a
// production project by accident is still worth one deliberate act.
if (!isLocal(CONNECTION) && !process.argv.includes(`--target=${host}`)) {
  console.error(`
  REFUSING — name the host you mean to write to.

    npm run catalogue:load -- --target=${host}

  This adds categories, products, prices and opening stock. It deletes
  nothing and re-prices nothing that already has a price.
`);
  process.exit(1);
}

const c = new pg.Client(connectionOptions());
await c.connect();
await c.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(ADMIN)]);

console.log(`\nCatalogue → ${host}\n`);

// ── the ten categories ──
//
// Before the products, so ensure_category() finds them already there
// rather than creating them without an icon or a position.
for (const [i, cat] of CATEGORIES.entries()) {
  await c.query(`
    insert into catalog.category (id, name, icon, position)
         values ($1, $2, $3, $4)
    on conflict (id) do update
       set name = excluded.name, icon = excluded.icon,
           position = excluded.position, status = 'ACTIVE'`,
    [cat.id, cat.name, cat.icon, i + 1]);
}
console.log(`• ${CATEGORIES.length} categories`);

// ── products ──
const existing = new Set((await c.query(
  "select name from catalog.product")).rows.map((r) => r.name));

const missing = PRODUCTS.filter((p) => !existing.has(p.name));

if (missing.length > 0) {
  const rows = missing.map((p) => ({
    name: p.name, category: p.category, base_uom: p.base_uom,
    tracking_mode: p.tracking_mode, hsn_code: p.hsn_code, tax_rate: p.tax_rate,
    ...(p.shelf_life_days ? { shelf_life_days: p.shelf_life_days } : {}),
    ...(p.is_weighed ? { is_weighed: true } : {}),
    ...(p.barcode ? { barcode: p.barcode } : {}),
  }));

  const { rows: report } = await c.query(
    "select * from catalog.import_products($1::jsonb)", [JSON.stringify(rows)]);

  const failed = report.filter((r) => r.status === "FAILED");
  if (failed.length) {
    console.error("\nproducts failed:");
    for (const f of failed.slice(0, 10)) console.error(`  ${f.sku_code}: ${f.message}`);
    throw new Error(`${failed.length} product(s) could not be created`);
  }
  console.log(`• ${report.length} products added`);
} else {
  console.log("• products already present");
}

// ── re-file anything still under an old category name ──
//
// A database migrated from before 0052 has products carrying the old
// free text. Writing `category` rather than category_id lets the
// ensure_category trigger resolve the id, so the two cannot disagree.
const refiled = await c.query(`
  update catalog.product set category = case category
      when 'Staples'     then 'Atta, Rice & Dal'
      when 'Dairy'       then 'Dairy, Bread & Eggs'
      when 'Fruit & Veg' then 'Fruits & Veggies'
      when 'Beauty'      then 'Personal Care'
      when 'Household'   then 'Cleaning & Household'
      else category
    end
   where category in ('Staples','Dairy','Fruit & Veg','Beauty','Household')
   returning 1`);
if (refiled.rowCount > 0) console.log(`• ${refiled.rowCount} products re-filed from old categories`);

// ── and correct anything the coarse mapping got wrong ──
//
// Migration 0052 maps five old names onto five new ones. That is right
// for fourteen of the fifteen products that existed, and wrong for
// Refined Sunflower Oil 1L, which was filed under Staples and belongs
// in Oil, Ghee & Masala — a blanket rename cannot know that, because
// the old category genuinely held both.
//
// This list knows, by name. Only products IN it are touched: anything
// added by hand keeps whatever category somebody chose for it.
let moved = 0;
for (const p of PRODUCTS) {
  const { rowCount } = await c.query(
    `update catalog.product set category = $2
      where name = $1 and category is distinct from $2`, [p.name, p.category]);
  moved += rowCount;
}
if (moved > 0) console.log(`• ${moved} products moved to the aisle this list puts them in`);

// ── prices and pack sizes ──
//
// pack_size is always corrected; a price is only SET where none
// exists. Overwriting a price would silently undo whatever the shop
// decided since the last run, which is exactly the kind of change
// nobody notices until a customer is charged the wrong amount.
let priced = 0, repacked = 0;
for (const p of PRODUCTS) {
  const { rows } = await c.query(
    "select id, pack_size from catalog.product where name = $1", [p.name]);
  if (!rows[0]) continue;

  if (rows[0].pack_size !== p.pack) {
    await c.query("update catalog.product set pack_size = $2 where id = $1",
      [rows[0].id, p.pack]);
    repacked += 1;
  }

  const { rows: has } = await c.query(
    "select 1 from catalog.price where product_id = $1 and location_id is null", [rows[0].id]);

  if (has.length === 0) {
    await c.query("select catalog.set_price($1,$2,$3,$4)",
      [rows[0].id, p.retailPaise, p.mrpPaise, p.wholesalePaise]);
    priced += 1;
  }
}
console.log(`• ${priced} prices set, ${repacked} pack sizes corrected`);

// ── opening stock, only where there is none ──
//
// A product with no balance row anywhere has never been counted, so an
// opening balance is the honest way to give it a starting quantity. A
// product that already has one is left alone: its quantity is the sum
// of a ledger, and writing another opening line would add to it rather
// than correct it.
const { rows: stockless } = await c.query(`
  select p.sku_code, p.name
    from catalog.product p
   where not exists (select 1 from stock.balance b where b.product_id = p.id)
   order by p.sku_code`);

if (stockless.length > 0) {
  const packBase = Object.fromEntries(PRODUCTS.map((p) => [p.name, p.packBase]));
  const cost = Object.fromEntries(PRODUCTS.map((p) => [p.name, p.unitCostPaise]));

  const locations = (await c.query(
    "select code from platform.location where status='ACTIVE' and type <> 'VIRTUAL' order by code"
  )).rows.map((r) => r.code);

  const balances = [];
  stockless.forEach((s, i) => {
    const per = packBase[s.name];
    const unit = cost[s.name];
    // A product this script does not know about — added by hand
    // through the UI. Leave it alone rather than invent a cost for it.
    if (!per || !unit) return;

    for (const [n, code] of locations.entries()) {
      // Counted in packs, converted at the last moment. See seed.mjs.
      const packs = code === "HUB" ? 60 + (i % 11) * 9 : 12 + ((i + n) % 7) * 5;
      balances.push({ sku_code: s.sku_code, location_code: code,
                      on_hand: packs * per, unit_cost_paise: unit });
    }
  });

  if (balances.length > 0) {
    const { rows: bal } = await c.query(
      "select * from stock.import_opening_balances($1::jsonb)", [JSON.stringify(balances)]);
    const bad = bal.filter((r) => r.status === "FAILED");
    if (bad.length) {
      console.error("\nopening balances failed:");
      for (const b of bad.slice(0, 5)) console.error(`  ${b.sku_code}: ${b.message}`);
      throw new Error(`${bad.length} opening balance(s) rejected`);
    }
    console.log(`• ${bal.length} opening stock lines across ${locations.length} locations`);
  }
} else {
  console.log("• every product already has stock somewhere");
}

// ── what the storefront will now see ──
const summary = await c.query(`
  select c.name, count(p.id)::int as products
    from catalog.category c
    left join catalog.product p on p.category_id = c.id and p.status = 'ACTIVE'
   where c.status = 'ACTIVE'
   group by c.id, c.name, c.position
   order by c.position`);

console.log("");
for (const r of summary.rows) {
  console.log(`    ${r.name.padEnd(22)} ${String(r.products).padStart(3)}`);
}

const stray = await c.query(`
  select distinct p.category
    from catalog.product p
   where p.category is not null
     and (p.category_id is null
          or p.category_id not in (select id from catalog.category where status='ACTIVE'))`);

if (stray.rows.length > 0) {
  console.log(`
  Outside the ten, left as they are:
    ${stray.rows.map((r) => r.category).join(", ")}

  Re-file them from the catalogue screen. Moving them automatically
  would mean guessing, and a product in the wrong aisle is worse than
  one visibly in none.`);
}

console.log(`\nDone. ${countByCategory().size} categories, ${PRODUCTS.length} products in the list.\n`);
await c.end();
