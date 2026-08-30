import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/v1/reservations/:id/release — the checkout was abandoned
 *  or the order cancelled. The stock becomes available again. */
export const POST = apiRoute(
  { scope: "reservations:write", idempotent: true },
  async ({ db, params, body }) => {
    await db.query("select stock.release_reservation($1,$2)",
      [params.id, body?.reason ?? "released by client"]);

    const r = (await db.query(
      `select id, product_id, location_id, quantity, status, released_reason
         from stock.reservation where id = $1`, [params.id])).rows[0];

    return { body: { reservation: r } };
  },
);
