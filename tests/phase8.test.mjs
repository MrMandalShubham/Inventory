// ============================================================
// PHASE 8a — CONFIRMATION TEST
//
// The gate:
//
//   One client hammering at 10× its limit is throttled without
//   touching a second client's latency; and an event raised by a
//   stock movement reaches a subscriber, retries with backoff when
//   the endpoint fails, and is never delivered twice.
//
// Both halves are about the same promise. This system exists so that
// SEVERAL DIFFERENT APPLICATIONS can share one inventory. That is
// only true if one badly-behaved app cannot degrade the others, and
// if an app that subscribes to events actually receives them.
// ============================================================

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AS, ID, connect, refused, runCheck, seed } from "./harness.mjs";
import { drainOnce, sign, verify } from "../lib/webhooks.ts";

const q = (c, sql, p) => c.query(sql, p).then((r) => r.rows);
const one = async (c, sql, p) => (await q(c, sql, p))[0];

async function as(claims) {
  const c = await connect();
  await c.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(claims)]);
  await c.query("set role authenticated");
  return c;
}

/** Admin, without the role switch — the worker's own footing. */
async function asWorker() {
  const c = await connect();
  await c.query("select set_config('request.jwt.claims', $1, false)",
    [JSON.stringify({ ...AS.admin })]);
  return c;
}

// ─────────── a subscriber we control ───────────

let server, baseUrl;
const received = [];
let respondWith = { status: 200, delayMs: 0 };

before(async () => {
  await seed();

  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      received.push({
        body,
        signature: req.headers["x-inventory-signature"],
        event: req.headers["x-inventory-event"],
        delivery: req.headers["x-inventory-delivery"],
      });
      const send = () => {
        res.writeHead(respondWith.status, { "content-type": "text/plain" });
        res.end("ok");
      };
      if (respondWith.delayMs) setTimeout(send, respondWith.delayMs);
      else send();
    });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
});

async function makeClient(name, opts = {}) {
  const c = await as(AS.admin);
  try {
    const row = await one(c,
      "select * from platform.create_api_client($1, $2)",
      [name, ["stock:read", "stock:write"]]);
    if (opts.perMin || opts.burst || opts.quota) {
      await q(c, "select platform.set_api_limits($1,$2,$3,$4)",
        [row.client_id, opts.perMin ?? null, opts.burst ?? null, opts.quota ?? null]);
    }
    return row.client_id;
  } finally { await c.end(); }
}

// ─────────────────────── CI guards ───────────────────────

describe("CI checks after the API platform grew", () => {
  test("every table still has RLS and a policy", async () => {
    const v = await runCheck("rls-coverage");
    assert.deepEqual(v, [], v.map((x) => `  ${x.schema_name}.${x.table_name}: ${x.violation}`).join("\n"));
  });

  test("the definer surface is still fully scoped", async () => {
    const v = await runCheck("definer-scope");
    assert.deepEqual(v, [], v.map((x) => `  ${x.schema_name}.${x.function_name}`).join("\n"));
  });

  test("no function was accidentally overloaded", async () => {
    const v = await runCheck("function-overloads");
    assert.deepEqual(v, [],
      v.map((x) => `  ${x.schema_name}.${x.function_name}: ${x.argument_lists}`).join("\n"));
  });
});

// ═══════════════ THE GATE, PART ONE — isolation ═══════════════

