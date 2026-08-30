// Demo data for the working UI.
//
// Separate from the test fixtures in tests/harness.mjs: the tests
// need a small, exact world they can assert against, this needs
// enough variety that the screens show something worth looking at.

import pg from "pg";
import "./env.mjs";
import {
  assertConfirmedTarget, assertTruncateCannotEscape, connectionOptions, CONNECTION,
} from "./db-config.mjs";

// Rebuilds the world from nothing, starting with a TRUNCATE of every
// inventory table. Against a deployed database that is a deliberate
// act, so the host has to be named on the command line.
assertConfirmedTarget("the demo seed", process.argv);

const c = new pg.Client(connectionOptions());
await c.connect();

// And CASCADE must not be able to reach out of our schemas into the
// customer app's tables. Re-checked every run — see db-config.mjs.
await assertTruncateCannotEscape(c);

try {
  console.log(`\nSeeding ${new URL(CONNECTION).hostname}\n`);
} catch { /* unparseable */ }

const ADMIN = { sub: "22222222-2222-4222-8222-000000000005", role: "admin", location_ids: "", all_locations: true };
// Deepa. Separation of duties is real — the person who raises a
// movement may not approve it, so the seed has to change hats too.
const PLANNER = { sub: "22222222-2222-4222-8222-000000000004", role: "planner", location_ids: "", all_locations: true };

const asUser = (claims) =>
  c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);

