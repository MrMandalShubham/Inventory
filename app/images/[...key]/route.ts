import { NextRequest, NextResponse } from "next/server";
import { storage, ALLOWED_MIME } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * Serve one image.
 *
 * ── Why this route has no authentication ──
 *
 * A customer-facing app renders <img src="…">. A browser will not
 * attach a bearer token to that request, so an authenticated image
 * endpoint means the app must fetch every photo as a blob, hold it in
 * memory and hand it to the tag — which defeats the browser cache, the
 * CDN and lazy loading all at once, on the device least able to afford
 * it.
 *
 * The alternative is signed URLs with an expiry, which reintroduces
 * the same problem more slowly: the URL changes, so nothing caches.
 *
 * So this is deliberate, and it rests on two things:
 *
 *   • Product photographs are not confidential. They are the pictures
 *     a shop wants on a storefront.
 *   • The key is the SHA-256 of the bytes. It cannot be guessed or
 *     enumerated, and knowing one tells you nothing about another.
 *
 * What this route must NEVER become is a general file server. It
 * serves only keys under products/, only when the stored bytes really
 * are an image, and it sends the type it verified rather than one a
 * caller supplied.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ key: string[] }> },
) {
  const { key: parts } = await ctx.params;
  const key = parts.join("/");

  // No traversal, no other prefixes, ever.
  if (!key.startsWith("products/") || key.includes("..")) {
    return new NextResponse("Not found", { status: 404 });
  }

  const found = await storage().get(key);
  if (!found) return new NextResponse("Not found", { status: 404 });

  // Serve only what we can confirm is an image. A stored object that
  // is not one is a bug or an attack; either way it is not served.
  if (!ALLOWED_MIME.includes(found.mime)) {
    return new NextResponse("Not found", { status: 404 });
  }

  return new NextResponse(new Uint8Array(found.data), {
    headers: {
      "Content-Type": found.mime,
      "Content-Length": String(found.data.length),
      // Immutable is the whole point of a content-addressed key: this
      // URL can never mean different bytes, so nothing ever needs to
      // revalidate it.
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      // It is a picture. It is never a document, a script or a frame.
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
    },
  });
}
