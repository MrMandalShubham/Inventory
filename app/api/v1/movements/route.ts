import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/movements — tickets visible to this key's locations. */
export const GET = apiRoute({ scope: "movements:read" }, async ({ db, req }) => {
  const url = new URL(req.url);
  const status = url.searchParams.get("status");

  const { rows } = await db.query(
    `select m.id, m.ticket_no, m.type, m.status,
            m.source_location_id, m.dest_location_id, m.partner_id,
            m.raised_at, m.dispatched_at, m.received_at, m.closed_at
       from movement.movement m
      where ($1::text is null or m.status = $1)
      order by m.raised_at desc limit 200`, [status]);

  return { body: { movements: rows } };
});
