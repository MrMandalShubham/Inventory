import type { PoolClient } from "pg";
import { storage, inspect, checksumOf } from "./storage";

/**
 * Attach a staged image to a product that has just been created.
 *
 * Lives here rather than inside the server action so it can be tested
 * directly. The interesting part is not the insert — it is that
 * nothing the browser sent is believed.
 *
 * ── Why the facts are re-read ──
 *
 * The "add a product" form carries the storage KEY in a hidden field,
 * because the bytes were uploaded before the product existed. A hidden
 * field is a value the browser sent and nothing more: type, size and
 * dimensions coming from the same place would let a caller record a
 * 20MB PNG as a 2KB JPEG, and every consumer of the API — including a
 * customer app sizing a layout — would believe it.
 *
 * So the key is used to fetch the stored object, and every other fact
 * is read off those bytes here.
 */
export async function attachStagedImage(
  db: PoolClient,
  skuCode: string,
  staged: { key: string; thumbKey?: string | null; alt?: string | null },
): Promise<string | null> {
  const { rows } = await db.query(
    "select id from catalog.product where sku_code = $1", [skuCode]);
  if (!rows[0]) throw new Error("NO_SUCH_PRODUCT: the product was not found after creation");

  const stored = await storage().get(staged.key);
  if (!stored) {
    throw new Error("IMAGE_NOT_STAGED: the uploaded photograph could not be read back");
  }

  const found = inspect(stored.data);
  if (!found) {
    throw new Error("NOT_AN_IMAGE: the stored file is not a JPEG, PNG, WebP or AVIF");
  }

  // A thumbnail key that points at nothing would render as a broken
  // picture in every listing. Better to have none: readers fall back
  // to the full image.
  let thumbKey: string | null = staged.thumbKey?.trim() || null;
  if (thumbKey && !(await storage().get(thumbKey))) thumbKey = null;

  const { rows: created } = await db.query(
    "select catalog.attach_product_image($1,$2,$3,$4,$5,$6,$7,$8,$9,true) as id",
    [rows[0].id, staged.key, thumbKey, found.mime, stored.data.length,
     found.width, found.height, checksumOf(stored.data),
     staged.alt?.trim() || null]);

  return created[0]?.id ?? null;
}
