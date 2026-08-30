// Schedule the recurring jobs with pg_cron.
//
//   npm run db:jobs
//
// Idempotent: cron.schedule() replaces a job of the same name, so
// running this twice is harmless and running it after a change updates
// the schedule.
//
// ── Why pg_cron and not Vercel Cron ──
//
// These jobs are transactional with the data they touch. Releasing an
// expired reservation and decrementing the counter that tracks it must
// either both happen or neither; an HTTP call from outside the
// database cannot promise that, and the failure mode is a reserved
// counter that drifts upward until stock appears to be gone.
//
// ── One of these is mandatory ──
//
// sweep-reservations. Without it an abandoned checkout holds stock
// forever, and the symptom is indistinguishable from a genuine
// stockout — the shop sees "0 available" and reorders goods it
// already has.

import "./env.mjs";
import pg from "pg";
import { connectionOptions, CONNECTION } from "./db-config.mjs";

const JOBS = [
  {
    name: "sweep-reservations",
    schedule: "* * * * *",
    command: "select stock.sweep_expired_reservations()",
    why: "MANDATORY — abandoned checkouts otherwise hold stock forever",
  },
  {
    name: "sweep-sessions",
    schedule: "0 3 * * *",
    command: "select platform.sweep_expired_sessions()",
    why: "expired sign-ins accumulate",
  },
  {
    name: "refresh-metrics",
    schedule: "30 2 * * *",
    command: "select insight.refresh_metrics()",
    why: "demand, cover and reorder points — every planning screen reads these",
  },
  {
    name: "evaluate-alerts",
    schedule: "*/10 * * * *",
    command: "select alerting.evaluate()",
    why: "opens and closes alerts as conditions change",
  },
  {
    name: "ensure-partitions",
    schedule: "0 4 1 * *",
    command: "select stock.ensure_next_partition()",
    why: "the ledger is partitioned by month; this keeps it ahead of today",
  },
  {
    name: "sweep-api-requests",
    schedule: "0 4 * * *",
    command: "select platform.sweep_api_requests()",
    why: "the request log grows by one row per API call, forever",
  },
  {
    name: "verify-integrity",
    schedule: "0 * * * *",
    command: `do $$
      declare n integer;
      begin
        select (select count(*) from stock.verify_balances())
             + (select count(*) from movement.verify_transit())
             + (select count(*) from stock.verify_reservations())
             + (select count(*) from ledger.verify_balanced())
          into n;
        if n > 0 then
          raise warning 'INTEGRITY_DRIFT: % discrepancies found', n;
        end if;
      end $$`,
    why: "all four must return nothing; anything else is an incident, not a metric",
  },
];

const c = new pg.Client(connectionOptions());
await c.connect();

try {
  console.log(`\nScheduling jobs on ${new URL(CONNECTION).hostname}\n`);
} catch { /* unparseable */ }

const { rows: ext } = await c.query(
  "select 1 from pg_extension where extname = 'pg_cron'");

if (ext.length === 0) {
  console.error(
    "pg_cron is not enabled.\n\n" +
    "  Supabase dashboard → Database → Extensions → enable pg_cron.\n" +
    "  Without it none of these run, and the first symptom is stock that\n" +
    "  looks sold out because nothing releases abandoned holds.\n");
  process.exit(1);
}

for (const job of JOBS) {
  try {
    await c.query("select cron.schedule($1, $2, $3)", [job.name, job.schedule, job.command]);
    console.log(`  ✔ ${job.name.padEnd(20)} ${job.schedule.padEnd(12)} ${job.why}`);
  } catch (e) {
    console.log(`  ✖ ${job.name.padEnd(20)} ${e.message}`);
  }
}

const { rows: scheduled } = await c.query(
  "select jobname, schedule, active from cron.job order by jobname");

console.log(`\n${scheduled.length} job(s) now scheduled:`);
for (const j of scheduled) {
  console.log(`  ${j.jobname.padEnd(20)} ${j.schedule.padEnd(12)} ${j.active ? "active" : "INACTIVE"}`);
}

console.log(
  "\nCheck they are actually running:\n" +
  "  select jobname, status, return_message, start_time\n" +
  "    from cron.job_run_details order by start_time desc limit 20;\n");

await c.end();
