import { storefrontRoute, preflight } from "@/lib/api/storefront";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/**
 * GET /api/inventory/order/:order_id
 *
 * Not in the original specification, and the one that saves you.
 *
 * When a reserve call times out the caller cannot tell whether it
 * landed. Without this the only options are to reserve again — which
 * holds the stock twice — or to abandon it and wait for the hold to
 * expire. This answers the question directly.
 */
export const GET = storefrontRoute("stock:read", async (ctx, _req, params) => {
  const { rows } = await ctx.db.query(
    "select * from stock.order_status($1)", [params.order_id]);

  if (rows.length === 0) {
    return {
      status: 404,
      body: {
        error: "not_found",
        message: `Nothing was ever reserved for ${params.order_id}. If a reserve call ` +
                 "timed out, it did not land — it is safe to send it again.",
      },
    };
  }

  const states = new Set(rows.map((r: any) => r.status));

  return {
    body: {
      order_id: params.order_id,
      // One word the caller can branch on, rather than making every
      // client work it out from a set of line states.
      status: states.has("HELD") || states.has("CONFIRMED") ? "held"
            : states.has("CONSUMED") ? "delivered"
            : "released",
      items: rows.map((r: any) => ({
        sku: r.sku, quantity: r.quantity,
        status: r.status.toLowerCase(), expires_at: r.expires_at,
      })),
    },
  };
});