try {
  await c.query("begin");

  // TRUNCATE, not DELETE. From Phase 2 the ledger refuses row
  // deletion, so DELETE would wipe the balances and leave their
  // ledger entries behind — and every screen would then show a drift
  // warning caused by the seed script itself.
  await c.query(`
    truncate ledger.entry, ledger.journal,
               alerting.alert,
               insight.product_metric, insight.policy,
               platform.session, platform.credential,
             platform.idempotency_record, platform.api_request,
               platform.webhook_delivery, platform.webhook_subscription,
               platform.api_client,
               stock.reservation,
               movement.document, movement.line, movement.movement,
             stock.ledger, stock.count_line, stock.count_sheet,
             stock.idempotency, stock.balance, stock.serial, stock.batch,
             catalog.product_barcode, catalog.product_uom, catalog.product,
             partner.partner,
             platform.user_location, platform.app_user, platform.location,
             platform.counter
      restart identity cascade
  `);

  await c.query(`
    insert into platform.location (id, code, name, type) values
      ('11111111-1111-4111-8111-000000000001','HUB','Central Warehouse','HUB'),
      ('11111111-1111-4111-8111-000000000002','SH1','Shop 1 — Andheri','STORE'),
      ('11111111-1111-4111-8111-000000000003','SH2','Shop 2 — Bandra','STORE'),
      ('11111111-1111-4111-8111-000000000004','SH3','Shop 3 — Dadar','STORE'),
      -- Recreated after the truncate: migration 0016 seeds it, and the
      -- movement functions cannot work without it.
      ('11111111-1111-4111-8111-00000000000e','TRANSIT','In transit — owned by nobody','VIRTUAL')
  `);

  // all_locations is an explicit grant, never inferred from the role —
  // see migration 0009. Priya is a regional planner without it, which
  // is what makes the location boundary visible in the UI.
  await c.query(`
    insert into platform.app_user (id, email, full_name, role, all_locations) values
      ('22222222-2222-4222-8222-000000000001','arun@example.com','Arun Patil','operator',false),
      ('22222222-2222-4222-8222-000000000002','meena@example.com','Meena Shah','shop_manager',false),
      ('22222222-2222-4222-8222-000000000003','rahul@example.com','Rahul Nair','shop_manager',false),
      ('22222222-2222-4222-8222-000000000006','priya@example.com','Priya Rao','planner',false),
      ('22222222-2222-4222-8222-000000000004','deepa@example.com','Deepa Iyer','planner',true),
      ('22222222-2222-4222-8222-000000000005','admin@example.com','System Admin','admin',true)
  `);

  await c.query(`
    insert into platform.user_location (user_id, location_id) values
      ('22222222-2222-4222-8222-000000000001','11111111-1111-4111-8111-000000000002'),
      ('22222222-2222-4222-8222-000000000002','11111111-1111-4111-8111-000000000002'),
      ('22222222-2222-4222-8222-000000000003','11111111-1111-4111-8111-000000000003'),
      ('22222222-2222-4222-8222-000000000006','11111111-1111-4111-8111-000000000002'),
      ('22222222-2222-4222-8222-000000000006','11111111-1111-4111-8111-000000000004')
  `);

  await c.query(`
    insert into partner.partner (name, kinds, gstin, phone, credit_days, lead_time_days) values
      ('Shree Agro Traders',      array['SUPPLIER'],            '27AABCS1429B1Z1','9820011223',30,3),
      ('Konkan Dairy Co-op',      array['SUPPLIER'],            '27AAACK5055K1Z2','9820022334',15,1),
      ('Vashi Mandi — Lot 14',    array['SUPPLIER'],            null,             '9820033445', 0,1),
      ('Nirmal Home Care Pvt Ltd',array['SUPPLIER','CUSTOMER'], '27AADCN2109R1Z9','9820044556',45,7),
      ('Sunrise Caterers',        array['CUSTOMER'],            '27AAFCS8821M1ZK','9820055667',15,null),
      ('Speedlink Logistics',     array['CARRIER'],             '27AAGCS3310P1ZB','9820066778',null,null)
  `);

  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(ADMIN)]);

  // Demo passwords. Everyone gets the same one — this is seed data
  // for a local container, and pretending otherwise would just mean
  // six things to remember.
  await c.query(`
    insert into platform.credential (user_id, password_hash)
    select id, crypt('inventory', gen_salt('bf', 10)) from platform.app_user
  `);

  // Landed cost per unit of the base UoM, in paise. Grocery margins
  // are thin and these are roughly real, so the money screens show
  // numbers a shopkeeper would recognise rather than round demo
  // figures that hide arithmetic mistakes.
  const COST = {
    "Toor Dal 1kg": 14, "Basmati Rice 5kg": 12, "Atta 10kg": 4,
    "Refined Sunflower Oil 1L": 13, "Full Cream Milk 500ml": 6, "Curd 400g": 8,
    "Paneer 200g": 42, "Tomatoes": 3, "Onions": 3, "Bananas": 5,
    "Face Wash 100ml": 95, "Shampoo 340ml": 62, "Dishwash Bar 200g": 9,
    "Floor Cleaner 1L": 11, "Steel Water Bottle 1L": 32000,
  };

  const products = [
    { name: "Toor Dal 1kg",           category: "Staples",     base_uom: "G",   barcode: "8901234500011", hsn_code: "0713" },
    { name: "Basmati Rice 5kg",       category: "Staples",     base_uom: "G",   barcode: "8901234500028", hsn_code: "1006" },
    { name: "Atta 10kg",              category: "Staples",     base_uom: "G",   barcode: "8901234500035", hsn_code: "1101" },
    { name: "Refined Sunflower Oil 1L", category: "Staples",   base_uom: "ML",  barcode: "8901234500042", hsn_code: "1512" },
    { name: "Full Cream Milk 500ml",  category: "Dairy",       base_uom: "ML",  tracking_mode: "BATCH", shelf_life_days: 5,   hsn_code: "0401", barcode: "8901234500059" },
    { name: "Curd 400g",              category: "Dairy",       base_uom: "G",   tracking_mode: "BATCH", shelf_life_days: 7,   hsn_code: "0403", barcode: "8901234500066" },
    { name: "Paneer 200g",            category: "Dairy",       base_uom: "G",   tracking_mode: "BATCH", shelf_life_days: 10,  hsn_code: "0406" },
    { name: "Tomatoes",               category: "Fruit & Veg", base_uom: "G",   tracking_mode: "BATCH", shelf_life_days: 4,   is_weighed: true, hsn_code: "0702" },
    { name: "Onions",                 category: "Fruit & Veg", base_uom: "G",   tracking_mode: "BATCH", shelf_life_days: 21,  is_weighed: true, hsn_code: "0703" },
    { name: "Bananas",                category: "Fruit & Veg", base_uom: "G",   tracking_mode: "BATCH", shelf_life_days: 6,   is_weighed: true, hsn_code: "0803" },
    { name: "Face Wash 100ml",        category: "Beauty",      base_uom: "ML",  tracking_mode: "BATCH", shelf_life_days: 540, hsn_code: "3304", barcode: "8901234500073" },
    { name: "Shampoo 340ml",          category: "Beauty",      base_uom: "ML",  tracking_mode: "BATCH", shelf_life_days: 730, hsn_code: "3305", barcode: "8901234500080" },
    { name: "Dishwash Bar 200g",      category: "Household",   base_uom: "G",   barcode: "8901234500097", hsn_code: "3401" },
    { name: "Floor Cleaner 1L",       category: "Household",   base_uom: "ML",  barcode: "8901234500103", hsn_code: "3402" },
    { name: "Steel Water Bottle 1L",  category: "Household",   base_uom: "PCS", tracking_mode: "SERIAL", hsn_code: "7323", barcode: "8901234500110" },
  ];

  const { rows: report } = await c.query(
    "select * from catalog.import_products($1::jsonb)", [JSON.stringify(products)]);
  const failed = report.filter((r) => r.status === "FAILED");
  if (failed.length) {
    console.error("seed products failed:", failed);
    throw new Error("seed data is invalid");
  }

  // Opening balances. Deliberately uneven so the location boundary is
  // obvious the moment you switch persona.
  const { rows: skus } = await c.query(
    "select sku_code, name from catalog.product order by sku_code");
  const balances = [];
  skus.forEach((s, i) => {
    // Opening stock states what it cost, so the valuation and the
    // trial balance have something true to show. A line with no cost
    // would enter at no value — see migration 0032.
    const cost = COST[s.name];
    const at = (location_code, on_hand) =>
      balances.push({ sku_code: s.sku_code, location_code, on_hand, unit_cost_paise: cost });

    at("HUB", 400 + i * 37);
    if (i % 3 !== 2) at("SH1", 20 + i * 11);
    if (i % 2 === 0) at("SH2", 45 + i * 7);
    if (i % 4 === 0) at("SH3", 12 + i * 5);
  });

  const { rows: bal } = await c.query(
    "select * from stock.import_opening_balances($1::jsonb)", [JSON.stringify(balances)]);
  const badBal = bal.filter((r) => r.status === "FAILED");
  if (badBal.length) {
    console.error("seed balances failed:", badBal.slice(0, 5));
    throw new Error("seed balances are invalid");
  }

  const loc = Object.fromEntries((await c.query(
    "select code, id from platform.location")).rows.map((r) => [r.code, r.id]));
  const bySku = Object.fromEntries((await c.query(
    "select name, id from catalog.product")).rows.map((r) => [r.name, r.id]));

  // ─────────────── a trading history ───────────────
  //
  // Demand is measured over a 28-day window (insight.setting). A
  // database seeded only with today has no history, so average daily
  // demand is zero, days of cover is infinite, every reorder point is
  // zero and the alert engine finds nothing. Every demand-and-supply
  // screen in the product renders correctly and says nothing.
  //
  // So the shops trade. Six untracked staples across three shops,
  // forty days of receipts and daily sales, with a weekend lift and
  // enough noise that the standard deviation — and therefore safety
  // stock — is a real number rather than zero.

  await asUser(ADMIN);

  // The last number is how many days of cover the shop is LEFT with.
  // It is what makes the shops differ from each other: a demo where
  // every line is comfortably stocked raises no alerts, shows no
  // reorder suggestions and demonstrates nothing. Real shops are
  // short of some things and sitting on far too much of others.
  //
  // Stated as the ending position rather than the opening one,
  // because the opening quantity is not knowable in advance — the
  // weekend lift means forty days of trading consumes about
  // forty-five days of average demand, and guessing at that put the
  // shelf below zero.
  const HISTORY = [
    // name,                    shop,  units/day, volatility, days left
    ["Toor Dal 1kg",            "SH1", 1400, 0.30,  22],   // healthy
    ["Basmati Rice 5kg",        "SH1",  900, 0.45,   4],   // getting low
    ["Atta 10kg",               "SH1", 2100, 0.25,   1],   // nearly out
    ["Refined Sunflower Oil 1L","SH1",  700, 0.35,  18],
    ["Dishwash Bar 200g",       "SH1",  260, 0.55, 130],   // far too much
    ["Toor Dal 1kg",            "SH2", 1100, 0.30,   5],   // getting low
    ["Atta 10kg",               "SH2", 1600, 0.28,  24],
    ["Floor Cleaner 1L",        "SH2",  180, 0.60, 150],   // far too much
    ["Basmati Rice 5kg",        "SH3",  450, 0.40,  16],
    ["Toor Dal 1kg",            "SH3",  380, 0.35,   6],   // getting low
  ];

  const DAYS = 40;
  let issued = 0;

  for (const [name, shop, daily, vol, daysLeft] of HISTORY) {
    const pid = bySku[name];
    if (!pid) continue;

    // Work out the whole trading pattern first, so the opening
    // receipt can be sized to it exactly.
    const sales = [];
    for (let d = DAYS; d >= 1; d--) {
      const day = new Date(Date.now() - d * 86400000).getDay();
      // A shop is busier at the weekend. Without that the standard
      // deviation is pure noise and safety stock means nothing.
      const lift = day === 0 ? 1.6 : day === 6 ? 1.3 : 1;
      sales.push({
        d,
        qty: Math.max(1, Math.round(daily * lift * (1 + vol * (Math.random() - 0.5) * 2))),
      });
    }

    const sold = sales.reduce((a, x) => a + x.qty, 0);

    await c.query(
      `select stock.post_movement($1,$2,$3,'RECEIPT',null,'opening consignment',null,$4,
                                  now() - make_interval(days => $5))`,
      [pid, loc[shop], sold + daily * daysLeft, COST[name], DAYS + 2]);

    for (const { d, qty } of sales) {
      await c.query(
        `select stock.post_movement($1,$2,$3,'ISSUE',null,'counter sales',null,null,
                                    now() - make_interval(days => $4))`,
        [pid, loc[shop], -qty, d]);
      issued += 1;
    }
  }

  // ─────────────── the API, with something on it ───────────────
  //
  // The usage screen answers "which app is about to become everyone
  // else's problem". With no keys and no traffic it answers nothing,
  // so the demo carries two applications with different shapes: a
  // busy storefront, and a reporting job that is quietly hitting its
  // ceiling.

  await asUser(ADMIN);

  const storefront = (await c.query(
    `select * from platform.create_api_client('Storefront app',
       array['catalog:read','stock:read','reservations:write'], '{}', 'LIVE', 600)`)).rows[0];
  const reporter = (await c.query(
    `select * from platform.create_api_client('Nightly reporting job',
       array['stock:read','movements:read'], '{}', 'LIVE', 60)`)).rows[0];

  // A subscriber, so event delivery has a subject. Deliberately
  // pointed at a URL that does not answer: the screen should show
  // what a broken integration looks like, which is the state anybody
  // reading it is trying to recognise.
  await c.query(
    `insert into platform.webhook_subscription (api_client_id, event, url)
     values ($1, 'stock.changed', 'https://storefront.example.com/hooks/inventory'),
            ($1, 'reservation.expired', 'https://storefront.example.com/hooks/holds')`,
    [storefront.client_id]);

  // Plausible traffic over the last week.
  await c.query(`
    insert into platform.api_request
      (api_client_id, method, path, status_code, duration_ms, replayed, rate_limited, occurred_at)
    select $1, 'GET', '/api/v1/stock', 200,
           25 + (random() * 60)::int, false, false,
           now() - (random() * interval '7 days')
      from generate_series(1, 900)
  `, [storefront.client_id]);

  await c.query(`
    insert into platform.api_request
      (api_client_id, method, path, status_code, duration_ms, replayed, rate_limited, occurred_at)
    select $1, 'POST', '/api/v1/reservations',
           case when random() < 0.06 then 409 else 201 end,
           40 + (random() * 120)::int,
           random() < 0.03, false,
           now() - (random() * interval '7 days')
      from generate_series(1, 380)
  `, [storefront.client_id]);

  // The reporting job: inside its rate most of the time, throttled
  // when it runs. Exactly the pattern worth spotting before it turns
  // into a support ticket from somebody else.
  await c.query(`
    insert into platform.api_request
      (api_client_id, method, path, status_code, duration_ms, replayed, rate_limited, occurred_at)
    select $1, 'GET', '/api/v1/ledger',
           case when random() < 0.35 then 429 else 200 end,
           80 + (random() * 900)::int, false, random() < 0.35,
           now() - (random() * interval '7 days')
      from generate_series(1, 260)
  `, [reporter.client_id]);

  // ─────────────── some actual trade ───────────────
  //
  // Opening balances alone leave the money screens technically
  // correct and completely empty. A business with no purchases and no
  // sales has no margin to look at, so the finance page would give a
  // reader nothing to judge and no way to spot a wrong figure.
  //
  // Untracked products only: a batch-tracked line needs a named lot
  // on every receipt and issue, which is Phase 8's picker rather than
  // something to fake here.

  const supplier = (await c.query(
    "select id from partner.partner where name = 'Shree Agro Traders'")).rows[0].id;
  const buyer = (await c.query(
    "select id from partner.partner where name = 'Sunrise Caterers'")).rows[0].id;
  const trade = (await c.query(
    "select id from partner.partner where name = 'Nirmal Home Care Pvt Ltd'")).rows[0].id;

  // A delivery into the hub carrying ₹750 of freight, so landed cost
  // is visibly not the invoice price — the whole point of Phase 7.
  const buy = [
    { product_id: bySku["Toor Dal 1kg"], qty: 20000, unit_cost: 14 },
    { product_id: bySku["Atta 10kg"],    qty: 10000, unit_cost: 4  },
  ];
  await asUser(PLANNER);
  const purchase = (await c.query(
    `select movement.create_movement('IMPORT',null,$1,$2,$3::jsonb,
       'weekly staples order') as id`,
    [loc.HUB, supplier, JSON.stringify(buy)])).rows[0].id;

  await c.query("select movement.set_charges($1, 75000)", [purchase]);

  await asUser(ADMIN);
  await c.query("select movement.approve_movement($1)", [purchase]);

  const buyLines = (await c.query(
    "select id, product_id from movement.line where movement_id = $1", [purchase])).rows;
  await c.query("select movement.receive_movement($1,$2::jsonb)", [
    purchase,
    JSON.stringify(buyLines.map((l) => ({
      line_id: l.id,
      qty_received: buy.find((b) => b.product_id === l.product_id).qty,
    }))),
  ]);

  // Sales at a normal grocery markup — thin on staples, fatter on
  // household. Deliberately uneven so the margin column has something
  // to say rather than one number repeated.
  const sales = [
    { from: "HUB", to: buyer, tax: null, lines: [
      { name: "Toor Dal 1kg", qty: 5000, price: 19 },
      { name: "Atta 10kg",    qty: 3000, price: 6  }] },
    { from: "HUB", to: trade, tax: 576, lines: [
      { name: "Floor Cleaner 1L", qty: 200, price: 16 }] },
    { from: "HUB", to: buyer, tax: null, lines: [
      { name: "Toor Dal 1kg", qty: 2500, price: 18 }] },
  ];

  let sold = 0;
  for (const sale of sales) {
    const lines = sale.lines.map((l) => ({
      product_id: bySku[l.name], qty: l.qty, unit_cost: l.price,
    }));

    await asUser(PLANNER);
    const id = (await c.query(
      `select movement.create_movement('EXPORT',$1,null,$2,$3::jsonb,'counter sale') as id`,
      [loc[sale.from], sale.to, JSON.stringify(lines)])).rows[0].id;

    if (sale.tax) await c.query("select movement.set_charges($1,null,null,$2)", [id, sale.tax]);

    await asUser(ADMIN);
    await c.query("select movement.approve_movement($1)", [id]);
    await c.query("select movement.dispatch_movement($1)", [id]);
    sold += 1;
  }

  // ─────────────── work in progress ───────────────
  //
  // Two tickets left open on purpose. Without them every movement in
  // the demo is already closed, and the two flows that matter most to
  // an operator — receiving a delivery, and receiving a transfer —
  // cannot be walked at all.

  await asUser(PLANNER);
  const inbound = (await c.query(
    `select movement.create_movement('IMPORT',null,$1,$2,$3::jsonb,
       'dairy order — arriving today') as id`,
    [loc.HUB, (await c.query(
      "select id from partner.partner where name = 'Konkan Dairy Co-op'")).rows[0].id,
     JSON.stringify([
       { product_id: bySku["Dishwash Bar 200g"],  qty: 4000, unit_cost: 9 },
       { product_id: bySku["Floor Cleaner 1L"],   qty: 2500, unit_cost: 11 },
     ])])).rows[0].id;

  // Deliberately NO freight yet. The charge is entered on arrival,
  // which is the point of the panel on the receive screen.
  await asUser(ADMIN);
  await c.query("select movement.approve_movement($1)", [inbound]);

  // And a transfer already on the road, so the in-transit path has a
  // subject too.
  // Sized from what the hub actually holds. Hard-coding quantities
  // here oversold the rice the first time, because opening balances
  // are generated from the product's position in the list — a number
  // that changes the moment somebody adds a product.
  const hubHas = Object.fromEntries((await c.query(
    `select p.name, b.on_hand - b.reserved - b.allocated - b.damaged as free
       from stock.balance b join catalog.product p on p.id = b.product_id
      where b.location_id = $1`, [loc.HUB])).rows.map((r) => [r.name, Number(r.free)]));

  const moveLines = [
    ["Toor Dal 1kg", 3000],
    ["Basmati Rice 5kg", 900],
  ]
    // Never more than half of what is there, so the hub still looks
    // like a hub afterwards.
    .map(([name, want]) => ({
      product_id: bySku[name],
      qty: Math.max(1, Math.min(want, Math.floor((hubHas[name] ?? 0) / 2))),
    }))
    .filter((l) => l.qty > 1);

  await asUser(PLANNER);
  const onRoad = (await c.query(
    `select movement.create_movement('TRANSFER',$1,$2,null,$3::jsonb,
       'top-up for the weekend') as id`,
    [loc.HUB, loc.SH1, JSON.stringify(moveLines)])).rows[0].id;

  await asUser(ADMIN);
  await c.query("select movement.approve_movement($1)", [onRoad]);
  await c.query("select movement.dispatch_movement($1)", [onRoad]);

  // ─────────────── compute what the screens read ───────────────
  //
  // In production these are pg_cron jobs (see the README). The seed
  // runs them once so the demand, replenishment and alert screens
  // have something in them the moment somebody signs in — rather than
  // being correct and blank until a scheduler that nobody has set up
  // yet happens to fire.

  await asUser(ADMIN);
  const metrics = (await c.query("select insight.refresh_metrics() as n")).rows[0].n;
  const alerts = (await c.query(
    "select coalesce(sum(opened), 0)::int as n from alerting.evaluate()")).rows[0].n;

  await c.query("commit");

  console.log(`• 4 locations, 6 users, 6 partners`);
  console.log(`• ${report.length} products, ${bal.length} opening stock lines`);
  console.log(`• 1 purchase with freight, ${sold} sales`);
  console.log(`• 2 API clients, 2 webhook subscriptions, ~1500 logged requests`);
  console.log(`• 2 tickets open: a delivery to receive, a transfer in transit`);
  console.log(`• ${issued} days of sales history, ${metrics} metrics, ${alerts} alerts raised`);
  console.log(`\nSign in as any of:`);
  console.log(`  arun@example.com     operator      Shop 1 only`);
  console.log(`  meena@example.com    shop manager  Shop 1 only`);
  console.log(`  priya@example.com    planner       Shop 1 + Shop 3 (no all_locations)`);
  console.log(`  deepa@example.com    planner       every location`);
  console.log(`  admin@example.com    admin         every location`);
} catch (e) {
  await c.query("rollback");
  console.error("Seed failed:", e.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
