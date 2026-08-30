import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/ledger — the history book, queryable.
 *
 * Pass `as_of` to reconstruct the position on a past date. That is
 * free because the log is append-only, and impossible without it.
 */
export const GET = apiRoute({ scope: "stock:read" }, async ({ db, req }) => {
  const url = new URL(req.url);
  const asOf = url.searchParams.get("as_of");
  const product = url.searchParams.get("product_id");

  if (asOf) {
    const { rows } = await db.query(
      `select * from stock.balance_as_of($1::timestamptz)
        where ($2::uuid is null or product_id = $2)`, [asOf, product]);
    return { body: { as_of_position: rows, as_of_requested: asOf } };
  }

  const { rows } = await db.query(
    `select l.id, l.product_id, l.location_id, l.batch_id,
            l.qty_delta, l.balance_after, l.reason_code, l.note,
            l.movement_id, l.occurred_at, l.recorded_at
       from stock.ledger l
      where ($1::uuid is null or l.product_id = $1)
      order by l.occurred_at desc, l.id desc
      limit 200`, [product]);

  return { body: { entries: rows } };
});
