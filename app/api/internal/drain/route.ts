import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { pool } from "@/lib/db";
import { drainOnce } from "@/lib/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One pass must fit inside the platform's function timeout. Ten
// seconds per delivery, a batch of 10, and the worst case is still
// under this.
export const maxDuration = 120;

/**
 * POST /api/internal/drain
 *
 * One pass over the webhook queue, for a scheduler to call.
 *
 * ── Why this exists alongside scripts/webhook-worker.mjs ──
 *
 * That script is the right shape: a long-lived process that claims,
 * sends, records, and sleeps only when the queue is empty. Its own
 * header says so, and says why a serverless function is the wrong
 * shape — billed by wall-clock and killed mid-flight.
 *
 * This estate runs on Vercel, where there is nowhere to put a
 * long-lived process. So the queue drains by being POKED instead:
 * something on a schedule calls this, it does exactly one pass, and it
 * returns. Vercel Cron, GitHub Actions, an external cron, a laptop —
 * the route does not care, which is the point of it being HTTP.
 *
 * ── The kill risk is already handled ──
 *
 * Being killed mid-flight is the exact crash `SENDING` exists to
 * survive: a row claimed and not recorded is reclaimed by the stuck
 * sweep after its lease expires, and delivery is at-least-once by
 * design, so a subscriber that sees one twice is a subscriber that was
 * always going to. Nothing here makes that worse.
 *
 * ── Why a shared secret and not a session ──
 *
 * The caller is a scheduler, not a person, and there is nobody to sign
 * in. The other internal route uses a session because a human uploads
 * an image; this one is machine-to-machine.
 *
 * Vercel Cron sends no custom headers, so it authenticates with
 * `Authorization: Bearer $CRON_SECRET`, which Vercel injects itself.
 * WORKER_SECRET is accepted too so any other scheduler can call it.
 */

function authorised(req: NextRequest): boolean {
  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!presented) return false;

  // CRON_SECRET is what Vercel Cron sends. WORKER_SECRET is for
  // anything else. Either is enough; both are compared in constant
  // time, and an unset one can never match.
  const accepted = [process.env.CRON_SECRET, process.env.WORKER_SECRET]
    .filter((s): s is string => Boolean(s));

  let ok = false;
  for (const secret of accepted) {
    const a = Buffer.from(presented);
    const b = Buffer.from(secret);
    // Compare every candidate rather than returning early, so the time
    // taken does not reveal which secret matched or how many are set.
    if (a.length === b.length && timingSafeEqual(a, b)) ok = true;
  }
  return ok;
}

export async function POST(req: NextRequest) {
  if (!authorised(req)) {
    // Deliberately says nothing about which secrets are configured.
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const batch = Math.min(
    Math.max(Number(new URL(req.url).searchParams.get("batch") ?? 10), 1), 50);

  const client = await pool.connect();
  try {
    // The worker is an operator of the queue, not a user of the
    // inventory. It gets the admin claim and nothing else — it never
    // reads stock, and the queue functions check the role.
    await client.query("select set_config('request.jwt.claims', $1, false)", [
      JSON.stringify({ sub: null, role: "admin", all_locations: true, location_ids: "" }),
    ]);

    const result = await drainOnce(client, {
      batch,
      // Names the caller in ops logs, so "who drained this" has an
      // answer when two schedulers are accidentally both running.
      worker: `http-drain:${req.headers.get("x-vercel-id")?.slice(0, 12) ?? "manual"}`,
    });

    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  } catch (e) {
    console.error("[drain] pass failed:", e instanceof Error ? e.message : e);
    // 5xx so a scheduler's own retry/alerting notices. Claimed rows are
    // reclaimed by the stuck sweep; nothing is lost.
    return NextResponse.json({ error: "drain failed" }, { status: 500 });
  } finally {
    client.release();
  }
}

/** Vercel Cron issues GET. Same work, same auth. */
export async function GET(req: NextRequest) {
  return POST(req);
}
