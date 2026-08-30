// The webhook delivery worker.
//
// Runs as a loop against the queue. Safe to run several of: claiming
// uses FOR UPDATE SKIP LOCKED, so two workers never take the same
// delivery (migration 0035).
//
// ── Where this runs in production ──
//
// Not on Vercel. A serverless function is the wrong shape for a
// worker: it is billed by wall-clock time and killed mid-flight,
// which is exactly the crash the SENDING state exists to survive.
// Run it as a small always-on process, or call the drain route from a
// scheduler.
//
// On Supabase the alternative is pg_cron plus pg_net, calling
// net.http_post() straight from the database. That keeps the job
// transactional with its data, which docs/02 §4 prefers — but pg_net
// is not in a plain postgres:16-alpine, so this exists to be runnable
// and testable locally.
//
//   node scripts/webhook-worker.mjs            # loop
//   node scripts/webhook-worker.mjs --once     # single pass, for cron

import pg from "pg";
import { CONNECTION } from "./db-config.mjs";
import { drainOnce } from "../lib/webhooks.ts";

const once = process.argv.includes("--once");
const IDLE_MS = Number(process.env.WEBHOOK_IDLE_MS ?? 2000);
const BATCH = Number(process.env.WEBHOOK_BATCH ?? 20);
const NAME = process.env.WEBHOOK_WORKER ?? `worker-${process.pid}`;

const pool = new pg.Pool({ connectionString: CONNECTION, max: 2 });

// A pool that has ever had an idle client drop emits 'error' on the
// pool itself; without a handler Node treats it as unhandled and
// takes the worker down. Same fault that killed the dev server in
// Phase 4.
pool.on("error", (e) => console.error("[webhooks] pool error:", e.message));

let running = true;
for (const sig of ["SIGINT", "SIGTERM"]) {
  // Finish the pass in flight rather than abandoning claimed rows to
  // the reclaim sweep.
  process.on(sig, () => { running = false; });
}

async function pass() {
  const c = await pool.connect();
  try {
    // The worker is an operator of the queue, not a user of the
    // inventory. It gets the admin claim set and nothing else — it
    // never reads stock, and the queue functions check the role.
    await c.query("select set_config('request.jwt.claims', $1, false)", [
      JSON.stringify({ sub: null, role: "admin", all_locations: true, location_ids: "" }),
    ]);
    return await drainOnce(c, { batch: BATCH, worker: NAME });
  } finally {
    c.release();
  }
}

try {
  do {
    const r = await pass();
    if (r.claimed) {
      console.log(
        `[webhooks] claimed ${r.claimed}  delivered ${r.delivered}` +
        `  retrying ${r.failed}  dead ${r.dead}`);
    }
    // Only sleep when the queue was empty. A full batch means there is
    // more waiting, and sleeping through a backlog is how a queue that
    // "works" still runs an hour behind.
    if (running && !once && r.claimed < BATCH) {
      await new Promise((r2) => setTimeout(r2, IDLE_MS));
    }
  } while (running && !once);
} finally {
  await pool.end();
}
