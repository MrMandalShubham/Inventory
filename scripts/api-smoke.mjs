// HTTP smoke test for the public API.
//
// The Phase 4 gate is proved at the database level by
// tests/phase4.test.mjs, which always runs. This exercises the layer
// above it — auth, scopes, idempotency records, error shapes — and
// needs a running server, so it is a script rather than a test.
//
//   npm run dev            # in one terminal
//   npm run api:smoke      # in another

import pg from "pg";
import { connectionOptions } from "./db-config.mjs";

const BASE = process.env.API_BASE ?? "http://127.0.0.1:3100/api/v1";
const ADMIN = {
  sub: "22222222-2222-4222-8222-000000000005",
  role: "admin", location_ids: "", all_locations: true,
};

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✖ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

const call = async (path, opts = {}) => {
  const res = await fetch(BASE + path, opts);
  let body = null;
  try { body = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body, headers: res.headers };
};

// ── set up: a key, and a product with exactly 100 units ──
const db = new pg.Client(connectionOptions());
await db.connect();
await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(ADMIN)]);

const loc = (await db.query("select id from platform.location where code='SH1'")).rows[0].id;
const product = (await db.query(
  `insert into catalog.product (name, base_uom_id)
   values ('API Smoke ' || floor(random()*100000)::text,
           (select id from catalog.uom where code='PCS'))
   returning id`)).rows[0].id;
await db.query("select stock.post_movement($1,$2,100,'OPENING',null,'smoke')", [product, loc]);

const full = (await db.query(
  `select * from platform.create_api_client('Smoke test',
     array['catalog:read','stock:read','reservations:write'], '{}', 'LIVE')`)).rows[0];
const readOnly = (await db.query(
  `select * from platform.create_api_client('Read only',
     array['stock:read'], '{}', 'LIVE')`)).rows[0];

const auth = (k) => ({ Authorization: `Bearer ${k}`, "Content-Type": "application/json" });

console.log(`\nInventory Core — API smoke test against ${BASE}\n`);

// ── the spec is public ──
console.log("Contract");
{
  const r = await call("/openapi");
  ok("GET /openapi needs no key", r.status === 200, `got ${r.status}`);
  ok("it names the version", r.body?.info?.version === "1.0.0");
  ok("it documents the reservation endpoint", !!r.body?.paths?.["/reservations"]);
}

// ── auth ──
console.log("\nAuthentication");
{
  const none = await call("/stock");
  ok("no key is 401", none.status === 401, `got ${none.status}`);

  const bad = await call("/stock", { headers: auth("ic_live_nonsense") });
  ok("a bad key is 401", bad.status === 401, `got ${bad.status}`);
  ok("it does not say WHY the key failed",
    bad.body?.error?.message === "That key is not valid.",
    JSON.stringify(bad.body));

  const good = await call("/stock", { headers: auth(full.api_key) });
  ok("a good key is 200", good.status === 200, `got ${good.status}`);
  ok("every response carries as_of", typeof good.body?.as_of === "string");
}

// ── scopes ──
console.log("\nScopes");
{
  const r = await call("/reservations", {
    method: "POST",
    headers: { ...auth(readOnly.api_key), "Idempotency-Key": "scope-test" },
    body: JSON.stringify({ product_id: product, location_id: loc, quantity: 1 }),
  });
  ok("a read-only key cannot reserve", r.status === 403, `got ${r.status}`);
  ok("the refusal names the missing scope",
    r.body?.error?.required === "reservations:write", JSON.stringify(r.body?.error));
}

