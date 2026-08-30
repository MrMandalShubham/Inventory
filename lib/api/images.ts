import type { PoolClient } from "pg";
import { storage } from "@/lib/storage";

/**
 * Shaping images for an API response.
 *
 * One place, because the customer app must see the same shape whether
 * it lists a hundred products or fetches one — a listing that returns
 * `image` and a detail that returns `images` makes every client write
 * two code paths for the same picture.
 */

export type ApiImage = {
  url: string;
  thumb_url: string;
  alt: string | null;
  width: number | null;
  height: number | null;
  primary: boolean;
};

/**
 * Absolute, because a customer app is on another origin and cannot
 * resolve a relative path against this one.
 */
export function imageBase(req: { url: string; headers: Headers }) {
  const configured = process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");

  // Behind a proxy the request URL is the internal one, so the
  // forwarded headers are what the caller actually asked for.
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto")
    ?? (host?.startsWith("localhost") || host?.startsWith("127.") ? "http" : "https");

  return host ? `${proto}://${host}` : new URL(req.url).origin;
}

/**
 * Where a client should fetch one object.
 *
 * When the object store publishes its own URL — Supabase Storage on a
 * public bucket — use it. Every product photograph proxied through the
 * application is bandwidth paid for twice, a serverless invocation
 * held open for the length of an image transfer, and a CDN sitting
 * unused in front of the bucket.
 *
 * The local driver has no public endpoint, so development falls back
 * to the /images route and the two behave identically to a caller.
 */
export function urlFor(key: string, base: string) {
  return storage().publicUrl(key) ?? `${base}/images/${key}`;
}

export function toApiImage(row: any, base: string): ApiImage {
  return {
    url: urlFor(row.storage_key, base),
    // Falls back to the full image rather than to nothing. A missing
    // thumbnail should cost bandwidth, not show a broken picture.
    thumb_url: urlFor(row.thumb_key ?? row.storage_key, base),
    alt: row.alt_text ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    primary: !!row.is_primary,
  };
}

/** Every image for a set of products, grouped by product id. */
export async function imagesFor(
  db: PoolClient, productIds: string[], base: string,
): Promise<Record<string, ApiImage[]>> {
  if (productIds.length === 0) return {};

  const { rows } = await db.query(
    `select product_id, storage_key, thumb_key, alt_text, width, height, is_primary
       from catalog.product_image
      where product_id = any($1::uuid[])
      order by is_primary desc, position, created_at`, [productIds]);

  const out: Record<string, ApiImage[]> = {};
  for (const r of rows) {
    (out[r.product_id] ??= []).push(toApiImage(r, base));
  }
  return out;
}
