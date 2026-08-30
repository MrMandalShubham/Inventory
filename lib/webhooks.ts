import { createHmac, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";

/**
 * Webhook delivery.
 *
 * The database owns the queue — claiming, backoff, dead-lettering,
 * reclaiming after a crash (migration 0035). This file is only the
 * part Postgres cannot do: making an HTTP request.
 *
 * That split is deliberate. Everything that decides *whether* and
 * *when* a delivery happens is testable in SQL and survives this
 * process being killed halfway through.
 */

const VERSION = "v1";

/**
 * Sign a payload.
 *
 * The timestamp is inside the signed string, not beside it. Signing
 * only the body lets an attacker who captures one delivery replay it
 * forever; signing `t.body` means the receiver can reject anything
 * older than a few minutes and the signature covers the age claim.
 */
export function sign(secret: string, body: string, at = Date.now()) {
  const t = Math.floor(at / 1000);
  const mac = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return { header: `t=${t},${VERSION}=${mac}`, t, mac };
}

/**
 * Verify a signature. Exported because the integration guide tells
 * subscribers to do exactly this, and shipping the code we describe
 * beats describing code we have not run.
 */
export function verify(
  secret: string, body: string, header: string, toleranceSeconds = 300,
): boolean {
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.split("=").map((x) => x.trim()) as [string, string]));
  const t = Number(parts.t);
  const got = parts[VERSION];
  if (!t || !got) return false;

  // A replay of a genuine, correctly-signed delivery is still a
  // replay. Age is part of validity.
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;

  const want = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  const a = Buffer.from(want, "hex");
  const b = Buffer.from(got, "hex");
  // Length check first: timingSafeEqual throws on a mismatch, and a
  // throw here would read as "invalid" anyway but noisily.
  return a.length === b.length && timingSafeEqual(a, b);
}

export type Claimed = {
  id: string;
  subscription_id: string;
  event: string;
  payload: unknown;
  attempts: number;
  url: string;
  signing_secret: string;
};

export type DrainResult = {
  claimed: number;
  delivered: number;
  failed: number;
  dead: number;
};

/**
 * Deliver one claimed event.
 *
 * Returns rather than throws: every outcome — refused, timed out,
 * DNS failure, a 500 from the subscriber — is a normal result that
 * belongs in the delivery record. An exception escaping here would
 * abandon the row in SENDING until the reclaim sweep found it.
 */
export async function deliverOne(
  d: Claimed, timeoutMs = 10_000,
): Promise<{ ok: boolean; status: number | null; error: string | null; ms: number }> {
  const body = JSON.stringify({
    id: String(d.id),
    event: d.event,
    attempt: d.attempts + 1,
    data: d.payload,
  });

  const { header } = sign(d.signing_secret, body);
  const started = Date.now();

  // A subscriber that never closes the connection would otherwise
  // hold a worker slot forever.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  try {
    const res = await fetch(d.url, {
      method: "POST",
      signal: abort.signal,
      headers: {
        "content-type": "application/json",
        "user-agent": "InventoryCore-Webhooks/1",
        "X-Inventory-Event": d.event,
        "X-Inventory-Delivery": String(d.id),
        "X-Inventory-Signature": header,
      },
      body,
    });

    // 2xx is success. Everything else is retried — including a 404,
    // because an endpoint moved during a deploy comes back, and
    // including a 401, because a rotated secret gets fixed.
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      error: res.ok ? null : `HTTP ${res.status}`,
      ms: Date.now() - started,
    };
  } catch (e: any) {
    return {
      ok: false,
      status: null,
      error: e?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : String(e?.message ?? e),
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One pass over the queue.
 *
 * Deliveries go out CONCURRENTLY. One slow subscriber must not delay
 * everybody else's events — that is how a queue with one bad endpoint
 * becomes a queue that delivers nothing.
 */
export async function drainOnce(
  db: PoolClient,
  { batch = 20, worker = "worker", timeoutMs = 10_000 } = {},
): Promise<DrainResult> {
  // Rows abandoned by a worker that died mid-flight. Cheap, and
  // without it a single crash silently strands those events forever.
  await db.query("select platform.requeue_stuck_deliveries()");

  const { rows } = await db.query(
    "select * from platform.claim_webhook_batch($1, $2)", [batch, worker]);

  const out: DrainResult = { claimed: rows.length, delivered: 0, failed: 0, dead: 0 };
  if (!rows.length) return out;

  const results = await Promise.all(
    (rows as Claimed[]).map(async (d) => ({ d, r: await deliverOne(d, timeoutMs) })));

  for (const { d, r } of results) {
    const { rows: [state] } = await db.query(
      "select platform.record_webhook_result($1,$2,$3,$4,$5) as s",
      [d.id, r.ok, r.status, r.error, r.ms]);

    if (r.ok) out.delivered += 1;
    else if (state.s === "DEAD") out.dead += 1;
    else out.failed += 1;
  }

  return out;
}