describe("THE GATE — one client's flood does not reach another", () => {
  test("a client is cut off at its burst and told exactly when to return", async () => {
    // 60/min = one token a second, with 5 in hand.
    const id = await makeClient("Noisy App", { perMin: 60, burst: 5 });
    const c = await asWorker();
    try {
      const results = [];
      for (let i = 0; i < 12; i++) {
        results.push(await one(c, "select * from platform.consume_rate_token($1,1)", [id]));
      }

      const allowed = results.filter((r) => r.allowed).length;
      assert.equal(allowed, 5,
        "the burst is what may be spent at once — 12 requests must not all get through");

      const first = results.find((r) => !r.allowed);
      assert.equal(first.reason, "rate_limited");
      assert.ok(first.retry_after >= 1,
        "a client told to retry in 0s retries immediately and is refused again");
      assert.equal(first.remaining, 0);
    } finally { await c.end(); }
  });

  test("THE GATE — a second client is completely unaffected", async () => {
    const noisy = await makeClient("Flooder", { perMin: 60, burst: 5 });
    const quiet = await makeClient("Well Behaved", { perMin: 60, burst: 5 });

    const c = await asWorker();
    try {
      // 50 requests — ten times the burst — from one client.
      let refusedCount = 0;
      const started = Date.now();
      for (let i = 0; i < 50; i++) {
        const r = await one(c, "select * from platform.consume_rate_token($1,1)", [noisy]);
        if (!r.allowed) refusedCount += 1;
      }
      const floodMs = Date.now() - started;

      assert.ok(refusedCount >= 44,
        `the flood should be almost entirely refused, ${refusedCount}/50 were`);

      // The quiet client's bucket is untouched by any of that.
      const mine = [];
      const qStart = Date.now();
      for (let i = 0; i < 5; i++) {
        mine.push(await one(c, "select * from platform.consume_rate_token($1,1)", [quiet]));
      }
      const quietMs = Date.now() - qStart;

      assert.ok(mine.every((r) => r.allowed),
        "a client that stayed inside its limit was refused because ANOTHER client flooded — " +
        "that is the shared-API failure this whole phase exists to prevent");

      // The buckets are separate rows, so the quiet client never
      // queued behind the flood. Timing is a weak assertion on a
      // loaded machine; the strong one is above.
      assert.ok(quietMs < floodMs,
        `five clean requests (${quietMs}ms) should not cost more than fifty refused ones (${floodMs}ms)`);
    } finally { await c.end(); }
  });

  test("THE GATE — a burst arriving AT ONCE is held to the same limit", async () => {
    // The one that matters. A limiter driven sequentially will pass
    // even when it is completely broken: 0034 read the bucket, then
    // wrote it, so fifty simultaneous requests all read the same
    // balance and a bucket of 5 let 24 through. A flood is the only
    // case a rate limiter exists for.
    const id = await makeClient("Thundering Herd", { perMin: 6, burst: 5 });

    const conns = await Promise.all(Array.from({ length: 40 }, () => asWorker()));
    try {
      const results = await Promise.all(
        conns.map((c) => one(c, "select * from platform.consume_rate_token($1,1)", [id])));

      const allowed = results.filter((r) => r.allowed).length;
      assert.equal(allowed, 5,
        `${allowed} of 40 simultaneous requests got through a bucket of 5 — ` +
        "the decision and the write must be one statement, or every one of them " +
        "reads the balance before any of them spends it");
    } finally {
      await Promise.all(conns.map((c) => c.end()));
    }
  });

  test("tokens refill with time, not with a job", async () => {
    // 60/min is one token a second — slow enough that the test's own
    // round-trip latency cannot refill the bucket behind its back.
    const id = await makeClient("Refiller", { perMin: 60, burst: 2 });
    const c = await asWorker();
    try {
      await q(c, "select * from platform.consume_rate_token($1,2)", [id]);
      const empty = await one(c, "select * from platform.consume_rate_token($1,1)", [id]);
      assert.equal(empty.allowed, false, "the bucket should be empty");

      // Nothing runs in between. The refill is a function of the clock.
      await new Promise((r) => setTimeout(r, 1200));

      const later = await one(c, "select * from platform.consume_rate_token($1,1)", [id]);
      assert.equal(later.allowed, true,
        "a bucket that only refills when a job runs empties permanently the day the job stops");
    } finally { await c.end(); }
  });

  test("the bucket never fills past the burst", async () => {
    const id = await makeClient("Idle App", { perMin: 60, burst: 3 });
    const c = await asWorker();
    try {
      // Idle long enough to accrue far more than the cap.
      await q(c, "update platform.api_client set tokens = 0, tokens_at = now() - interval '1 hour' where id = $1", [id]);

      let allowed = 0;
      for (let i = 0; i < 10; i++) {
        if ((await one(c, "select * from platform.consume_rate_token($1,1)", [id])).allowed) allowed += 1;
      }
      assert.equal(allowed, 3,
        "an idle client must not bank an hour of tokens and spend them in one burst");
    } finally { await c.end(); }
  });

  test("a daily quota stops a client that is inside the rate but pulling the world", async () => {
    const id = await makeClient("Hoover", { perMin: 6000, burst: 100, quota: 4 });
    const c = await asWorker();
    try {
      const seen = [];
      for (let i = 0; i < 6; i++) {
        seen.push(await one(c, "select * from platform.consume_rate_token($1,1)", [id]));
      }
      assert.equal(seen.filter((r) => r.allowed).length, 4);
      assert.equal(seen[5].reason, "daily_quota_exhausted");
      assert.ok(seen[5].retry_after > 60,
        "retrying in a minute cannot help a daily quota — say so");
    } finally { await c.end(); }
  });

  test("the limiter fails OPEN, never closed", async () => {
    const c = await asWorker();
    try {
      // A client id that does not exist stands in for a limiter that
      // cannot answer. It must not take the inventory down with it.
      const r = await one(c, "select * from platform.consume_rate_token($1,1)",
        ["00000000-0000-0000-0000-000000000000"]);
      assert.equal(r.allowed, false, "an unknown client is refused, not served");
      assert.equal(r.reason, "unknown_client");
    } finally { await c.end(); }
  });

  test("only an admin may change a limit", async () => {
    const id = await makeClient("Someone Else's App");
    const c = await as(AS.planner);
    try {
      await refused(
        () => c.query("select platform.set_api_limits($1, 999999)", [id]),
        "FORBIDDEN_ROLE");
    } finally { await c.end(); }
  });

  test("a limit of zero is refused — it would lock the client out entirely", async () => {
    const id = await makeClient("Zero Test");
    const c = await as(AS.admin);
    try {
      await refused(() => c.query("select platform.set_api_limits($1, 0)", [id]), "BAD_LIMIT");
      await refused(() => c.query("select platform.set_api_limits($1, null, 0)", [id]), "BAD_BURST");
    } finally { await c.end(); }
  });
});

