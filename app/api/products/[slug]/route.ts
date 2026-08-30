import { storefrontRoute, preflight, resolveLocation, toStorefrontProduct, rupees } from "@/lib/api/storefront";
import { imageBase, urlFor } from "@/lib/api/images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/**
 * GET /api/products/:slug_or_sku?location=SH1
 *
 * Accepts the SEO slug, the SKU code or the uuid. Three ways in
 * because a storefront links by slug, a scanner produces a code, and
 * an integration holds a uuid — and making any of them look the
 * product up twice is a round trip for nothing.
 */
export const GET = storefrontRoute("catalog:read", async (ctx, req, params) => {
  const key = params.slug;
  const loc = await resolveLocation(ctx, req);
  const base = imageBase(req);

  const { rows } = await ctx.db.query(`
    select p.id, p.sku_code, p.slug, p.name, p.description,
           p.category_id, p.pack_size, p.hsn_code, p.tax_rate,
           p.is_weighed, p.shelf_life_days, u.code as uom, u.name as uom_name,
           pr.retail_paise, pr.mrp_paise, pr.wholesale_paise,
           coalesce(b.on_hand - b.reserved - b.allocated - b.damaged, 0) as available,
           b.weighted_avg_cost as cost_paise,
           c.name as category_name
      from catalog.product p
      join catalog.uom u on u.id = p.base_uom_id
      left join catalog.category c on c.id = p.category_id
      left join lateral catalog.price_for(p.id, $2::uuid) pr on true
      left join stock.balance b
             on b.product_id = p.id and b.location_id = $2::uuid and b.batch_id is null
     where p.status = 'ACTIVE'
       and (p.slug = lower($1) or p.sku_code = upper($1)
            or ($1 ~ '^[0-9a-f-]{36}$' and p.id = $1::uuid))`,
    [key, loc?.id ?? null]);

  const p = rows[0];
  if (!p) {
    return { status: 404, body: { error: "not_found", message: `No product ${key}` } };
  }

  const images = (await ctx.db.query(
    `select storage_key, thumb_key, alt_text, width, height, is_primary
       from catalog.product_image where product_id = $1
      order by is_primary desc, position`, [p.id])).rows;

  const primary = images.find((i: any) => i.is_primary) ?? images[0];

  // Where else it can be bought, so a storefront can offer another
  // shop rather than showing "out of stock" and losing the sale.
  const elsewhere = loc ? (await ctx.db.query(`
    select l.code, l.name,
           (b.on_hand - b.reserved - b.allocated - b.damaged) as available
      from stock.balance b
      join platform.location l on l.id = b.location_id
     where b.product_id = $1 and l.type <> 'VIRTUAL' and l.id <> $2
       and (b.on_hand - b.reserved - b.allocated - b.damaged) > 0
     order by 3 desc`, [p.id, loc.id])).rows : [];

  return {
    body: {
      ...toStorefrontProduct({
        ...p,
        available: loc ? p.available : null,
        image_url: primary ? urlFor(primary.thumb_key ?? primary.storage_key, base) : null,
        images: images.map((i: any) => ({
          url: urlFor(i.storage_key, base),
          thumb_url: urlFor(i.thumb_key ?? i.storage_key, base),
          alt: i.alt_text,
          width: i.width,
          height: i.height,
          primary: i.is_primary,
        })),
      }, ctx.scopes),

      category_name: p.category_name ?? null,
      sold_by_weight: p.is_weighed,
      shelf_life_days: p.shelf_life_days,
      hsn_code: p.hsn_code,
      tax_rate: p.tax_rate === null ? null : Number(p.tax_rate),
      location: loc?.code ?? null,
      available_elsewhere: elsewhere.map((e: any) => ({
        location: e.code, name: e.name, stock: Number(e.available),
      })),
    },
  };
});

/**
 * PATCH /api/products/:slug_or_sku
 *
 * Catalogue fields the selling app owns: how the product is
 * presented. Deliberately NOT stock, and not cost.
 */
export const PATCH = storefrontRoute("catalog:write", async (ctx, req, params) => {
  const body = await req.json().catch(() => null);
  if (!body) return { status: 400, body: { error: "invalid_json" } };

  const { rows: [p] } = await ctx.db.query(
    `select id from catalog.product
      where slug = lower($1) or sku_code = upper($1)
         or ($1 ~ '^[0-9a-f-]{36}$' and id = $1::uuid)`, [params.slug]);

  if (!p) return { status: 404, body: { error: "not_found", message: `No product ${params.slug}` } };

  // Only these. A whitelist rather than a spread, so a future column
  // is not writable by accident the day it is added.
  const { rows: [updated] } = await ctx.db.query(`
    update catalog.product
       set name        = coalesce($2, name),
           description = coalesce($3, description),
           category    = coalesce($4, category),
           pack_size   = coalesce($5, pack_size)
     where id = $1
    returning sku_code, slug, name, category_id, pack_size`,
    [p.id, body.name ?? null, body.description ?? null,
     body.category ?? null, body.unit ?? body.pack_size ?? null]);

  return {
    body: {
      sku: updated.sku_code,
      slug: updated.slug,
      name: updated.name,
      category: updated.category_id,
      unit: updated.pack_size,
    },
  };
});

/**
 * PUT /api/products/:slug_or_sku/price is a separate route; this
 * handles the price inline for convenience when a caller sends it
 * with the rest of a product update.
 */
export const PUT = storefrontRoute("pricing:write", async (ctx, req, params) => {
  const body = await req.json().catch(() => null);
  if (!body) return { status: 400, body: { error: "invalid_json" } };

  const { rows: [p] } = await ctx.db.query(
    `select id from catalog.product
      where slug = lower($1) or sku_code = upper($1)
         or ($1 ~ '^[0-9a-f-]{36}$' and id = $1::uuid)`, [params.slug]);

  if (!p) return { status: 404, body: { error: "not_found", message: `No product ${params.slug}` } };

  // Rupees in, paise stored. Money as a float rounds differently in
  // two places, and the difference shows up as a customer charged a
  // paisa more than the receipt says.
  const paise = (v: unknown) =>
    v === null || v === undefined ? null : Math.round(Number(v) * 100);

  const retail = paise(body.retailPrice ?? body.retail);
  const mrp = paise(body.mrp);

  if (!retail || !mrp) {
    return {
      status: 422,
      body: {
        error: "price_required",
        message: "Both retailPrice and mrp are required. Selling above MRP is illegal, " +
                 "so the two are set together.",
      },
    };
  }

  const loc = await resolveLocation(ctx, req);

  await ctx.db.query("select catalog.set_price($1,$2,$3,$4,$5)",
    [p.id, retail, mrp, paise(body.wholesalePrice ?? body.wholesale), loc?.id ?? null]);

  const { rows: [now] } = await ctx.db.query(
    "select * from catalog.price_for($1,$2)", [p.id, loc?.id ?? null]);

  return {
    body: {
      sku: params.slug,
      location: loc?.code ?? null,
      retailPrice: rupees(now.retail_paise),
      mrp: rupees(now.mrp_paise),
      wholesalePrice: rupees(now.wholesale_paise),
      scope: now.is_override ? "location" : "all locations",
    },
  };
});
