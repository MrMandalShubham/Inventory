import { storefrontRoute, preflight, resolveLocation, toStorefrontProduct } from "@/lib/api/storefront";
import { imageBase, urlFor } from "@/lib/api/images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/**
 * GET /api/products?location=SH1&category=dairy&search=milk&limit=&offset=
 *
 * Products with their price and their stock AT THAT LOCATION.
 *
 * Location is the whole point. "How many do we have" has no answer
 * across a chain — Shop 1 having ten does not help a customer buying
 * from Shop 3. Without a location this returns the catalogue with
 * stock reported as null rather than inventing a total nobody can act
 * on.
 */
export const GET = storefrontRoute("catalog:read", async (ctx, req) => {
  const url = new URL(req.url);
  const loc = await resolveLocation(ctx, req);

  const category = url.searchParams.get("category");
  const search = url.searchParams.get("search");
  const inStock = url.searchParams.get("in_stock") === "true";
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 200);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);

  const { rows } = await ctx.db.query(`
    select p.id, p.sku_code, p.slug, p.name, p.description,
           p.category_id, p.pack_size, u.code as uom,
           pr.retail_paise, pr.mrp_paise, pr.wholesale_paise,

           -- What may be PROMISED, not what is on the shelf: stock
           -- already held for somebody else's order is not for sale.
           b.free as available,

           -- Cost is shaped out again unless the key holds cost:read.
           b.weighted_avg_cost as cost_paise,

           img.storage_key, img.thumb_key, img.alt_text
      from catalog.product p
      join catalog.uom u on u.id = p.base_uom_id
      left join lateral catalog.price_for(p.id, $1::uuid) pr on true
      -- Availability is the sum across EVERY balance row for this
      -- product here: the batch-less row and every lot. Migration 0054
      -- moved lot-tracked stock into lots, and a join pinned to
      -- "batch_id is null" then matched nothing and reported zero —
      -- which showed 84 of 118 products as out of stock on a live
      -- storefront. Cost is quantity-weighted across the lots, because
      -- averaging the averages would weight a lot of 2 like a lot of 900.
      left join lateral (
        select coalesce(sum(x.on_hand - x.reserved - x.allocated - x.damaged), 0)::int
                 as free,
               case when coalesce(sum(x.on_hand), 0) > 0
                    then sum(x.on_hand * x.weighted_avg_cost) / sum(x.on_hand)
                    else max(x.weighted_avg_cost) end as weighted_avg_cost
          from stock.balance x
         where x.product_id = p.id and x.location_id = $1::uuid
      ) b on true
      left join catalog.product_image img
             on img.product_id = p.id and img.is_primary
     where p.status = 'ACTIVE'
       and ($2::text is null or p.category_id = $2)
       and ($3::text is null
            or p.name ilike '%' || $3 || '%'
            or p.sku_code ilike '%' || $3 || '%')
       and (not $4::boolean or b.free > 0)
     order by p.name
     limit $5 offset $6`,
    [loc?.id ?? null, category, search, inStock, limit, offset]);

  const base = imageBase(req);

  return {
    body: rows.map((r: any) =>
      toStorefrontProduct({
        ...r,
        // No location asked for means no stock figure — null is
        // honest, zero would read as "out of stock everywhere".
        available: loc ? r.available : null,
        image_url: r.storage_key
          ? urlFor(r.thumb_key ?? r.storage_key, base)
          : null,
      }, ctx.scopes)),
  };
});
