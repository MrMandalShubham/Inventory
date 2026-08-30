import { storefrontRoute, preflight, resolveLocation } from "@/lib/api/storefront";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/**
 * GET /api/categories?location=SH1
 *
 * With a location, only categories that actually have something in
 * stock there — a storefront that offers an empty category sends the
 * customer to a blank page.
 */
export const GET = storefrontRoute("catalog:read", async (ctx, req) => {
  const loc = await resolveLocation(ctx, req);

  const { rows } = await ctx.db.query(`
    select c.id, c.name, c.icon,
           count(distinct p.id)::int as product_count
      from catalog.category c
      join catalog.product p on p.category_id = c.id and p.status = 'ACTIVE'
      left join stock.balance b
             on b.product_id = p.id
            and ($1::uuid is null or b.location_id = $1)
     where c.status = 'ACTIVE'
       and ($1::uuid is null
         or coalesce(b.on_hand - b.reserved - b.allocated - b.damaged, 0) > 0)
     group by c.id, c.name, c.icon, c.position
     order by c.position, c.name`, [loc?.id ?? null]);

  return {
    body: rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      icon: r.icon,
      product_count: r.product_count,
    })),
  };
});
