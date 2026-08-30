// Test harness.
//
// The critical detail: tests run as the `authenticated` role, never
// as `postgres`. A superuser bypasses every row-level security
// policy, so a suite written against `postgres` would pass happily
// while the system leaked. Seeding uses postgres deliberately (it
// needs to write across every location); assertions never do.

import pg from "pg";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CONNECTION, assertDisposableTarget, connectionOptions } from "../scripts/db-config.mjs";

// The fixtures TRUNCATE every table in the system. Running this
// suite against anything but a disposable database empties it — so
// the suite refuses to start rather than trusting whoever set
// DATABASE_URL to have meant it.
//
// A remote target is allowed only through scripts/test-supabase.mjs,
// which makes you name the host first. See assertDisposableTarget.
assertDisposableTarget("the test suite");

const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, "..");

// Fixed UUIDs so a failure message is readable rather than a hex soup.
export const ID = {
  locHub:    "11111111-1111-4111-8111-000000000001",
  locShop1:  "11111111-1111-4111-8111-000000000002",
  locShop2:  "11111111-1111-4111-8111-000000000003",
  // Recreated by the fixture: migration 0016 seeds it, the truncate
  // removes it, and the movement functions cannot work without it.
  locTransit:"11111111-1111-4111-8111-00000000000e",

  userOp1:     "22222222-2222-4222-8222-000000000001",
  userMgr1:    "22222222-2222-4222-8222-000000000002",
  userMgr2:    "22222222-2222-4222-8222-000000000003",
  userPlanner: "22222222-2222-4222-8222-000000000004",
  userAdmin:   "22222222-2222-4222-8222-000000000005",

  productA: "33333333-3333-4333-8333-000000000001",
  productB: "33333333-3333-4333-8333-000000000002",
};

// The JWT each persona would arrive with.
export const AS = {
  operatorShop1: { sub: ID.userOp1,     role: "operator",     location_ids: ID.locShop1 },
  managerShop1:  { sub: ID.userMgr1,    role: "shop_manager", location_ids: ID.locShop1 },
  managerShop2:  { sub: ID.userMgr2,    role: "shop_manager", location_ids: ID.locShop2 },
  // Global scope is now an explicit grant, never inferred from the
  // role name — see migration 0009. A planner without it is scoped.
  planner:       { sub: ID.userPlanner, role: "planner", location_ids: "", all_locations: true },
  admin:         { sub: ID.userAdmin,   role: "admin",   location_ids: "" },
  regionalPlanner: { sub: ID.userPlanner, role: "planner", location_ids: ID.locShop1 },
};

export async function connect() {
  const c = new pg.Client(connectionOptions());
  await c.connect();
  return c;
}

/**
 * Run `fn` as a signed-in user with the given claims.
 *
 * Wrapped in a transaction that always rolls back, so tests cannot
 * leak state into one another regardless of what they write.
 */
export async function asUser(claims, fn) {
  const c = await connect();
  try {
    await c.query("begin");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await c.query("set local role authenticated");
    return await fn(c);
  } finally {
    try { await c.query("rollback"); } catch { /* connection already gone */ }
    await c.end();
  }
}

/**
 * Assert that `fn` is refused, and that the refusal names the right reason.
 *
 * Pass the client to wrap the attempt in a SAVEPOINT. Without one, a
 * failed statement aborts the surrounding transaction and every later
 * query in the same test returns "current transaction is aborted"
 * instead of the answer you were testing for.
 */
export async function refused(fn, expectedFragment, client = null) {
  if (client) await client.query("savepoint refusal_check");
  let error = null;
  try { await fn(); } catch (e) { error = e; }
  if (client) {
    await client.query(error ? "rollback to savepoint refusal_check"
                             : "release savepoint refusal_check");
  }
  if (!error) throw new Error(`expected refusal containing "${expectedFragment}", but it SUCCEEDED`);
  if (expectedFragment && !error.message.includes(expectedFragment)) {
    throw new Error(`expected refusal containing "${expectedFragment}", got: ${error.message}`);
  }
  return error;
}

/** Run one of the CI check queries and return its violation rows. */
export async function runCheck(name) {
  const sql = readFileSync(join(root, "supabase", "checks", `${name}.sql`), "utf8");
  const c = await connect();
  try {
    const { rows } = await c.query(sql);
    return rows;
  } finally {
    await c.end();
  }
}

/** Fixtures. Runs as postgres: it must write across every location. */
export async function seed() {
  const c = await connect();
  try {
    await c.query("begin");

    // TRUNCATE, not DELETE. The ledger's append-only trigger refuses
    // row deletion by design — that invariant protects history from
    // being edited, not a test database from being reset. TRUNCATE is
    // a table-level operation and does not fire row triggers, which
    // is exactly the distinction we want.
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

    await c.query(
      `insert into platform.location (id, code, name, type) values
         ($1,'HUB','Central Warehouse','HUB'),
         ($2,'SH1','Shop 1 — Andheri','STORE'),
         ($3,'SH2','Shop 2 — Bandra','STORE'),
         ($4,'TRANSIT','In transit — owned by nobody','VIRTUAL')`,
      [ID.locHub, ID.locShop1, ID.locShop2, ID.locTransit],
    );

    await c.query(
      `insert into platform.app_user (id, email, full_name, role) values
         ($1,'op1@example.com','Operator One','operator'),
         ($2,'mgr1@example.com','Manager One','shop_manager'),
         ($3,'mgr2@example.com','Manager Two','shop_manager'),
         ($4,'planner@example.com','Planner','planner'),
         ($5,'admin@example.com','Admin','admin')`,
      [ID.userOp1, ID.userMgr1, ID.userMgr2, ID.userPlanner, ID.userAdmin],
    );

    await c.query(
      `insert into platform.user_location (user_id, location_id) values
         ($1,$4),($2,$4),($3,$5)`,
      [ID.userOp1, ID.userMgr1, ID.userMgr2, ID.locShop1, ID.locShop2],
    );

    await c.query(
      `insert into partner.partner (name, kinds, gstin) values
         ('Fixture Supplier', array['SUPPLIER'], '27AAAAA0000A1Z1'),
         ('Fixture Customer', array['CUSTOMER'], '27BBBBB0000B1Z2'),
         ('Fixture Carrier',  array['CARRIER'],  null)`);

    // Products must exist before stock can reference them — the
    // ledger has a real foreign key to the catalogue.
    await c.query(
      `insert into catalog.product (id, sku_code, name, base_uom_id)
       values ($1,'PRD-FIXTURE-A','Fixture Product A',
                 (select id from catalog.uom where code='PCS')),
              ($2,'PRD-FIXTURE-B','Fixture Product B',
                 (select id from catalog.uom where code='PCS'))`,
      [ID.productA, ID.productB],
    );

    // Opening stock is POSTED, not inserted. From Phase 2 the balance
    // is a projection of the ledger — fixtures that wrote around it
    // would leave the two out of step and fail the rebuild gate on
    // data the tests themselves created.
    await c.query("select set_config('request.jwt.claims', $1, true)",
      [JSON.stringify(AS.admin)]);

    for (const [product, location, qty] of [
      [ID.productA, ID.locShop1, 100],
      [ID.productA, ID.locShop2, 250],
      [ID.productB, ID.locShop1, 40],
    ]) {
      await c.query("select stock.post_movement($1,$2,$3,'OPENING')",
        [product, location, qty]);
    }

    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    await c.end();
  }
}
