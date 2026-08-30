import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/stock — the most-called endpoint in the system.
 *
 * `available` is what may actually be sold: on_hand minus what is
 * reserved, allocated or damaged. A client that reads on_hand and
 * sells against it will oversell.
 */
export const GET = apiRoute({ scope: "stock:read" }, async ({ db, req }) => {
  const url = new URL(req.url);
  const product = url.searchParams.get("product_id");
  const location = url.searchParams.get("location_id");
  const sku = url.searchParams.get("sku_code");

  const { rows } = await db.query(
    `select b.product_id, p.sku_code, p.name,
            b.location_id, l.code as location_code,
            b.batch_id, bt.lot_no, bt.expiry_date,
            b.on_hand, b.reserved, b.allocated, b.damaged, b.available,
            u.code as uom
       from stock.balance b
       join catalog.product p on p.id = b.product_id
       join catalog.uom u on u.id = p.base_uom_id
       join platform.location l on l.id = b.location_id
       left join stock.batch bt on bt.id = b.batch_id
      where ($1::uuid is null or b.product_id = $1)
        and ($2::uuid is null or b.location_id = $2)
        and ($3::text is null or p.sku_code = $3)
        and l.type <> 'VIRTUAL'
      order by l.code, p.sku_code
      limit 500`,
    [product, location, sku]);

  return { body: { stock: rows } };
});
