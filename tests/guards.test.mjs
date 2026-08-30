// ============================================================
// NEGATIVE CONTROLS — do the CI guards actually catch anything?
//
// A check that has never failed is a check nobody knows works.
// These tests deliberately introduce the exact mistakes the guards
// exist to catch, confirm each guard fires, then clean up.
//
// Without these, a typo in a WHERE clause could silently turn both
// checks into `select ... where false` and every build would stay
// green while the protection was gone.
// ============================================================

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { connect, runCheck } from "./harness.mjs";

describe("Guard: definer-scope", () => {
  test("catches a SECURITY DEFINER function that forgets its scope check", async () => {
    const c = await connect();
    try {
      // Exactly the bug docs/02 §3 warns about: takes a location,
      // runs as owner so RLS does not apply, and never checks whether
      // the caller may touch that location.
      await c.query(`
        create or replace function stock.leaky_read(p_location uuid)
        returns integer language sql security definer as $$
          select coalesce(sum(on_hand), 0)::int from stock.balance
           where location_id = p_location
        $$;
      `);

      const violations = await runCheck("definer-scope");
      const caught = violations.find((v) => v.function_name === "leaky_read");

      assert.ok(caught, "the guard did not catch an unscoped SECURITY DEFINER function");
      assert.equal(caught.violation, "DEFINER_WITHOUT_SCOPE_CHECK");
      assert.equal(caught.schema_name, "stock");
    } finally {
      await c.query("drop function if exists stock.leaky_read(uuid)");
      await c.end();
    }
  });

  test("accepts the same function once it checks scope", async () => {
    const c = await connect();
    try {
      await c.query(`
        create or replace function stock.fixed_read(p_location uuid)
        returns integer language plpgsql security definer as $$
        begin
          if not platform.can_access_location(p_location) then
            raise exception 'FORBIDDEN_LOCATION' using errcode = '42501';
          end if;
          return (select coalesce(sum(on_hand), 0)::int from stock.balance
                   where location_id = p_location);
        end $$;
      `);

      const violations = await runCheck("definer-scope");
      assert.ok(
        !violations.some((v) => v.function_name === "fixed_read"),
        "the guard flagged a function that does check scope — it is too strict",
      );
    } finally {
      await c.query("drop function if exists stock.fixed_read(uuid)");
      await c.end();
    }
  });

  test("accepts a function that declares an explicit exemption", async () => {
    const c = await connect();
    try {
      await c.query(`
        create or replace function platform.exempt_example()
        returns integer language sql security definer as $$
          -- @no-scope-check: reads nothing that belongs to a location.
          select 1
        $$;
      `);

      const violations = await runCheck("definer-scope");
      assert.ok(
        !violations.some((v) => v.function_name === "exempt_example"),
        "the documented exemption marker was not honoured",
      );
    } finally {
      await c.query("drop function if exists platform.exempt_example()");
      await c.end();
    }
  });
});

describe("Guard: rls-coverage", () => {
  test("catches a new table added without row-level security", async () => {
    const c = await connect();
    try {
      await c.query("create table stock.forgotten (id int primary key)");

      const violations = await runCheck("rls-coverage");
      const caught = violations.find((v) => v.table_name === "forgotten");

      assert.ok(caught, "the guard did not catch a table without RLS");
      assert.equal(caught.violation, "RLS_NOT_ENABLED");
    } finally {
      await c.query("drop table if exists stock.forgotten");
      await c.end();
    }
  });

  test("catches a table with RLS enabled but no policy — which denies everything", async () => {
    const c = await connect();
    try {
      await c.query("create table stock.locked (id int primary key)");
      await c.query("alter table stock.locked enable row level security");

      const violations = await runCheck("rls-coverage");
      const caught = violations.find((v) => v.table_name === "locked");

      assert.ok(caught, "the guard did not catch RLS-without-policy");
      assert.equal(caught.violation, "NO_POLICY");
    } finally {
      await c.query("drop table if exists stock.locked");
      await c.end();
    }
  });
});

describe("Guard: function-overloads", () => {
  test("catches an argument added with CREATE OR REPLACE", async () => {
    const c = await connect();
    try {
      // Exactly what happened to emit_event (migration 0037) and then
      // to create_api_client (0039): the second CREATE does not
      // replace the first, it stands beside it, and every existing
      // call becomes ambiguous.
      await c.query(`create function stock.twice(a int) returns int
                     language sql as $$ select a $$`);
      await c.query(`create or replace function stock.twice(a int, b int default 0) returns int
                     language sql as $$ select a + b $$`);

      const violations = await runCheck("function-overloads");
      const caught = violations.find((v) => v.function_name === "twice");

      assert.ok(caught, "the guard did not catch an accidental overload");
      assert.equal(caught.violation, "FUNCTION_OVERLOADED");
      assert.equal(Number(caught.signatures), 2);

      // And the ambiguity is real, not theoretical.
      await assert.rejects(
        () => c.query("select stock.twice(1)"),
        /not unique/,
        "if this call resolves, the guard is stricter than the problem");
    } finally {
      await c.query("drop function if exists stock.twice(int)").catch(() => {});
      await c.query("drop function if exists stock.twice(int, int)").catch(() => {});
      await c.end();
    }
  });

  test("accepts a function replaced with the SAME signature", async () => {
    const c = await connect();
    try {
      await c.query(`create function stock.once(a int) returns int
                     language sql as $$ select a $$`);
      await c.query(`create or replace function stock.once(a int) returns int
                     language sql as $$ select a * 2 $$`);

      const violations = await runCheck("function-overloads");
      assert.equal(violations.find((v) => v.function_name === "once"), undefined,
        "a genuine replacement was reported as an overload");
    } finally {
      await c.query("drop function if exists stock.once(int)").catch(() => {});
      await c.end();
    }
  });
});

