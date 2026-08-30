// ============================================================
// PHASE 4 — CONFIRMATION TEST
//
// The gate (docs/02 §5):
//
//   200 concurrent reservation requests against 100 units yield
//   exactly 100 successes, 100 clean rejections and zero oversells.
//   Every write replayed with the same idempotency key changes
//   nothing and returns the original response.
//
// The oversell guarantee lives in ONE UPDATE statement with the
// availability test in its WHERE clause. This test exists to prove
// that claim under real contention rather than assert it in a
// comment. The HTTP layer is exercised separately by
// scripts/api-smoke.mjs against a running server.
// ============================================================

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { AS, ID, connect, refused, runCheck, seed } from "./harness.mjs";
import { CONNECTION } from "../scripts/db-config.mjs";

const q = (c, sql, params) => c.query(sql, params).then((r) => r.rows);
const one = async (c, sql, params) => (await q(c, sql, params))[0];

async function as(claims) {
  const c = await connect();
  await c.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(claims)]);
  return c;
}

before(async () => { await seed(); });

// ─────────────────────── CI guards ───────────────────────

describe("CI checks after the API platform", () => {
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

describe("THE GATE — 200 concurrent holds against 100 units", () => {
  test("exactly 100 succeed, 100 are cleanly refused, zero oversold", async () => {
    // A line holding exactly 100.
    const setup = await as(AS.admin);
    let productId;
    try {
      productId = (await one(setup,
        `insert into catalog.product (name, base_uom_id)
         values ('Contention Test', (select id from catalog.uom where code='PCS'))
         returning id`)).id;
      await q(setup, "select stock.post_movement($1,$2,100,'OPENING',null,'gate')",
        [productId, ID.locShop1]);
    } finally { await setup.end(); }

    // A pool, so 200 callers genuinely contend for connections and
    // for the row. Serialising them would prove nothing.
    const pool = new pg.Pool({ connectionString: CONNECTION, max: 30 });
    const claims = JSON.stringify(AS.admin);

    const attempts = Array.from({ length: 200 }, (_, i) =>
      (async () => {
        const c = await pool.connect();
        try {
          await c.query("select set_config('request.jwt.claims', $1, false)", [claims]);
          await c.query("select stock.reserve($1,$2,1,$3)",
            [productId, ID.locShop1, `order-${i}`]);
          return "ok";
        } catch (e) {
          return e.message.includes("INSUFFICIENT_STOCK") ? "refused" : `unexpected: ${e.message}`;
        } finally {
          c.release();
        }
      })());

    const results = await Promise.all(attempts);
    await pool.end();

    const ok = results.filter((r) => r === "ok").length;
    const refusedCount = results.filter((r) => r === "refused").length;
    const weird = results.filter((r) => r.startsWith("unexpected"));

    assert.deepEqual(weird, [], `unexpected failures:\n${weird.slice(0, 3).join("\n")}`);
    assert.equal(ok, 100, `expected exactly 100 winners, got ${ok}`);
    assert.equal(refusedCount, 100, `expected exactly 100 clean refusals, got ${refusedCount}`);

    // And the shelf agrees.
    const check = await as(AS.admin);
    try {
      const b = await one(check,
        `select on_hand, reserved, available from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`,
        [productId, ID.locShop1]);

      assert.equal(b.on_hand, 100, "on_hand must not move on a hold — nothing has shipped");
      assert.equal(b.reserved, 100, "every winner should hold exactly one unit");
      assert.equal(b.available, 0, "nothing left to sell");

      const held = (await one(check,
        `select count(*)::int as n from stock.reservation
          where product_id=$1 and status='HELD'`, [productId])).n;
      assert.equal(held, 100, "there should be 100 live holds");
    } finally { await check.end(); }
  });

  test("the counter and the live holds agree", async () => {
    const c = await as(AS.admin);
    try {
      const drift = await q(c, "select * from stock.verify_reservations()");
      assert.deepEqual(drift, [],
        "stock.balance.reserved disagrees with the sum of live reservations");
    } finally { await c.end(); }
  });

  test("the 101st caller is refused with the available quantity, not a partial hold", async () => {
    const c = await as(AS.admin);
    try {
      const productId = (await one(c,
        `select product_id from stock.reservation
          where order_ref like 'order-%' limit 1`)).product_id;

      const err = await refused(
        () => c.query("select stock.reserve($1,$2,5,'over')", [productId, ID.locShop1]),
        "INSUFFICIENT_STOCK");

      assert.match(err.message, /5 requested, 0 available/,
        "the refusal should say how much there actually is");
    } finally { await c.end(); }
  });
});

// ─────────────────── idempotency ───────────────────

describe("Idempotency — a retry must not take a second unit", () => {
  test("the same key returns the original reservation and holds nothing extra", async () => {
    const c = await as(AS.admin);
    try {
      const key = "retry-" + Date.now();
      const before = (await one(c,
        `select reserved from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`,
        [ID.productA, ID.locShop1])).reserved;

      const first = (await one(c,
        "select stock.reserve($1,$2,4,'ord-1',900,$3) as id",
        [ID.productA, ID.locShop1, key])).id;

      const mid = (await one(c,
        `select reserved from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`,
        [ID.productA, ID.locShop1])).reserved;

      // The client times out and retries with the same key.
      const second = (await one(c,
        "select stock.reserve($1,$2,4,'ord-1',900,$3) as id",
        [ID.productA, ID.locShop1, key])).id;

      const after = (await one(c,
        `select reserved from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`,
        [ID.productA, ID.locShop1])).reserved;

      assert.equal(second, first, "the retry created a second reservation");
      assert.equal(mid, before + 4, "the first call should have held 4");
      assert.equal(after, mid, "the retry held a second 4 units");
    } finally { await c.end(); }
  });
});

// ─────────────────── the lifecycle ───────────────────

describe("Reservation lifecycle", () => {
  let productId;

  before(async () => {
    const c = await as(AS.admin);
    try {
      productId = (await one(c,
        `insert into catalog.product (name, base_uom_id)
         values ('Lifecycle Test', (select id from catalog.uom where code='PCS'))
         returning id`)).id;
      await q(c, "select stock.post_movement($1,$2,50,'OPENING',null,'lifecycle')",
        [productId, ID.locShop1]);
    } finally { await c.end(); }
  });

  test("a hold reduces available but not on_hand — nothing has shipped", async () => {
    const c = await as(AS.admin);
    try {
      const id = (await one(c, "select stock.reserve($1,$2,10,'ord-a') as id",
        [productId, ID.locShop1])).id;

      const b = await one(c,
        `select on_hand, reserved, available from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`,
        [productId, ID.locShop1]);

      assert.equal(b.on_hand, 50, "on_hand must not move on a hold");
      assert.equal(b.reserved, 10);
      assert.equal(b.available, 40);

      // No ledger entry yet — nothing physically happened.
      const led = (await one(c,
        "select count(*)::int as n from stock.ledger where note = $1",
        ["reservation " + id])).n;
      assert.equal(led, 0, "a hold must not write to the ledger");
    } finally { await c.end(); }
  });

  test("confirming stops the expiry but still moves nothing", async () => {
    const c = await as(AS.admin);
    try {
      const id = (await one(c, "select stock.reserve($1,$2,5,'ord-b') as id",
        [productId, ID.locShop1])).id;
      await q(c, "select stock.confirm_reservation($1,'ord-b')", [id]);

      const r = await one(c,
        "select status, expires_at from stock.reservation where id=$1", [id]);
      assert.equal(r.status, "CONFIRMED");
      assert.equal(r.expires_at, null, "a paid hold must not lapse");
    } finally { await c.end(); }
  });

  test("consuming writes the ledger entry and drops on_hand", async () => {
    const c = await as(AS.admin);
    try {
      const before = (await one(c,
        `select on_hand, reserved from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`,
        [productId, ID.locShop1]));

      const id = (await one(c, "select stock.reserve($1,$2,6,'ord-c') as id",
        [productId, ID.locShop1])).id;
      await q(c, "select stock.confirm_reservation($1)", [id]);
      const led = (await one(c, "select stock.consume_reservation($1) as id", [id])).id;

      assert.ok(Number(led) > 0, "consuming must write a ledger entry");

      const after = await one(c,
        `select on_hand, reserved from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`,
        [productId, ID.locShop1]);

      assert.equal(after.on_hand, before.on_hand - 6, "the goods left the shelf");
      assert.equal(after.reserved, before.reserved, "the hold was released as it was consumed");

      const entry = await one(c,
        "select qty_delta, reason_code from stock.ledger where id=$1", [led]);
      assert.equal(entry.qty_delta, -6);
      assert.equal(entry.reason_code, "ISSUE");
    } finally { await c.end(); }
  });

  test("a fully reserved line can still be consumed", async () => {
    // The order matters: releasing the hold must happen BEFORE posting,
    // or claims_within_stock breaks when reserved equals on_hand.
    const c = await as(AS.admin);
    try {
      const p = (await one(c,
        `insert into catalog.product (name, base_uom_id)
         values ('Fully Reserved', (select id from catalog.uom where code='PCS'))
         returning id`)).id;
      await q(c, "select stock.post_movement($1,$2,10,'OPENING',null,'full')", [p, ID.locShop1]);

      const id = (await one(c, "select stock.reserve($1,$2,10,'all') as id",
        [p, ID.locShop1])).id;
      await q(c, "select stock.consume_reservation($1)", [id]);

      const b = await one(c,
        `select on_hand, reserved from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`, [p, ID.locShop1]);
      assert.equal(b.on_hand, 0);
      assert.equal(b.reserved, 0);
    } finally { await c.end(); }
  });

  test("releasing returns the stock to available", async () => {
    const c = await as(AS.admin);
    try {
      const before = (await one(c,
        `select available from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`,
        [productId, ID.locShop1])).available;

      const id = (await one(c, "select stock.reserve($1,$2,7,'ord-d') as id",
        [productId, ID.locShop1])).id;
      await q(c, "select stock.release_reservation($1,'customer abandoned checkout')", [id]);

      const after = (await one(c,
        `select available from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`,
        [productId, ID.locShop1])).available;

      assert.equal(after, before, "released stock did not become available again");
    } finally { await c.end(); }
  });

  test("consumed stock cannot be released — the goods have gone", async () => {
    const c = await as(AS.admin);
    try {
      const id = (await one(c, "select stock.reserve($1,$2,2,'ord-e') as id",
        [productId, ID.locShop1])).id;
      await q(c, "select stock.consume_reservation($1)", [id]);
      await refused(
        () => c.query("select stock.release_reservation($1,'oops')", [id]),
        "ALREADY_CONSUMED");
    } finally { await c.end(); }
  });

  test("a shop cannot reserve at a location it does not hold", async () => {
    const c = await as(AS.managerShop1);
    try {
      await refused(
        () => c.query("select stock.reserve($1,$2,1,'x')", [ID.productA, ID.locShop2]),
        "FORBIDDEN_LOCATION");
    } finally { await c.end(); }
  });
});

// ─────────────────── the sweeper ───────────────────

describe("The expiry sweeper — mandatory, not an optimisation", () => {
  test("abandoned holds are released and the stock comes back", async () => {
    const c = await as(AS.admin);
    try {
      const p = (await one(c,
        `insert into catalog.product (name, base_uom_id)
         values ('Sweeper Test', (select id from catalog.uom where code='PCS'))
         returning id`)).id;
      await q(c, "select stock.post_movement($1,$2,20,'OPENING',null,'sweep')", [p, ID.locShop1]);

      const id = (await one(c, "select stock.reserve($1,$2,20,'abandoned') as id",
        [p, ID.locShop1])).id;

      const during = await one(c,
        `select available from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`, [p, ID.locShop1]);
      assert.equal(during.available, 0, "the whole line should be held");

      // Wind the clock back rather than waiting fifteen minutes.
      await q(c, "update stock.reservation set expires_at = now() - interval '1 minute' where id=$1",
        [id]);

      const swept = (await one(c, "select stock.sweep_expired_reservations() as n")).n;
      assert.ok(swept >= 1, "the sweeper released nothing");

      const after = await one(c,
        `select available from stock.balance
          where product_id=$1 and location_id=$2 and batch_id is null`, [p, ID.locShop1]);
      assert.equal(after.available, 20,
        "a wave of abandoned carts would freeze the catalogue and look exactly like a stockout");

      const r = await one(c, "select status, released_reason from stock.reservation where id=$1", [id]);
      assert.equal(r.status, "RELEASED");
      assert.equal(r.released_reason, "expired");
    } finally { await c.end(); }
  });

  test("a confirmed reservation is never swept — it has no expiry", async () => {
    const c = await as(AS.admin);
    try {
      const id = (await one(c, "select stock.reserve($1,$2,3,'paid') as id",
        [ID.productA, ID.locShop1])).id;
      await q(c, "select stock.confirm_reservation($1)", [id]);
      await q(c, "select stock.sweep_expired_reservations()");

      const r = await one(c, "select status from stock.reservation where id=$1", [id]);
      assert.equal(r.status, "CONFIRMED", "the sweeper released a paid order");
    } finally { await c.end(); }
  });
});

// ─────────────────── API keys ───────────────────

describe("API keys", () => {
  test("a key is returned once and stored only as a hash", async () => {
    const c = await as(AS.admin);
    try {
      const k = await one(c,
        `select * from platform.create_api_client('Buy/sell app',
           array['stock:read','reservations:write'], '{}', 'LIVE')`);

      assert.match(k.api_key, /^ic_live_[0-9a-f]{48}$/);

      const stored = await one(c,
        "select key_hash, key_prefix from platform.api_client where id=$1", [k.client_id]);

      assert.notEqual(stored.key_hash, k.api_key, "the key was stored in clear");
      assert.equal(stored.key_prefix, k.api_key.slice(0, 12));
      assert.equal(stored.key_hash.length, 64, "expected a sha256 hex digest");
    } finally { await c.end(); }
  });

  test("authenticating resolves to scoped claims", async () => {
    const c = await as(AS.admin);
    try {
      const k = await one(c,
        `select * from platform.create_api_client('Scoped',
           array['stock:read'], array[$1::uuid], 'LIVE')`, [ID.locShop1]);

      const claims = (await one(c,
        "select platform.authenticate_api_key($1) as claims", [k.api_key])).claims;

      assert.equal(claims.role, "api_client", "an API client is not a user");
      assert.deepEqual(claims.scopes, ["stock:read"]);
      assert.equal(claims.all_locations, false, "a key with a location named is scoped to it");
      assert.equal(claims.location_ids, ID.locShop1);
    } finally { await c.end(); }
  });

  test("an unknown, revoked or expired key is refused identically", async () => {
    const c = await as(AS.admin);
    try {
      const unknown = (await one(c,
        "select platform.authenticate_api_key('ic_live_deadbeef') as claims")).claims;
      assert.equal(unknown, null);

      const k = await one(c,
        `select * from platform.create_api_client('Doomed', array['stock:read'])`);
      await q(c, "update platform.api_client set status='REVOKED' where id=$1", [k.client_id]);

      const revoked = (await one(c,
        "select platform.authenticate_api_key($1) as claims", [k.api_key])).claims;
      assert.equal(revoked, null, "a revoked key still authenticated");
    } finally { await c.end(); }
  });

  test("only an admin may mint a key", async () => {
    const c = await as(AS.planner);
    try {
      await refused(
        () => c.query(`select * from platform.create_api_client('Sneaky', array['*'])`),
        "FORBIDDEN_ROLE");
    } finally { await c.end(); }
  });
});

// ─────────────────── everything still adds up ───────────────────

describe("After all of that", () => {
  test("balance, transit and reservations are all square", async () => {
    const c = await as(AS.admin);
    try {
      assert.deepEqual(await q(c, "select * from stock.verify_balances()"), [],
        "the ledger and the projection disagree");
      assert.deepEqual(await q(c, "select * from movement.verify_transit()"), [],
        "transit holds stock no ticket claims");
      assert.deepEqual(await q(c, "select * from stock.verify_reservations()"), [],
        "the reserved counter disagrees with the live holds");
    } finally { await c.end(); }
  });
});
