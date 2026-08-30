import { storefrontRoute, preflight, resolveLocation } from "@/lib/api/storefront";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/**
 * POST /api/inventory/reserve
 *
 *   { "order_id": "ord_987", "location": "SH1",
 *     "items": [{ "sku": "PRD-2026-000001", "quantity": 2 }] }
 *
 * Holds the whole order or none of it. A 409 carries every line, so
 * the storefront can tell the customer exactly what is short while
 * they are still there — not after they have paid.
 *
 * Idempotent by order_id: a retry after a timeout returns the same
 * holds rather than taking a second set of stock off the shelf.
 */
export const POST = storefrontRoute("reservations:write", async (ctx, req) => {
  const body = await req.json().catch(() => null);
  if (!body?.order_id || !Array.isArray(body.items)) {
    return {
      status: 400,
      body: {
        error: "bad_request",
        message: 'Send { order_id, location, items: [{ sku, quantity }] }.',
      },
    };
  }

  // The body's location is passed IN, not consulted afterwards. The
  // first version fell back to the key's own shop when the query
  // string was empty, which silently answered a HUB request for SH1.
  const loc = await resolveLocation(ctx, req, body.location ?? null);

  if (!loc) {
    return {
      status: 400,
      body: {
        error: "location_required",
        message: "Name the shop this order is being sold from — stock is per location.",
      },
    };
  }

  const { rows } = await ctx.db.query(
    "select * from stock.reserve_order($1,$2,$3::jsonb,$4)",
    [body.order_id, loc.id, JSON.stringify(body.items), body.ttl_seconds ?? 1800]);

  const ok = rows.length > 0 && rows.every((r: any) => r.ok);

  const lines = rows.map((r: any) => ({
    sku: r.sku,
    requested: r.requested,
    available: r.available,
    reservation_id: r.reservation_id,
    problem: r.problem,
  }));

  if (!ok) {
    return {
      status: 409,
      body: {
        ok: false,
        order_id: body.order_id,
        location: loc.code,
        message: "Nothing was held. Every line is listed so you can offer a substitute " +
                 "or reduce the quantity.",
        items: lines,
      },
    };
  }

  return {
    status: 201,
    body: { ok: true, order_id: body.order_id, location: loc.code, items: lines },
  };
});
