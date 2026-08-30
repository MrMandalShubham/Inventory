import { storefrontRoute, preflight } from "@/lib/api/storefront";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/**
 * GET /api/locations
 *
 * The shops this key may sell from — the location picker.
 *
 * Not in the original specification and needed first: every other
 * endpoint is location-scoped, and a storefront cannot ask for stock
 * at a shop until it knows which shops exist.
 */
export const GET = storefrontRoute("catalog:read", async (ctx) => {
  const { rows } = await ctx.db.query(`
    select l.id, l.code, l.name, l.type,
           count(b.id) filter (where b.on_hand > 0)::int as products_in_stock
      from platform.location l
      left join stock.balance b on b.location_id = l.id
     where l.status = 'ACTIVE' and l.type <> 'VIRTUAL'
     group by l.id, l.code, l.name, l.type
     order by case l.type when 'HUB' then 1 when 'WAREHOUSE' then 2 else 3 end, l.code`);

  return {
    body: rows.map((r: any) => ({
      id: r.code,
      uuid: r.id,
      name: r.name,
      type: r.type.toLowerCase(),
      products_in_stock: r.products_in_stock,
    })),
  };
});
