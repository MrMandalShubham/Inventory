import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/db";
import { currentSession, CAN_PLAN } from "@/lib/session";
import { putImage, MAX_BYTES } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Image upload for the dashboard.
 *
 * Separate from /api/v1 because the two authenticate differently: the
 * public API takes a bearer key, this takes the session cookie a
 * signed-in person already has. Sharing one route would mean one of
 * them carrying a credential it has no reason to hold.
 *
 * The rules are the same either way — the type is read from the bytes,
 * the size is checked on the decoded buffer, and the role is checked
 * by the database function, not here.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ sku: string }> },
) {
  const { sku } = await ctx.params;

  const me = await currentSession();
  if (!me) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Sign in first." } }, { status: 401 });
  }

  // A friendly refusal before doing any work. The real enforcement is
  // catalog.attach_product_image(), which checks the role itself —
  // this is only so the message is useful.
  if (!CAN_PLAN.includes(me.role)) {
    return NextResponse.json({
      error: {
        code: "forbidden",
        message: "Only a planner or an admin may change the catalogue.",
      },
    }, { status: 403 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_json", message: "Body is not JSON." } }, { status: 400 });
  }

  if (typeof body?.data !== "string" || body.data.length === 0) {
    return NextResponse.json(
      { error: { code: "image_required", message: "No image was sent." } }, { status: 400 });
  }

  // Check the encoded length first: decoding an arbitrarily large
  // string allocates before any size check could run.
  if (body.data.length > MAX_BYTES * 1.4) {
    return NextResponse.json({
      error: {
        code: "image_too_large",
        message: `Images must be under ${MAX_BYTES / 1048576}MB.`,
      },
    }, { status: 413 });
  }

  try {
    const result = await withSession(me, async (c) => {
      const { rows } = await c.query(
        `select id from catalog.product
          where sku_code = $1 or ($1 ~ '^[0-9a-f-]{36}$' and id = $1::uuid)`, [sku]);
      if (!rows[0]) return { status: 404, body: { error: { code: "not_found", message: `No product ${sku}` } } };

      // Bytes first, row second. An orphaned object is collectable; a
      // row pointing at bytes that were never written is a broken
      // image in a customer's app.
      const stored = await putImage(Buffer.from(body.data, "base64"));

      let thumbKey: string | null = null;
      if (typeof body.thumb === "string" && body.thumb.length > 0) {
        thumbKey = (await putImage(Buffer.from(body.thumb, "base64"))).key;
      }

      const { rows: created } = await c.query(
        "select catalog.attach_product_image($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as id",
        [rows[0].id, stored.key, thumbKey, stored.mime, stored.bytes,
         stored.width, stored.height, stored.checksum,
         body.alt ?? null, body.primary ?? null]);

      return {
        status: 201,
        body: { image_id: created[0].id, deduplicated: stored.deduplicated },
      };
    });

    return NextResponse.json(result.body, { status: result.status });
  } catch (e: any) {
    const raw = e?.message ?? String(e);
    const named = /^([A-Z_]{3,}):\s*(.*)$/s.exec(raw);
    const forbidden = raw.includes("FORBIDDEN_ROLE");
    const duplicate = e?.code === "23505";

    return NextResponse.json({
      error: {
        code: duplicate ? "already_attached"
          : named ? named[1].toLowerCase()
          : "internal_error",
        message: duplicate
          ? "That exact photo is already on this product."
          : named ? named[2] : raw,
      },
    }, { status: forbidden ? 403 : duplicate ? 409 : named ? 400 : 500 });
  }
}
