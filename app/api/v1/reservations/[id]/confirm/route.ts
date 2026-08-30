import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/v1/reservations/:id/confirm — the customer paid.
 *  The hold stops expiring. Nothing moves: the stock is still on the
 *  shelf and still not sold. */
export const POST = apiRoute(
  { scope: "reservations:write", idempotent: true },
  async ({ db, params, body }) => {
    await db.query("select stock.confirm_reservation($1,$2)",
      [params.id, body?.order_ref ?? null]);

    const r = (await db.query(
      `select id, product_id, location_id, quantity, status, order_ref, expires_at
         from stock.reservation where id = $1`, [params.id])).rows[0];

    return { body: { reservation: r } };
  },
);
