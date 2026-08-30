import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/v1/reservations/:id/consume — the goods physically left.
 *  The ONLY step in the reservation lifecycle that writes to the
 *  ledger; up to here nothing had moved. */
export const POST = apiRoute(
  { scope: "reservations:write", idempotent: true },
  async ({ db, params }) => {
    const led = (await db.query("select stock.consume_reservation($1) as id",
      [params.id])).rows[0].id;

    const r = (await db.query(
      `select id, product_id, location_id, quantity, status, consumed_at
         from stock.reservation where id = $1`, [params.id])).rows[0];

    return { body: { reservation: r, ledger_entry_id: led } };
  },
);
