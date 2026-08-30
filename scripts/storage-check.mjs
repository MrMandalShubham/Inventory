// Prove the configured object store actually works.
//
// ── Why this exists ──
//
// The Supabase driver in lib/storage.ts cannot be covered by the test
// suite: the suite runs against a plain postgres container with no
// Supabase project behind it, so every assertion about Supabase
// Storage would either be skipped or mocked. A mocked object store
// proves the mock works.
//
// So it is a command instead. Point the environment at a real project
// and run this: it creates the bucket if needed, then round-trips a
// real image through put, get, list, public URL and remove, checking
// the bytes come back identical.
//
//   npm run storage:check
//
// Until this passes against a real project, nobody should believe the
// Supabase path works — including me. It is written, not proven.

import "./env.mjs";
import { deflateSync } from "node:zlib";
import { storage, putImage, inspect } from "../lib/storage.ts";

let failures = 0;
const ok = (name, cond, detail = "") => {
  if (cond) console.log(`  ✔ ${name}`);
  else { failures += 1; console.log(`  ✖ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

// ── a real, unique PNG, so this run cannot pass on a leftover object ──

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, seed) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) {
      raw[o++] = (x * 7 + seed) & 0xff;
      raw[o++] = (y * 11 + seed) & 0xff;
      raw[o++] = (seed * 3) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const driver = storage();

console.log(`\nStorage check — driver: ${driver.name}`);
if (driver.name === "local") {
  console.log("  (set STORAGE_DRIVER=supabase with SUPABASE_URL and");
  console.log("   SUPABASE_SERVICE_ROLE_KEY to check the production path)");
}
console.log("");

// Unique per run: a stale object from a previous run must not be able
// to make a broken driver look like it works.
const image = png(24, Date.now() % 251);

// ── write ──
const first = await putImage(image, undefined, "products/_check");
ok("an image can be written", !!first.key, first.key);
ok("it was newly written, not already there", first.deduplicated === false);
ok("the type was read from the bytes", first.mime === "image/png", first.mime);
ok("so were the dimensions", first.width === 24 && first.height === 24,
  `${first.width}×${first.height}`);

// ── deduplicate ──
const again = await putImage(image, undefined, "products/_check");
ok("writing the same bytes again deduplicates",
  again.deduplicated === true && again.key === first.key);

// ── read back ──
const got = await driver.get(first.key);
ok("it can be read back", !!got);
ok("the bytes are byte-for-byte identical", !!got && got.data.equals(image),
  got ? `${got.data.length} bytes back, ${image.length} sent` : "nothing came back");
ok("and are still a valid image", !!got && inspect(got.data)?.mime === "image/png");

// ── list ──
const listed = await driver.list("products/_check");
ok("it appears in a listing", listed.includes(first.key),
  `${listed.length} object(s) under products/_check`);

// ── public URL ──
const url = driver.publicUrl(first.key);
if (url) {
  const res = await fetch(url);
  const body = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  ok("the public URL serves it with no credentials", res.ok, `${res.status} ${url}`);
  ok("over the public URL the bytes match", !!body && body.equals(image));
  ok("with an image content type",
    (res.headers.get("content-type") ?? "").startsWith("image/"),
    res.headers.get("content-type") ?? "none");
  // Content-addressed keys are immutable, so a revalidating cache is
  // wasted work on every single view.
  ok("and a long cache lifetime",
    /max-age=\d{5,}/.test(res.headers.get("cache-control") ?? ""),
    res.headers.get("cache-control") ?? "none");
  console.log(`      ${url}`);
} else {
  console.log("  · no public URL for this driver — images are served through /images");
}

// ── remove ──
await driver.remove(first.key);
const gone = await driver.get(first.key);
ok("it can be deleted", gone === null);

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}\n`);
process.exit(failures === 0 ? 0 : 1);
