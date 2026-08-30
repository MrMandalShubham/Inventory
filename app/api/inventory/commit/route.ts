import { storefrontRoute, preflight } from "@/lib/api/storefront";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/**
 * POST /api/inventory/commit   { "order_id": "ord_987" }
 *
 * The order was delivered. The hold becomes a real reduction and a
 * ledger entry is written — until this call the stock was held but
 * still on the shelf, which is exactly what a hold means.
 *
 * Safe to retry: an order already committed returns its lines again
 * rather than reducing stock twice.
 */
export const POST = storefrontRoute("reservations:write", async (ctx, req) => {
  const body = await req.json().catch(() => null);
  if (!body?.order_id) {
    return { status: 400, body: { error: "bad_request", message: "Send { order_id }." } };
  }

  const { rows } = await ctx.db.query(
    "select * from stock.commit_order($1)", [body.order_id]);

  if (rows.length === 0) {
    // Nothing left to consume, and the order exists — it was already
    // delivered. Report what happened rather than an error a retry
    // would keep hitting.
    const { rows: status } = await ctx.db.query(
      "select * from stock.order_status($1)", [body.order_id]);

    return {
      body: {
        ok: true,
        order_id: body.order_id,
        already_committed: true,
        items: status.map((s: any) => ({ sku: s.sku, quantity: s.quantity, status: s.status })),
      },
    };
  }

  return {
    body: {
      ok: true,
      order_id: body.order_id,
      items: rows.map((r: any) => ({
        sku: r.sku, quantity: r.quantity, ledger_entry_id: Number(r.ledger_id),
      })),
    },
  };
});
