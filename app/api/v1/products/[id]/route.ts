import { apiRoute } from "@/lib/api/handler";
import { imagesFor, imageBase } from "@/lib/api/images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/products/{id}
 *
 * One product, everything a customer app needs to render a detail
 * page: the description, the pack size, the barcodes, the gallery.
 *
 * `id` accepts either the uuid or the SKU code, because the code is
 * what a person reads off a shelf label and what a scanner produces,
 * and making an integrator look up a uuid first to ask about a product
 * they can already name is a round trip for nothing.
 */
export const GET = apiRoute({ scope: "catalog:read" }, async ({ db, req, params }) => {
  const key = params.id;
  const base = imageBase(req);

  const { rows } = await db.query(
    `select p.id, p.sku_code, p.name, p.description, p.category,
            p.tracking_mode, p.is_weighed, p.hsn_code, p.shelf_life_days,
            p.status, u.code as uom, u.name as uom_name
       from catalog.product p
       join catalog.uom u on u.id = p.base_uom_id
      where p.sku_code = $1
         or ($1 ~ '^[0-9a-f-]{36}$' and p.id = $1::uuid)`, [key]);

  const product = rows[0];
  if (!product) {
    return { status: 404, body: { error: { code: "not_found", message: `No product ${key}` } } };
  }

  const barcodes = (await db.query(
    "select barcode from catalog.product_barcode where product_id = $1", [product.id]))
    .rows.map((r: any) => r.barcode);

  const images = (await imagesFor(db, [product.id], base))[product.id] ?? [];

  return {
    body: {
      product: {
        ...product,
        barcodes,
        images,
        image: images.find((i) => i.primary)?.url ?? null,
      },
    },
  };
});