// ── idempotency ──
console.log("\nIdempotency");
{
  const missing = await call("/reservations", {
    method: "POST",
    headers: auth(full.api_key),
    body: JSON.stringify({ product_id: product, location_id: loc, quantity: 1 }),
  });
  ok("a write without a key is refused", missing.status === 400, `got ${missing.status}`);
  ok("the error explains what to do",
    missing.body?.error?.code === "idempotency_key_required");

  const key = "smoke-" + Date.now();
  const payload = JSON.stringify({ product_id: product, location_id: loc, quantity: 3 });

  const first = await call("/reservations", {
    method: "POST", headers: { ...auth(full.api_key), "Idempotency-Key": key }, body: payload,
  });
  ok("the first call creates a hold", first.status === 201, `got ${first.status}`);

  const replay = await call("/reservations", {
    method: "POST", headers: { ...auth(full.api_key), "Idempotency-Key": key }, body: payload,
  });
  ok("a retry returns the ORIGINAL response",
    replay.body?.reservation?.id === first.body?.reservation?.id,
    `${replay.body?.reservation?.id} vs ${first.body?.reservation?.id}`);
  ok("and marks it as a replay", replay.headers.get("idempotent-replay") === "true");

  const reused = await call("/reservations", {
    method: "POST", headers: { ...auth(full.api_key), "Idempotency-Key": key },
    body: JSON.stringify({ product_id: product, location_id: loc, quantity: 99 }),
  });
  ok("reusing the key for a DIFFERENT request is refused",
    reused.status === 422 && reused.body?.error?.code === "idempotency_key_reused",
    `got ${reused.status} ${reused.body?.error?.code}`);

  const held = (await db.query(
    `select coalesce(sum(quantity),0)::int as n from stock.reservation
      where product_id=$1 and status='HELD'`, [product])).rows[0].n;
  ok("the retry held nothing extra", held === 3, `held ${held}, expected 3`);
}

// ── the gate, over HTTP ──
console.log("\nTHE GATE, over HTTP");
{
  const remaining = (await db.query(
    `select available from stock.balance
      where product_id=$1 and location_id=$2 and batch_id is null`, [product, loc])).rows[0].available;

  const attempts = Array.from({ length: 200 }, (_, i) =>
    call("/reservations", {
      method: "POST",
      headers: { ...auth(full.api_key), "Idempotency-Key": `gate-${Date.now()}-${i}` },
      body: JSON.stringify({ product_id: product, location_id: loc, quantity: 1, order_ref: `o${i}` }),
    }).then((r) => r.status));

  const results = await Promise.all(attempts);
  const created = results.filter((s) => s === 201).length;
  const conflict = results.filter((s) => s === 409).length;
  const other = results.filter((s) => s !== 201 && s !== 409);

  ok(`exactly ${remaining} succeed over HTTP`, created === remaining,
    `got ${created} of ${remaining} available`);
  ok("the rest are clean 409s", conflict === 200 - created, `got ${conflict}`);
  ok("nothing else went wrong", other.length === 0, `unexpected: ${[...new Set(other)].join(",")}`);

  const b = (await db.query(
    `select on_hand, reserved, available from stock.balance
      where product_id=$1 and location_id=$2 and batch_id is null`, [product, loc])).rows[0];
  ok("zero oversold", b.available === 0 && b.reserved === b.on_hand,
    `on_hand ${b.on_hand}, reserved ${b.reserved}, available ${b.available}`);
}

// ── lifecycle over HTTP ──
console.log("\nLifecycle");
{
  // Read the quantity too — the first HELD row is the 3-unit hold
  // from the idempotency block, not one of the 1-unit gate holds.
  const held = (await db.query(
    `select id, quantity from stock.reservation
      where product_id=$1 and status='HELD' limit 1`, [product])).rows[0];
  const id = held.id;

  const c = await call(`/reservations/${id}/confirm`, {
    method: "POST", headers: { ...auth(full.api_key), "Idempotency-Key": "cf-" + id },
    body: JSON.stringify({ order_ref: "ORDER-9001" }),
  });
  ok("confirm returns CONFIRMED", c.body?.reservation?.status === "CONFIRMED",
    JSON.stringify(c.body?.reservation ?? c.body));

  const before = (await db.query(
    `select on_hand from stock.balance where product_id=$1 and location_id=$2 and batch_id is null`,
    [product, loc])).rows[0].on_hand;

  const k = await call(`/reservations/${id}/consume`, {
    method: "POST", headers: { ...auth(full.api_key), "Idempotency-Key": "cs-" + id },
  });
  ok("consume returns CONSUMED", k.body?.reservation?.status === "CONSUMED",
    JSON.stringify(k.body?.reservation ?? k.body));
  ok("and a ledger entry id", Number(k.body?.ledger_entry_id) > 0);

  const after = (await db.query(
    `select on_hand from stock.balance where product_id=$1 and location_id=$2 and batch_id is null`,
    [product, loc])).rows[0].on_hand;
  ok("the goods left the shelf", after === before - held.quantity,
    `${before} → ${after}, expected a drop of ${held.quantity}`);
}