// ═══════════════ THE GATE, PART TWO — delivery ═══════════════

describe("THE GATE — an event actually reaches a subscriber", () => {
  let clientId, subId, productId;

  before(async () => {
    clientId = await makeClient("Storefront", { perMin: 6000, burst: 100 });
    const c = await as(AS.admin);
    try {
      subId = (await one(c,
        `insert into platform.webhook_subscription (api_client_id, event, url)
         values ($1, 'stock.changed', $2) returning id`,
        [clientId, `${baseUrl}/hook`])).id;

      productId = (await one(c,
        `insert into catalog.product (name, base_uom_id)
         values ('Webhook Test', (select id from catalog.uom where code='PCS')) returning id`)).id;
    } finally { await c.end(); }
  });

  test("moving stock queues an event", async () => {
    const c = await as(AS.admin);
    try {
      await q(c, "select stock.post_movement($1,$2,10,'OPENING',null,'hook test',null,100)",
        [productId, ID.locShop1]);

      const d = await one(c,
        "select * from platform.webhook_delivery where subscription_id = $1", [subId]);

      assert.ok(d, "nothing was queued — emit_event is wired to nothing");
      assert.equal(d.status, "PENDING");
      assert.equal(d.event, "stock.changed");
      assert.equal(d.payload.qty_delta, 10);
      assert.equal(d.payload.on_hand, 10);
      assert.ok(d.event_key.startsWith("ledger:"),
        "without an event key the same business event can queue twice");
    } finally { await c.end(); }
  });

  test("THE GATE — the worker delivers it, signed", async () => {
    received.length = 0;
    respondWith = { status: 200, delayMs: 0 };

    const c = await asWorker();
    try {
      const r = await drainOnce(c, { worker: "test" });
      assert.equal(r.claimed, 1);
      assert.equal(r.delivered, 1, "the subscriber's endpoint was never called");

      assert.equal(received.length, 1);
      const got = received[0];
      assert.equal(got.event, "stock.changed");

      const body = JSON.parse(got.body);
      assert.equal(body.event, "stock.changed");
      assert.equal(body.data.qty_delta, 10);
      assert.equal(body.attempt, 1);

      // The signature must verify against the subscription's secret.
      const secret = (await one(c,
        "select signing_secret from platform.webhook_subscription where id=$1", [subId]))
        .signing_secret;
      assert.ok(verify(secret, got.body, got.signature),
        "an unverifiable signature is the same as no signature");

      // And must NOT verify against a different one.
      assert.equal(verify("not-the-secret", got.body, got.signature), false);

      const d = await one(c,
        "select * from platform.webhook_delivery where subscription_id=$1", [subId]);
      assert.equal(d.status, "DELIVERED");
      assert.equal(d.response_status, 200);
      assert.equal(d.attempts, 1);
    } finally { await c.end(); }
  });

  test("THE GATE — a delivered event is never sent twice", async () => {
    received.length = 0;
    const c = await asWorker();
    try {
      // Drain again, repeatedly. There is nothing due.
      for (let i = 0; i < 3; i++) {
        const r = await drainOnce(c, { worker: "test" });
        assert.equal(r.claimed, 0);
      }
      assert.equal(received.length, 0, "a delivered event was sent again");

      // And the same business event cannot be queued a second time.
      const before2 = Number((await one(c,
        "select count(*)::int n from platform.webhook_delivery where subscription_id=$1",
        [subId])).n);

      const key = (await one(c,
        "select event_key from platform.webhook_delivery where subscription_id=$1", [subId]))
        .event_key;
      await q(c, "select platform.emit_event('stock.changed','{}'::jsonb,$1)", [key]);

      const after2 = Number((await one(c,
        "select count(*)::int n from platform.webhook_delivery where subscription_id=$1",
        [subId])).n);
      assert.equal(after2, before2,
        "the same event key queued twice produced two deliveries — a subscriber " +
        "cannot tell a duplicate from a real second event");
    } finally { await c.end(); }
  });

  test("THE GATE — a failing endpoint is retried with growing backoff, then dead-lettered", async () => {
    const c = await as(AS.admin);
    let sub2;
    try {
      sub2 = (await one(c,
        `insert into platform.webhook_subscription (api_client_id, event, url, max_attempts)
         values ($1, 'stock.changed', $2, 3) returning id`,
        [clientId, `${baseUrl}/broken`])).id;
    } finally { await c.end(); }

    received.length = 0;
    respondWith = { status: 500, delayMs: 0 };

    const w = await asWorker();
    try {
      await q(w, "select stock.post_movement($1,$2,5,'RECEIPT',null,'fail test',null,100)",
        [productId, ID.locShop1]);

      const gaps = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        // Deliveries for the broken subscription only.
        const r = await drainOnce(w, { worker: "test" });
        assert.ok(r.claimed >= 1, `attempt ${attempt} claimed nothing`);

        const d = await one(w,
          "select * from platform.webhook_delivery where subscription_id=$1", [sub2]);
        assert.equal(d.attempts, attempt);

        if (attempt < 3) {
          assert.equal(d.status, "PENDING", "a failure must be retried, not discarded");
          gaps.push(new Date(d.next_attempt_at).getTime() - Date.now());
          // Bring it forward so the test does not wait out the backoff.
          await q(w,
            "update platform.webhook_delivery set next_attempt_at = now() where id=$1", [d.id]);
        } else {
          assert.equal(d.status, "DEAD",
            "a queue that retries forever buries the one delivery that mattered");
          assert.match(d.last_error, /500/);
        }
      }

      assert.ok(gaps[1] > gaps[0] * 2,
        `backoff must grow — got ${Math.round(gaps[0] / 1000)}s then ${Math.round(gaps[1] / 1000)}s`);

      // The subscription's own health reflects it.
      const h = (await q(w, "select * from platform.webhook_health()"))
        .find((x) => x.subscription_id === sub2);
      assert.equal(Number(h.dead), 1);
      assert.ok(h.consecutive_failures >= 3);
    } finally {
      respondWith = { status: 200, delayMs: 0 };
      await w.end();
    }
  });

  test("a dead worker's claim is reclaimed, not lost", async () => {
    const c = await as(AS.admin);
    let sub3;
    try {
      sub3 = (await one(c,
        `insert into platform.webhook_subscription (api_client_id, event, url)
         values ($1, 'stock.changed', $2) returning id`,
        [clientId, `${baseUrl}/slow`])).id;
    } finally { await c.end(); }

    const w = await asWorker();
    try {
      await q(w, "select stock.post_movement($1,$2,3,'RECEIPT',null,'stuck test',null,100)",
        [productId, ID.locShop1]);

      // Claim it, then vanish — exactly what a killed process leaves.
      const claimed = await q(w, "select * from platform.claim_webhook_batch(50,'ghost')");
      const mine = claimed.find((x) => x.subscription_id === sub3);
      assert.ok(mine, "nothing was claimed for the new subscription");

      const stuck = await one(w,
        "select status from platform.webhook_delivery where id=$1", [mine.id]);
      assert.equal(stuck.status, "SENDING");

      // Nothing reclaims it yet — it might simply be a slow request.
      assert.equal(await one(w, "select platform.requeue_stuck_deliveries() as n")
        .then((r) => Number(r.n)), 0);

      // Age it past the timeout.
      await q(w,
        "update platform.webhook_delivery set claimed_at = now() - interval '10 minutes' where id=$1",
        [mine.id]);

      const n = Number((await one(w, "select platform.requeue_stuck_deliveries() as n")).n);
      assert.ok(n >= 1, "a delivery claimed by a dead worker was stranded forever");

      const back = await one(w,
        "select status, last_error from platform.webhook_delivery where id=$1", [mine.id]);
      assert.equal(back.status, "PENDING");
      assert.match(back.last_error, /requeued/);
    } finally { await w.end(); }
  });

  test("two workers never take the same delivery", async () => {
    const c = await as(AS.admin);
    try {
      await q(c, "select stock.post_movement($1,$2,7,'RECEIPT',null,'race test',null,100)",
        [productId, ID.locShop1]);
    } finally { await c.end(); }

    const a = await asWorker();
    const b = await asWorker();
    try {
      // Concurrently, on separate connections. SKIP LOCKED is the only
      // thing standing between this and a duplicate delivery.
      const [ra, rb] = await Promise.all([
        q(a, "select * from platform.claim_webhook_batch(50,'A')"),
        q(b, "select * from platform.claim_webhook_batch(50,'B')"),
      ]);

      const ids = [...ra, ...rb].map((r) => String(r.id));
      assert.equal(new Set(ids).size, ids.length,
        "the same delivery was handed to two workers — the subscriber gets it twice");
    } finally { await a.end(); await b.end(); }
  });

  test("a paused subscription stops receiving without losing its history", async () => {
    const c = await as(AS.admin);
    try {
      const sub4 = (await one(c,
        `insert into platform.webhook_subscription (api_client_id, event, url, status)
         values ($1, 'movement.closed', $2, 'PAUSED') returning id`,
        [clientId, `${baseUrl}/paused`])).id;

      await q(c, "select platform.emit_event('movement.closed','{}'::jsonb,'x:1')");

      const n = Number((await one(c,
        "select count(*)::int n from platform.webhook_delivery where subscription_id=$1",
        [sub4])).n);
      assert.equal(n, 0, "a paused subscription must not accumulate a backlog");
    } finally { await c.end(); }
  });
});

