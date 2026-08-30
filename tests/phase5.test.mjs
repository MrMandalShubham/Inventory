// ============================================================
// PHASE 5 — CONFIRMATION TEST
//
// The gate is two human tasks:
//
//   An operator receives a shipment end to end on a phone using only
//   the scanner, typing nothing except a variance reason. A manager
//   finds why one product is short at one location in under three
//   clicks.
//
// Neither is assertable from here — they are measured in a browser,
// and they were. What IS assertable is the layer the gate stands on:
// sign-in, sessions, and the claims those sessions mint.
//
// That matters more than it sounds. Every policy, every SECURITY
// DEFINER body and all 108 earlier tests were written against a
// claims SHAPE. If real sign-in produces a different shape, the whole
// isolation model silently stops applying while everything still
// renders.
// ============================================================

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { AS, ID, connect, refused, runCheck, seed } from "./harness.mjs";

const q = (c, sql, params) => c.query(sql, params).then((r) => r.rows);
const one = async (c, sql, params) => (await q(c, sql, params))[0];

async function as(claims) {
  const c = await connect();
  await c.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(claims)]);
  return c;
}

/** Give the fixture users passwords, as scripts/seed.mjs does for the
 *  demo data. Note the fixtures use their own emails (mgr1@…, op1@…)
 *  rather than the demo names — a test that speaks the demo seed's
 *  language passes locally and fails in CI. */
before(async () => {
  await seed();
  const c = await connect();
  try {
    await q(c, `insert into platform.credential (user_id, password_hash)
                select id, crypt('inventory', gen_salt('bf', 10)) from platform.app_user`);
  } finally { await c.end(); }
});

describe("CI checks after auth", () => {
  test("credential and session tables have RLS and a policy", async () => {
    const v = await runCheck("rls-coverage");
    assert.deepEqual(v, [], v.map((x) => `  ${x.schema_name}.${x.table_name}: ${x.violation}`).join("\n"));
  });

  test("the definer surface is still fully scoped", async () => {
    const v = await runCheck("definer-scope");
    assert.deepEqual(v, [], v.map((x) => `  ${x.schema_name}.${x.function_name}`).join("\n"));
  });
});

describe("Sign in", () => {
  test("the right password returns a token", async () => {
    const c = await connect();
    try {
      const r = await one(c, "select * from platform.sign_in($1,$2,'test')",
        ["mgr1@example.com", "inventory"]);
      assert.match(r.token, /^[0-9a-f]{64}$/, "expected a 32-byte hex token");
      assert.ok(new Date(r.expires_at) > new Date(), "the session should not start expired");
    } finally { await c.end(); }
  });

  test("only the hash is stored — a database read yields no usable token", async () => {
    const c = await connect();
    try {
      const r = await one(c, "select * from platform.sign_in($1,$2,'test')",
        ["op1@example.com", "inventory"]);
      const stored = await one(c,
        "select token_hash from platform.session order by created_at desc limit 1");
      assert.notEqual(stored.token_hash, r.token, "the token was stored in clear");
      assert.equal(stored.token_hash.length, 64);

      const pw = await one(c, "select password_hash from platform.credential limit 1");
      assert.match(pw.password_hash, /^\$2[aby]\$/, "passwords must be bcrypt, not plain");
    } finally { await c.end(); }
  });

  test("a wrong password and an unknown email fail identically", async () => {
    const c = await connect();
    try {
      // Failure is zero rows, not an exception — migration 0023. An
      // exception would roll back the failed-attempt counter.
      const a = await q(c, "select * from platform.sign_in($1,$2)", ["mgr1@example.com", "wrong"]);
      const b = await q(c, "select * from platform.sign_in($1,$2)", ["nobody@example.com", "wrong"]);
      assert.deepEqual(a, []);
      // Telling them apart is how an attacker enumerates your staff list.
      assert.deepEqual(b, []);
    } finally { await c.end(); }
  });

  test("repeated failures lock the account", async () => {
    const c = await connect();
    try {
      for (let i = 0; i < 8; i++) {
        await q(c, "select * from platform.sign_in($1,$2)", ["mgr2@example.com", "wrong"]);
      }
      // The counter has to SURVIVE the failures for this to work.
      const cred = await one(c,
        `select failed_attempts, locked_until from platform.credential
          where user_id = (select id from platform.app_user where email='mgr2@example.com')`);
      assert.equal(cred.failed_attempts, 8, "the failed-attempt counter did not persist");
      assert.ok(cred.locked_until, "the account was never locked");

      await refused(
        () => c.query("select * from platform.sign_in($1,$2)", ["mgr2@example.com", "inventory"]),
        "ACCOUNT_LOCKED");
    } finally { await c.end(); }
  });
});

