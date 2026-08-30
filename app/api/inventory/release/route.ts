import { storefrontRoute, preflight } from "@/lib/api/storefront";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/**
 * POST /api/inventory/release   { "order_id": "ord_987", "reason": "…" }
 *
 * The order was cancelled. The held stock goes back on the shelf and
 * becomes sellable again immediately.
 *
 * Holds also expire on their own — a checkout abandoned mid-payment
 * is released by the sweeper without anybody calling this. That job
 * is mandatory in production: without it abandoned carts hold stock
 * forever and the symptom looks exactly like a stockout.
 */
export const POST = storefrontRoute("reservations:write", async (ctx, req) => {
  const body = await req.json().catch(() => null);
  if (!body?.order_id) {
    return { status: 400, body: { error: "bad_request", message: "Send { order_id }." } };
  }

  const { rows: [r] } = await ctx.db.query(
    "select stock.release_order($1,$2) as released",
    [body.order_id, body.reason ?? "cancelled by the selling app"]);

  return {
    body: { ok: true, order_id: body.order_id, released: Number(r.released) },
  };
});
