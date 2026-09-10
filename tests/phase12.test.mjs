// ============================================================
// FILTERS — CONFIRMATION TEST
//
// A stock page reported an empty warehouse. Every tile read 0, every
// row was gone, and the ledger underneath held 8,768,641 units.
//
// The location filter offers <option value="">All I can see</option>.
// Choosing it and pressing Filter submits `loc=`, so the page got the
// empty STRING. It then wrote `[loc ?? null]` — and `??` replaces only
// null and undefined. The empty string went to the database intact,
// the guard `($1::text is null or l.code = $1)` became `l.code = ''`,
// and "show me everything" was compiled into "show me nothing".
//
// No error. No empty state explaining itself. Just zeroes, stated with
// total confidence — which is the worst way for a system of record to
// be wrong.
//
// So this file proves two things: that the conversion works, and that
// no page has gone back to doing it by hand.
// ============================================================

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { param, flag, count } from "../lib/params.ts";
import { root } from "./harness.mjs";

// ─────────────────── the conversion ───────────────────

describe("A blank filter means everything, not nothing", () => {
  test("an empty string becomes null, which is what ?? did not do", () => {
    assert.equal(param(""), null);
    assert.equal(param("   "), null);
    assert.equal(param(undefined), null);
    assert.equal(param(null), null);

    // The proof that ?? was the wrong tool: it leaves "" alone.
    assert.equal("" ?? null, "", "if this ever changes, the helper can go");
  });

  test("a real choice survives, trimmed", () => {
    assert.equal(param("SH1"), "SH1");
    assert.equal(param("  SH1  "), "SH1");
    assert.equal(param("0"), "0", "'0' is a value somebody chose, not an absence");
  });

  test("flags read the way a form writes them", () => {
    assert.equal(flag("true"), true);
    assert.equal(flag("1"), true);
    assert.equal(flag(""), false);
    assert.equal(flag(undefined), false);
    assert.equal(flag("false"), false);
    assert.equal(flag("0"), false);
  });

  test("counts fall back rather than becoming NaN", () => {
    assert.equal(count("50", 100), 50);
    assert.equal(count("", 100), 100);
    assert.equal(count("abc", 100), 100);
    assert.equal(count("-5", 100), 100);
    assert.equal(count("999999", 100, 200), 200);
  });
});

// ─────────────────── the guard ───────────────────

function pageFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) pageFiles(full, out);
    else if (entry === "page.tsx") out.push(full);
  }
  return out;
}

/**
 * Every name destructured out of searchParams, and whether it is
 * handed to a query with `??`.
 *
 * Discovery rather than an allowlist: a page added next month is
 * checked without anybody remembering to list it.
 */
function offenders(source) {
  const found = [];

  // const { loc, q, only } = await searchParams;
  const destructure = /const\s*\{([^}]*)\}\s*=\s*await\s+searchParams/g;
  const names = new Set();

  for (const m of source.matchAll(destructure)) {
    for (const raw of m[1].split(",")) {
      const name = raw.split(":")[0].split("=")[0].trim();
      if (name) names.add(name);
    }
  }

  for (const name of names) {
    // `name ?? null` — the exact shape that emptied the stock page.
    if (new RegExp(`\\b${name}\\s*\\?\\?\\s*null`).test(source)) {
      found.push(name);
    }
  }
  return found;
}

describe("Guard: a search parameter never reaches a query through ??", () => {
  test("no page does it", () => {
    const violations = [];

    for (const file of pageFiles(join(root, "app"))) {
      const bad = offenders(readFileSync(file, "utf8"));
      if (bad.length > 0) {
        violations.push(`${file.replace(root, "").replace(/\\/g, "/")}: ${bad.join(", ")}`);
      }
    }

    assert.deepEqual(violations, [],
      "?? leaves an empty string alone, so a blank filter is sent to the database " +
      "as '' and matches nothing. Use param() from lib/params.ts:\n  " +
      violations.join("\n  "));
  });

  // Negative control. A guard nobody has watched fire is a guard that
  // might not — three in this repo were found dead exactly that way.
  test("and the guard would catch it if one did", () => {
    const bad = `
      export default async function Page({ searchParams }) {
        const { loc, q } = await searchParams;
        const rows = await c.query("select 1 where ($1::text is null or code = $1)",
          [loc ?? null]);
      }`;

    assert.deepEqual(offenders(bad), ["loc"],
      "the guard cannot see the very bug it exists for");

    const good = `
      export default async function Page({ searchParams }) {
        const { loc, q } = await searchParams;
        const rows = await c.query("select 1", [param(loc)]);
      }`;

    assert.deepEqual(offenders(good), [], "a correct page was reported as a violation");
  });
});