describe("Guard: search-path", () => {
  test("catches a definer function that cannot see the extensions schema", async () => {
    const c = await connect();
    try {
      // Exactly the shape every function in this system had before
      // migration 0043: correct on the local container, and unable to
      // find crypt() or word_similarity() on Supabase.
      await c.query(`create function stock.blind_to_extensions() returns int
                     language sql security definer
                     set search_path = stock, public
                     as $$ select 1 $$`);

      const violations = await runCheck("search-path");
      const caught = violations.find((v) => v.function_name === "blind_to_extensions");

      assert.ok(caught, "the guard did not catch a search_path without extensions");
      assert.equal(caught.violation, "SEARCH_PATH_MISSING_EXTENSIONS");
    } finally {
      await c.query("drop function if exists stock.blind_to_extensions()").catch(() => {});
      await c.end();
    }
  });

  test("catches extensions in a position where it could shadow our own schemas", async () => {
    const c = await connect();
    try {
      await c.query(`create function stock.shadowable() returns int
                     language sql security definer
                     set search_path = extensions, stock, public
                     as $$ select 1 $$`);

      const violations = await runCheck("search-path");
      const caught = violations.find((v) => v.function_name === "shadowable");

      assert.ok(caught, "extensions before our schemas defeats the point of pinning it");
      assert.equal(caught.violation, "EXTENSIONS_NOT_LAST");
    } finally {
      await c.query("drop function if exists stock.shadowable()").catch(() => {});
      await c.end();
    }
  });

  test("accepts a correctly ordered search_path", async () => {
    const c = await connect();
    try {
      await c.query(`create function stock.well_formed() returns int
                     language sql security definer
                     set search_path = stock, platform, public, extensions
                     as $$ select 1 $$`);

      const violations = await runCheck("search-path");
      assert.equal(violations.find((v) => v.function_name === "well_formed"), undefined,
        "a correct search_path was reported as a violation");
    } finally {
      await c.query("drop function if exists stock.well_formed()").catch(() => {});
      await c.end();
    }
  });
});

describe("Guard: server-only", () => {
  test("catches a server-only function an application role can call", async () => {
    const c = await connect();
    try {
      // Exactly the hole that existed: migration 0044 revoked EXECUTE,
      // 99-grants.sql granted it straight back, and nothing noticed.
      await c.query(`create function platform.skeleton_key(a int) returns int
                     language sql security definer as $$
                       -- @server-only: mints trust from nothing
                       select a $$`);
      await c.query("grant execute on function platform.skeleton_key(int) to authenticated");

      const violations = await runCheck("server-only");
      const caught = violations.find((v) => v.function_name === "skeleton_key");

      assert.ok(caught, "a server-only function was reachable by authenticated and the guard missed it");
      assert.equal(caught.violation, "SERVER_ONLY_FUNCTION_IS_EXECUTABLE");
      assert.equal(caught.reachable_by, "authenticated");
    } finally {
      await c.query("drop function if exists platform.skeleton_key(int)").catch(() => {});
      await c.end();
    }
  });

  test("accepts it once EXECUTE is revoked", async () => {
    const c = await connect();
    try {
      await c.query(`create function platform.skeleton_key2(a int) returns int
                     language sql security definer as $$
                       -- @server-only: mints trust from nothing
                       select a $$`);
      await c.query("revoke execute on function platform.skeleton_key2(int) from public");
      await c.query("revoke execute on function platform.skeleton_key2(int) from authenticated");

      const violations = await runCheck("server-only");
      assert.equal(violations.find((v) => v.function_name === "skeleton_key2"), undefined,
        "a properly revoked function was reported as reachable");
    } finally {
      await c.query("drop function if exists platform.skeleton_key2(int)").catch(() => {});
      await c.end();
    }
  });

  test("the real server-only functions are unreachable after a full migrate", async () => {
    const v = await runCheck("server-only");
    assert.deepEqual(v, [],
      v.map((x) => `  ${x.schema_name}.${x.function_name} reachable by ${x.reachable_by}`).join("\n"));
  });
});