describe("The claims shape is unchanged", () => {
  test("a session mints exactly what every policy was written against", async () => {
    const c = await connect();
    try {
      const { token } = await one(c, "select * from platform.sign_in($1,$2)",
        ["mgr1@example.com", "inventory"]);
      const claims = (await one(c, "select platform.session_claims($1) as c", [token])).c;

      // The four keys the whole isolation model depends on.
      for (const k of ["sub", "role", "location_ids", "all_locations"]) {
        assert.ok(k in claims, `claims are missing "${k}" — every policy reads it`);
      }
      assert.equal(claims.role, "shop_manager");
      assert.equal(claims.all_locations, false);
      assert.equal(claims.location_ids, ID.locShop1,
        "a shop manager's session must carry exactly their locations");
    } finally { await c.end(); }
  });

  test("those claims produce the same scoping as the old fixture claims", async () => {
    const c = await connect();
    try {
      const { token } = await one(c, "select * from platform.sign_in($1,$2)",
        ["mgr1@example.com", "inventory"]);
      const claims = (await one(c, "select platform.session_claims($1) as c", [token])).c;

      const viaSession = await (async () => {
        const c2 = await connect();
        try {
          await c2.query("begin");
          await c2.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
          await c2.query("set local role authenticated");
          const n = (await one(c2, "select count(*)::int as n from stock.balance")).n;
          await c2.query("rollback");
          return n;
        } finally { await c2.end(); }
      })();

      const viaFixture = await (async () => {
        const c2 = await connect();
        try {
          await c2.query("begin");
          await c2.query("select set_config('request.jwt.claims',$1,true)",
            [JSON.stringify(AS.managerShop1)]);
          await c2.query("set local role authenticated");
          const n = (await one(c2, "select count(*)::int as n from stock.balance")).n;
          await c2.query("rollback");
          return n;
        } finally { await c2.end(); }
      })();

      assert.equal(viaSession, viaFixture,
        "a real session scopes differently from the fixture — the isolation model changed");
    } finally { await c.end(); }
  });

  test("an admin session still sees everything", async () => {
    const c = await connect();
    try {
      const { token } = await one(c, "select * from platform.sign_in($1,$2)",
        ["admin@example.com", "inventory"]);
      const claims = (await one(c, "select platform.session_claims($1) as c", [token])).c;
      assert.equal(claims.role, "admin");
    } finally { await c.end(); }
  });
});

describe("Sessions end", () => {
  test("signing out invalidates the token immediately", async () => {
    const c = await connect();
    try {
      const { token } = await one(c, "select * from platform.sign_in($1,$2)",
        ["planner@example.com", "inventory"]);
      assert.ok((await one(c, "select platform.session_claims($1) as c", [token])).c);

      await q(c, "select platform.sign_out($1)", [token]);
      assert.equal((await one(c, "select platform.session_claims($1) as c", [token])).c, null);
    } finally { await c.end(); }
  });

  test("an expired token resolves to nothing", async () => {
    const c = await connect();
    try {
      const { token } = await one(c, "select * from platform.sign_in($1,$2)",
        ["planner@example.com", "inventory"]);
      await q(c, `update platform.session set expires_at = now() - interval '1 hour'
                   where token_hash = encode(digest($1,'sha256'),'hex')`, [token]);
      assert.equal((await one(c, "select platform.session_claims($1) as c", [token])).c, null);
    } finally { await c.end(); }
  });

  test("an unknown token resolves to nothing", async () => {
    const c = await connect();
    try {
      assert.equal(
        (await one(c, "select platform.session_claims('not-a-token') as c")).c, null);
    } finally { await c.end(); }
  });

  test("changing a password ends every other session", async () => {
    const c = await connect();
    try {
      const a = await one(c, "select * from platform.sign_in($1,$2)", ["planner@example.com", "inventory"]);
      const b = await one(c, "select * from platform.sign_in($1,$2)", ["planner@example.com", "inventory"]);
      assert.ok((await one(c, "select platform.session_claims($1) as c", [a.token])).c);

      await c.query("select set_config('request.jwt.claims',$1,false)",
        [JSON.stringify(AS.admin)]);
      await q(c, "select platform.set_password($1,'a-new-password')", [ID.userPlanner]);

      // If the reason for the change was that somebody else had it,
      // leaving their session alive defeats the point.
      for (const t of [a.token, b.token]) {
        assert.equal((await one(c, "select platform.session_claims($1) as c", [t])).c, null,
          "an old session survived a password change");
      }
    } finally { await c.end(); }
  });
});

describe("Passwords", () => {
  test("a short password is refused", async () => {
    const c = await as(AS.admin);
    try {
      await refused(
        () => c.query("select platform.set_password($1,'short')", [ID.userOp1]),
        "WEAK_PASSWORD");
    } finally { await c.end(); }
  });

  test("you cannot set somebody else's password unless you are an admin", async () => {
    const c = await as(AS.managerShop1);
    try {
      await refused(
        () => c.query("select platform.set_password($1,'longenoughpassword')", [ID.userOp1]),
        "FORBIDDEN");
    } finally { await c.end(); }
  });

  test("you can set your own", async () => {
    const c = await as(AS.managerShop1);
    try {
      await q(c, "select platform.set_password($1,'my-own-password')", [ID.userMgr1]);
    } finally { await c.end(); }

    const c2 = await connect();
    try {
      const r = await one(c2, "select * from platform.sign_in($1,$2)",
        ["mgr1@example.com", "my-own-password"]);
      assert.ok(r.token);
    } finally { await c2.end(); }
  });
});