// ── the request log ──
console.log("\nRate limits");
{
  // The database half is proved in tests/phase8.test.mjs. This checks
  // the part only a live request can show: that a throttled caller
  // gets a 429 with headers it can act on, and that being throttled
  // does not touch anybody else.
  const throttled = (await db.query(
    `select * from platform.create_api_client('Throttle test',
       array['stock:read'], '{}', 'LIVE')`)).rows[0];
  const neighbour = (await db.query(
    `select * from platform.create_api_client('Neighbour',
       array['stock:read'], '{}', 'LIVE')`)).rows[0];

  // 6/min with 5 in hand. Deliberately slow: 50 concurrent requests
  // against a dev server take tens of seconds, and at 60/min the
  // bucket would legitimately refill twenty tokens mid-flood — which
  // is the limiter working, but makes for a test that measures the
  // machine rather than the limit.
  await db.query("select platform.set_api_limits($1, 6, 5)", [throttled.client_id]);
  await db.query("select platform.set_api_limits($1, 600, 100)", [neighbour.client_id]);

  const headers = auth(throttled.api_key);
  const first = await call("/stock?limit=1", { headers });
  ok("a normal request carries its limit headers",
    first.headers.get("x-ratelimit-limit") === "6" &&
    first.headers.get("x-ratelimit-remaining") !== null,
    `limit=${first.headers.get("x-ratelimit-limit")} remaining=${first.headers.get("x-ratelimit-remaining")}`);

  const flood = await Promise.all(
    Array.from({ length: 50 }, () => call("/stock?limit=1", { headers })));

  const rejected = flood.filter((r) => r.status === 429);
  ok("a flood is throttled", rejected.length >= 40, `${rejected.length}/50 refused`);

  const sample = rejected[0];
  ok("429 says how long to wait", Number(sample?.headers.get("retry-after")) >= 1,
    `Retry-After: ${sample?.headers.get("retry-after")}`);
  ok("and says so in the body too", Number(sample?.body?.error?.retry_after) >= 1,
    JSON.stringify(sample?.body?.error ?? null));
  ok("the error code is machine-readable",
    sample?.body?.error?.code === "rate_limited", sample?.body?.error?.code);

  // THE GATE, at the HTTP layer: the neighbour is untouched.
  const neighbourResults = await Promise.all(
    Array.from({ length: 10 }, () => call("/stock?limit=1", { headers: auth(neighbour.api_key) })));

  ok("THE GATE — a second client is unaffected by the flood",
    neighbourResults.every((r) => r.status === 200),
    `statuses: ${[...new Set(neighbourResults.map((r) => r.status))].join(", ")}`);

  // Throttled requests are recorded as throttled, so the usage screen
  // shows a client hitting its ceiling rather than one merely erroring.
  const logged = (await db.query(
    `select count(*) filter (where rate_limited)::int as throttled
       from platform.api_request where api_client_id = $1`, [throttled.client_id])).rows[0];
  ok("throttled requests are flagged in the log", logged.throttled >= 40,
    `${logged.throttled} flagged`);

  const usage = (await db.query("select * from platform.api_usage(1)")).rows
    .find((r) => r.api_client_id === throttled.client_id);
  ok("and surface in the usage report", Number(usage?.throttled) >= 40,
    `report says ${usage?.throttled}`);
}

console.log("\nObservability");
{
  const rows = (await db.query(
    `select count(*)::int as n, count(*) filter (where replayed)::int as replays,
            count(*) filter (where status_code = 401)::int as unauthorized
       from platform.api_request where api_client_id = $1`, [full.client_id])).rows[0];

  ok("requests are logged", rows.n > 200, `logged ${rows.n}`);
  ok("replays are flagged", rows.replays >= 1, `${rows.replays} replays`);

  const drift = (await db.query("select count(*)::int as n from stock.verify_reservations()")).rows[0].n;
  ok("the reserved counter still agrees with live holds", drift === 0, `${drift} lines drifted`);
}

await db.end();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