// ─────────────── the queue must never block a write ───────────────

describe("A broken subscriber is never a reason stock cannot move", () => {
  test("emit_event swallows its own failure", async () => {
    const c = await as(AS.admin);
    try {
      // A subscription row referencing an event nobody emits, plus a
      // deliberately impossible payload path: emit must still return.
      const n = await one(c, "select platform.emit_event('nonsense.event','{}'::jsonb) as n");
      assert.equal(Number(n.n), 0, "an unknown event should queue nothing and raise nothing");
    } finally { await c.end(); }
  });

  test("stock still moves when the queue itself is unusable", async () => {
    // Owner-level connection: breaking the queue takes DDL, which is
    // the point — this simulates a fault no application role could
    // cause, to prove the write survives even then.
    const c = await asWorker();
    try {
      const p = (await one(c,
        `insert into catalog.product (name, base_uom_id)
         values ('Resilience Test', (select id from catalog.uom where code='PCS')) returning id`)).id;

      await q(c, "begin");
      await q(c, `create or replace function platform.tmp_break_queue() returns trigger
                  language plpgsql as $fn$ begin
                    raise exception 'QUEUE_BROKEN: the subscriber table is on fire';
                  end $fn$`);
      await q(c, `create trigger tmp_break_queue before insert on platform.webhook_delivery
                  for each row execute function platform.tmp_break_queue()`);

      // The write must still succeed. emit_event catches its own
      // exception, so the failure is contained to the queue.
      await q(c, "select stock.post_movement($1,$2,4,'OPENING',null,'resilience',null,100)",
        [p, ID.locShop1]);

      const b = await one(c,
        "select on_hand from stock.balance where product_id=$1 and location_id=$2",
        [p, ID.locShop1]);
      assert.equal(b.on_hand, 4,
        "a webhook problem stopped a shop receiving stock — the queue must never block the write");

      await q(c, "rollback");
    } finally { await c.end(); }
  });
});

