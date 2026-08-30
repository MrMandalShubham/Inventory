import { apiRoute } from "@/lib/api/handler";
import { imagesFor, imageBase } from "@/lib/api/images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/products — catalogue search. `q` hits the same
 *  function the dashboard and a scanner use: exact on code or
 *  barcode first, then word-similarity on the name.
 *
 *  Images come back on every row. A customer app listing a category
 *  needs the picture in the same response as the name — one round trip
 *  per screen, not one per tile. */
export const GET = apiRoute({ scope: "catalog:read" }, async ({ db, req }) => {
  const url = new URL(req.url);
  const q = url.searchParams.get("q");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const base = imageBase(req);

  const rows = q
    ? (await db.query(
        `select s.id, s.sku_code, s.name, s.category, s.match_kind, s.score,
                p.description, p.tracking_mode, p.is_weighed, u.code as uom
           from catalog.search_products($1,$2) s
           join catalog.product p on p.id = s.id
           join catalog.uom u on u.id = p.base_uom_id`, [q, limit])).rows
    : (await db.query(
        `select p.id, p.sku_code, p.name, p.category, p.description, p.tracking_mode,
                p.is_weighed, p.hsn_code, u.code as uom
           from catalog.product p
           join catalog.uom u on u.id = p.base_uom_id
          where p.status = 'ACTIVE'
          order by p.sku_code limit $1`, [limit])).rows;

  const images = await imagesFor(db, rows.map((r: any) => r.id), base);

  return {
    body: {
      products: rows.map((r: any) => ({
        ...r,
        images: images[r.id] ?? [],
        // The one a tile renders. Named separately so a client does
        // not have to scan the array and pick — and so "no photo yet"
        // is an explicit null rather than an empty array to interpret.
        image: (images[r.id] ?? []).find((i) => i.primary)?.url ?? null,
      })),
    },
  };
});
