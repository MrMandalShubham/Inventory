import { apiRoute } from "@/lib/api/handler";
import { putImage, MAX_BYTES } from "@/lib/storage";
import { imagesFor, imageBase } from "@/lib/api/images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/products/{id}/images */
export const GET = apiRoute({ scope: "catalog:read" }, async ({ db, req, params }) => {
  const base = imageBase(req);
  const { rows } = await db.query(
    `select id from catalog.product
      where sku_code = $1 or ($1 ~ '^[0-9a-f-]{36}$' and id = $1::uuid)`, [params.id]);
  if (!rows[0]) {
    return { status: 404, body: { error: { code: "not_found", message: `No product ${params.id}` } } };
  }
  return { body: { images: (await imagesFor(db, [rows[0].id], base))[rows[0].id] ?? [] } };
});

/**
 * POST /api/v1/products/{id}/images
 *
 *   { "data": "<base64>", "alt": "…", "primary": true,
 *     "thumb": "<base64, optional>" }
 *
 * Base64 in JSON rather than multipart, because every other write on
 * this API is JSON and one consistent shape is worth the 33% overhead
 * on a file this size. The limit is applied to the DECODED bytes.
 *
 * ── The type is read from the bytes ──
 *
 * Whatever `content-type` a caller claims is ignored. The magic bytes
 * decide, and a file that does not begin like an image we accept is
 * refused — otherwise this endpoint stores arbitrary content and the
 * public image route serves it back with a type an attacker chose.
 *
 * ── The thumbnail is optional and never invented ──
 *
 * There is no image library in this stack, so the server cannot
 * resize. Our own dashboard downscales in the browser before uploading
 * — which also saves the shop's bandwidth, the constrained side of the
 * connection — and sends both renditions. An integrator that sends
 * only the original gets a row with no thumbnail, and every reader
 * falls back to the full image rather than to a broken one.
 */
export const POST = apiRoute(
  { scope: "catalog:write", idempotent: true },
  async ({ db, body, req, params }) => {
    const base = imageBase(req);

    const { rows } = await db.query(
      `select id, name from catalog.product
        where sku_code = $1 or ($1 ~ '^[0-9a-f-]{36}$' and id = $1::uuid)`, [params.id]);
    const product = rows[0];
    if (!product) {
      return { status: 404, body: { error: { code: "not_found", message: `No product ${params.id}` } } };
    }

    if (!body?.data || typeof body.data !== "string") {
      return {
        status: 400,
        body: {
          error: {
            code: "image_required",
            message: 'Send the image as base64 in "data".',
          },
        },
      };
    }

    // Reject on the encoded length before allocating the buffer: a
    // caller can otherwise make the server hold an arbitrary amount of
    // memory before the size check runs.
    if (body.data.length > MAX_BYTES * 1.4) {
      return {
        status: 413,
        body: {
          error: {
            code: "image_too_large",
            message: `Images must be under ${MAX_BYTES / 1048576}MB.`,
          },
        },
      };
    }

    const data = Buffer.from(body.data, "base64");
    const stored = await putImage(data);

    let thumbKey: string | null = null;
    if (typeof body.thumb === "string" && body.thumb.length > 0) {
      thumbKey = (await putImage(Buffer.from(body.thumb, "base64"), undefined, "products")).key;
    }

    const { rows: created } = await db.query(
      `select catalog.attach_product_image($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as id`,
      [product.id, stored.key, thumbKey, stored.mime, stored.bytes,
       stored.width, stored.height, stored.checksum,
       body.alt ?? null, body.primary ?? null]);

    const images = (await imagesFor(db, [product.id], base))[product.id] ?? [];

    return {
      status: 201,
      body: {
        image_id: created[0].id,
        // Worth telling the caller: a client that uploads the same
        // photo on every sync should know it is not costing storage.
        deduplicated: stored.deduplicated,
        images,
      },
    };
  });