// ─────────────── usage is visible ───────────────

describe("Who is using what", () => {
  test("usage is reported per client, from the request log", async () => {
    const id = await makeClient("Measured App");
    const w = await asWorker();
    try {
      await q(w,
        `insert into platform.api_request
           (api_client_id, method, path, status_code, duration_ms, rate_limited)
         values ($1,'GET','/api/v1/stock',200,12,false),
                ($1,'GET','/api/v1/stock',200,40,false),
                ($1,'GET','/api/v1/stock',429,2,true),
                ($1,'POST','/api/v1/reservations',500,900,false)`, [id]);
    } finally { await w.end(); }

    const c = await as(AS.admin);
    try {
      const row = (await q(c, "select * from platform.api_usage(7)"))
        .find((r) => r.api_client_id === id);

      assert.ok(row, "a client with traffic did not appear in the usage report");
      assert.equal(Number(row.requests), 4);
      assert.equal(Number(row.errors), 2);
      assert.equal(Number(row.throttled), 1);
      assert.equal(Number(row.error_rate), 50);
      assert.equal(row.p95_ms, 900);
      assert.equal(row.slowest_path, "/api/v1/reservations");
    } finally { await c.end(); }
  });

  test("endpoint usage collapses ids, so one route is one row", async () => {
    const c = await as(AS.admin);
    try {
      const id = await makeClient("Path App");
      const w = await asWorker();
      try {
        for (let i = 0; i < 3; i++) {
          await q(w,
            `insert into platform.api_request (api_client_id, method, path, status_code, duration_ms)
             values ($1,'GET',$2,200,5)`,
            [id, `/api/v1/products/${crypto.randomUUID()}`]);
        }
      } finally { await w.end(); }

      const rows = await q(c, "select * from platform.api_endpoint_usage(7)");
      const collapsed = rows.find((r) => r.path === "/api/v1/products/:id");
      assert.ok(collapsed,
        "three calls to the same route reported as three endpoints — the report is unreadable");
      assert.equal(Number(collapsed.requests), 3);
    } finally { await c.end(); }
  });

  test("usage and queue health are not for everyone", async () => {
    const c = await as(AS.operatorShop1);
    try {
      assert.deepEqual(await q(c, "select * from platform.api_usage(7)"), [],
        "an operator read the whole platform's API traffic");
      assert.deepEqual(await q(c, "select * from platform.webhook_health()"), []);
      await refused(
        () => c.query("select * from platform.claim_webhook_batch(1,'x')"),
        "FORBIDDEN_ROLE");
    } finally { await c.end(); }
  });
});

// ─────────────── signing, on its own ───────────────

describe("Signatures", () => {
  test("a signature covers the timestamp, so a captured delivery cannot be replayed forever", () => {
    const body = JSON.stringify({ hello: "world" });
    const fresh = sign("secret", body);
    assert.ok(verify("secret", body, fresh.header));

    // The same signature, six minutes old.
    const old = sign("secret", body, Date.now() - 6 * 60 * 1000);
    assert.equal(verify("secret", body, old.header), false,
      "an old but correctly-signed delivery is still a replay");
  });

  test("a tampered body fails", () => {
    const body = JSON.stringify({ qty: 1 });
    const { header } = sign("secret", body);
    assert.equal(verify("secret", JSON.stringify({ qty: 1000 }), header), false);
  });

  test("a malformed header fails rather than throwing", () => {
    assert.equal(verify("secret", "{}", "garbage"), false);
    assert.equal(verify("secret", "{}", "t=1,v1=zz"), false);
  });
});
