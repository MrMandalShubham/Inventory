import { NextRequest, NextResponse } from "next/server";
import { currentSession, CAN_PLAN } from "@/lib/session";
import { putImage, MAX_BYTES } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stage an image before its product exists.
 *
 * The "add a product" form needs to accept a photograph, but there is
 * no product to attach it to until the form is submitted. Content
 * addressing makes that a non-problem: the bytes are identified by
 * what they ARE, not by what they belong to, so they can be stored
 * first and claimed afterwards.
 *
 * The form carries the returned keys in hidden fields and the create
 * action attaches them once the product has a row.
 *
 * ── Abandoned uploads ──
 *
 * Somebody who picks a photo and then closes the tab leaves bytes
 * nothing references. That is a few hundred kilobytes, and
 * scripts/storage-gc.mjs collects it. The alternative — holding the
 * file in the browser until submit — means re-encoding on every
 * validation failure and losing it on a refresh, which is a worse
 * trade for a much rarer event.
 */
export async function POST(req: NextRequest) {
  const me = await currentSession();
  if (!me) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Sign in first." } }, { status: 401 });
  }

  // Staging writes bytes, so it needs the same role that may write the
  // catalogue. Otherwise this is an open upload endpoint for anyone
  // with a session.
  if (!CAN_PLAN.includes(me.role)) {
    return NextResponse.json({
      error: {
        code: "forbidden",
        message: "Only a planner or an admin may add product photographs.",
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

  if (body.data.length > MAX_BYTES * 1.4) {
    return NextResponse.json({
      error: {
        code: "image_too_large",
        message: `Images must be under ${MAX_BYTES / 1048576}MB.`,
      },
    }, { status: 413 });
  }

  try {
    const full = await putImage(Buffer.from(body.data, "base64"));
    const thumb = typeof body.thumb === "string" && body.thumb.length > 0
      ? await putImage(Buffer.from(body.thumb, "base64"))
      : null;

    return NextResponse.json({
      key: full.key,
      thumb_key: thumb?.key ?? null,
      mime: full.mime,
      bytes: full.bytes,
      width: full.width,
      height: full.height,
      checksum: full.checksum,
      deduplicated: full.deduplicated,
      // So the form can show what it will attach.
      preview_url: `/images/${thumb?.key ?? full.key}`,
    }, { status: 201 });
  } catch (e: any) {
    const raw = e?.message ?? String(e);
    const named = /^([A-Z_]{3,}):\s*(.*)$/s.exec(raw);
    const status =
      raw.startsWith("NOT_AN_IMAGE") || raw.startsWith("UNSUPPORTED_IMAGE_TYPE") ? 415 :
      raw.startsWith("IMAGE_TOO_LARGE") ? 413 :
      raw.startsWith("STORAGE_") ? 500 : 400;

    return NextResponse.json({
      error: {
        code: named ? named[1].toLowerCase() : "internal_error",
        message: named ? named[2] : raw,
      },
    }, { status });
  }
}
