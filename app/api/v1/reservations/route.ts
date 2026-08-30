import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/reservations
 *
 * Hold stock for a checkout in progress. This is the endpoint the
 * buy/sell app leans on, and the one the Phase 4 gate is about:
 * 200 concurrent calls against 100 units must yield exactly 100
 * successes and zero oversells.
 *
 * Held at checkout, NOT at add-to-cart — see migration 0019.
 */
export const POST = apiRoute(
  { scope: "reservations:write", idempotent: true },
  async ({ db, body, req }) => {
    const { product_id, location_id, quantity, order_ref, ttl_seconds } = body ?? {};

    if (!product_id || !location_id || !quantity) {
      return {
        status: 400,
        body: {
          error: {
            code: "invalid_request",
            message: "product_id, location_id and quantity are required.",
          },
        },
      };
    }

    // ctx.db is the wrapper's session connection: claims set, role
    // switched, RLS applying. A fresh pool connection here would be
    // anonymous and see nothing.
    {
      const { rows } = await db.query(
        "select stock.reserve($1,$2,$3,$4,$5,$6) as id",
        [product_id, location_id, quantity, order_ref ?? null,
         ttl_seconds ?? 900, req.headers.get("idempotency-key")]);

      const id = rows[0].id;
      const r = (await db.query(
        `select id, product_id, location_id, quantity, status, order_ref, expires_at
           from stock.reservation where id = $1`, [id])).rows[0];

      return { status: 201, body: { reservation: r } };
    }
  },
);

/** GET /api/v1/reservations?status=HELD */
export const GET = apiRoute({ scope: "stock:read" }, async ({ db, req }) => {
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const orderRef = url.searchParams.get("order_ref");

  {
    const { rows } = await db.query(
      `select id, product_id, location_id, quantity, status, order_ref,
              expires_at, created_at
         from stock.reservation
        where ($1::text is null or status = $1)
          and ($2::text is null or order_ref = $2)
        order by created_at desc limit 200`,
      [status, orderRef]);
    return { body: { reservations: rows } };
  }
});
