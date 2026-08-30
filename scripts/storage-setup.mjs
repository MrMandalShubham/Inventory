// Create the Supabase Storage bucket this system writes to.
//
//   npm run storage:setup
//
// Idempotent: an existing bucket is left alone and reported.
//
// ── Why the bucket is public ──
//
// Product photographs are the pictures a shop wants on a storefront.
// A customer app renders <img src="…">, and a browser will not attach
// a bearer token to that — so a private bucket means either proxying
// every image through the application or minting signed URLs that
// change constantly and therefore cache nowhere.
//
// Keys are the SHA-256 of the contents, so a public object is still
// unguessable and unenumerable. Set SUPABASE_STORAGE_PUBLIC=false to
// make it private; images then fall back to being served through
// /images, which works but costs bandwidth twice.

import "./env.mjs";
const url = process.env.SUPABASE_URL;
const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? "product-images";
const isPublic = (process.env.SUPABASE_STORAGE_PUBLIC ?? "true") !== "false";

if (!url || !secret) {
  console.error(
    "\nSUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.\n\n" +
    "  Project settings → API. The SERVICE ROLE key, not the anon key:\n" +
    "  writing to storage needs to bypass row-level security.\n\n" +
    "  Keep it server-side only. It is a master key for the project —\n" +
    "  never put it in NEXT_PUBLIC_* or anywhere the browser can read.\n");
  process.exit(1);
}

const root = url.replace(/\/$/, "");
const headers = {
  Authorization: `Bearer ${secret}`,
  "content-type": "application/json",
};

const existing = await fetch(`${root}/storage/v1/bucket/${bucket}`, { headers });

if (existing.ok) {
  const b = await existing.json();
  console.log(`\nBucket "${bucket}" already exists (public: ${b.public}).`);

  if (b.public !== isPublic) {
    const upd = await fetch(`${root}/storage/v1/bucket/${bucket}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ public: isPublic }),
    });
    console.log(upd.ok
      ? `Updated it to public: ${isPublic}.`
      : `Could not change its visibility: ${upd.status} ${await upd.text()}`);
  }
} else {
  const res = await fetch(`${root}/storage/v1/bucket`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      id: bucket,
      name: bucket,
      public: isPublic,
      // The same ceiling lib/storage.ts enforces, so a file that would
      // be refused by the application is also refused by the bucket.
      file_size_limit: 8 * 1024 * 1024,
      allowed_mime_types: ["image/jpeg", "image/png", "image/webp", "image/avif"],
    }),
  });

  if (!res.ok) {
    console.error(`\nCould not create the bucket: ${res.status} ${await res.text()}\n`);
    process.exit(1);
  }
  console.log(`\nCreated bucket "${bucket}" (public: ${isPublic}).`);
}

console.log("\nNow prove it works:\n\n  npm run storage:check\n");
