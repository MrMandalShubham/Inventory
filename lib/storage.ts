import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, unlink, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";

/**
 * Where image bytes live.
 *
 * The database stores a KEY; this stores the bytes behind it
 * (migration 0041). Two drivers, chosen by environment:
 *
 *   local     a directory on disk. Development only.
 *   supabase  Supabase Storage over its REST API. Production.
 *
 * There is no third option for production on Vercel. A serverless
 * filesystem is ephemeral and read-only at runtime, so a file written
 * during a request is gone by the next one — and on a different
 * instance it was never there at all. That failure is invisible in
 * development and total in production, which is why the driver is
 * explicit rather than "write to ./uploads and hope".
 *
 * ── Content-addressed ──
 *
 * The key is the SHA-256 of the bytes plus an extension. A key can
 * never come to mean different bytes, so:
 *
 *   • uploading the same photo twice stores it once,
 *   • the URL is immutable and cacheable forever,
 *   • and the key is unguessable, which is what makes it safe to
 *     serve product photos without a session.
 */

export type StoredObject = {
  key: string;
  bytes: number;
  mime: string;
  /** True when the object was already there — the upload deduplicated. */
  deduplicated: boolean;
};

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};

export const ALLOWED_MIME = Object.keys(EXT);

/** 8 MB. A product photo that big is a mistake, not a requirement. */
export const MAX_BYTES = 8 * 1024 * 1024;

export function keyFor(data: Buffer, mime: string, prefix = "products") {
  const ext = EXT[mime];
  if (!ext) throw new Error(`UNSUPPORTED_IMAGE_TYPE: ${mime}`);
  const hash = createHash("sha256").update(data).digest("hex");
  // Two levels of fan-out. A single directory with fifty thousand
  // files is slow to list on every filesystem worth naming, and the
  // local driver is used by the garbage collector.
  return `${prefix}/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.${ext}`;
}

export function checksumOf(data: Buffer) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Read the real dimensions and type out of the bytes.
 *
 * The Content-Type a client sends is a claim, not a fact. Trusting it
 * means a caller can label anything at all as image/png and have it
 * served back with that type — which is how a stored file becomes a
 * stored script. So the magic bytes decide, and a file whose header
 * does not match a format we accept is refused.
 */
export function inspect(data: Buffer): { mime: string; width: number | null; height: number | null } | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A, then IHDR with width/height.
  if (data.length > 24 &&
      data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return {
      mime: "image/png",
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
    };
  }

  // JPEG: FF D8, then walk the segments to the frame header.
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) { i += 1; continue; }
      const marker = data[i + 1];
      // SOF0..SOF15, excluding the four that are not frame headers.
      if (marker >= 0xc0 && marker <= 0xcf &&
          marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          mime: "image/jpeg",
          height: data.readUInt16BE(i + 5),
          width: data.readUInt16BE(i + 7),
        };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
      } else {
        i += 2 + data.readUInt16BE(i + 2);
      }
    }
    return { mime: "image/jpeg", width: null, height: null };
  }

  // RIFF....WEBP
  if (data.length > 30 &&
      data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") {
    const fmt = data.toString("ascii", 12, 16);
    if (fmt === "VP8X") {
      return {
        mime: "image/webp",
        width: 1 + (data[24] | (data[25] << 8) | (data[26] << 16)),
        height: 1 + (data[27] | (data[28] << 8) | (data[29] << 16)),
      };
    }
    if (fmt === "VP8 " && data.length > 30) {
      return {
        mime: "image/webp",
        width: data.readUInt16LE(26) & 0x3fff,
        height: data.readUInt16LE(28) & 0x3fff,
      };
    }
    if (fmt === "VP8L" && data.length > 25) {
      const b = data.readUInt32LE(21);
      return {
        mime: "image/webp",
        width: (b & 0x3fff) + 1,
        height: ((b >> 14) & 0x3fff) + 1,
      };
    }
    return { mime: "image/webp", width: null, height: null };
  }

  // ISO-BMFF with an AVIF brand.
  if (data.length > 12 && data.toString("ascii", 4, 8) === "ftyp" &&
      data.toString("ascii", 8, 12).startsWith("avi")) {
    return { mime: "image/avif", width: null, height: null };
  }

  return null;
}

// ─────────────────────── the drivers ───────────────────────

interface Driver {
  name: string;
  put(key: string, data: Buffer, mime: string): Promise<boolean>;
  get(key: string): Promise<{ data: Buffer; mime: string } | null>;
  remove(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  /**
   * Where a browser should fetch this object.
   *
   * Null means "no direct URL — go through /images". The local driver
   * has no public endpoint, so it returns null and the Next route
   * serves the bytes.
   *
   * Supabase Storage does have one, and using it matters: proxying
   * every product photograph through the application means paying for
   * the bandwidth twice, occupying a serverless function for the
   * duration of each image, and losing the CDN in front of the bucket.
   */
  publicUrl(key: string): string | null;
}

const ROOT = process.env.STORAGE_DIR ?? join(process.cwd(), ".storage");

const localDriver: Driver = {
  name: "local",

  // Nothing outside this process can read ./.storage, so every image
  // is served by the /images route in development.
  publicUrl() { return null; },

  async put(key, data) {
    const path = join(ROOT, key);
    try {
      // Content-addressed: if it is there, it is byte-identical.
      await readFile(path);
      return false;
    } catch { /* not there yet */ }

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    return true;
  },

  async get(key) {
    try {
      const data = await readFile(join(ROOT, key));
      const found = inspect(data);
      return { data, mime: found?.mime ?? "application/octet-stream" };
    } catch {
      return null;
    }
  },

  async remove(key) {
    await unlink(join(ROOT, key)).catch(() => {});
  },

  async list(prefix) {
    const out: string[] = [];
    async function walk(dir: string, rel: string) {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); }
      catch { return; }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(join(dir, e.name), r);
        else out.push(r);
      }
    }
    await walk(join(ROOT, prefix), prefix);
    return out;
  },
};

function supabaseDriver(): Driver {
  const url = process.env.SUPABASE_URL;
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? "product-images";

  if (!url || !secret) {
    throw new Error(
      "STORAGE_MISCONFIGURED: STORAGE_DRIVER=supabase needs SUPABASE_URL and " +
      "SUPABASE_SERVICE_ROLE_KEY. Refusing to fall back to local disk — on a " +
      "serverless host that silently loses every image.");
  }

  const root = url.replace(/\/$/, "");
  const base = `${root}/storage/v1/object`;
  const headers = { Authorization: `Bearer ${secret}` };

  // A private bucket has no usable public URL, so images fall back to
  // being proxied. Public is the default because product photographs
  // are the pictures a shop wants on a storefront — see app/images.
  const isPublic = (process.env.SUPABASE_STORAGE_PUBLIC ?? "true") !== "false";

  return {
    name: "supabase",

    publicUrl(key) {
      return isPublic ? `${base}/public/${bucket}/${key}` : null;
    },

    async put(key, data, mime) {
      const res = await fetch(`${base}/${bucket}/${key}`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": mime,
          "x-upsert": "false",
          // Supabase defaults public objects to no-cache, so every view
          // revalidates against the origin and the CDN in front of the
          // bucket does almost nothing. A content-addressed key can
          // never mean different bytes, so a year is not a risk — it is
          // the entire point of hashing the contents.
          "cache-control": "max-age=31536000, immutable",
        },
        body: new Uint8Array(data),
      });

      if (res.ok) return true;

      // ── "already there" is a SUCCESS, and Supabase hides it ──
      //
      // Uploading an existing key returns HTTP 400 with the real
      // outcome inside the body:
      //
      //   {"statusCode":"409","error":"Duplicate",
      //    "message":"The resource already exists",
      //    "code":"KeyAlreadyExists"}
      //
      // Checking res.status alone therefore treats every deduplicated
      // upload as a failure — which is every repeat upload, since keys
      // are content-addressed. The body has to be read.
      const text = await res.text();
      let body: any = null;
      try { body = JSON.parse(text); } catch { /* not JSON */ }

      const duplicate =
        res.status === 409 ||
        body?.statusCode === "409" ||
        body?.code === "KeyAlreadyExists" ||
        body?.error === "Duplicate";

      // The key IS the hash of the contents, so an existing object is
      // byte-identical. Nothing to write, nothing lost.
      if (duplicate) return false;

      throw new Error(`STORAGE_WRITE_FAILED: ${res.status} ${text}`);
    },

    /**
     * Read an object, authoritatively.
     *
     * Supabase serves even the authenticated object endpoint through a
     * CDN, and it caches hard: after a successful DELETE, a plain GET
     * kept returning 200 with `cf-cache-status: HIT` and the bytes of
     * the object that had just been removed.
     *
     * Every server-side use of get() needs the truth rather than a
     * fast answer — verifying a staged upload before writing a row,
     * and deciding what the garbage collector may delete. A stale hit
     * there means attaching an image that no longer exists, or
     * believing an object survived a deletion that it did not.
     *
     * Customer traffic never comes through here: a public bucket hands
     * out its own CDN URL (see publicUrl), which is where caching
     * belongs and where the keys are immutable anyway.
     */
    async get(key) {
      const res = await fetch(`${base}/${bucket}/${key}?_=${Date.now()}`, {
        headers: { ...headers, "cache-control": "no-cache" },
        cache: "no-store",
      });
      if (!res.ok) return null;
      const data = Buffer.from(await res.arrayBuffer());
      return { data, mime: res.headers.get("content-type") ?? "application/octet-stream" };
    },

    async remove(key) {
      const res = await fetch(`${base}/${bucket}/${key}`, { method: "DELETE", headers });
      // Silence here means the garbage collector reports space it never
      // reclaimed, and the bill keeps growing while the log says it is
      // being cleaned up.
      if (!res.ok && res.status !== 404) {
        throw new Error(`STORAGE_DELETE_FAILED: ${res.status} ${await res.text()}`);
      }
    },

    /**
     * Every object under a prefix.
     *
     * Supabase's list endpoint is NOT recursive: it returns the
     * immediate children of one folder, and a folder comes back as a
     * row with a null id. Keys here are three levels deep
     * (products/ab/cd/<hash>.png), so a single call returns the
     * directory "ab" and no files at all — which made the garbage
     * collector believe the bucket was empty and every object
     * collectable.
     */
    async list(prefix) {
      const out: string[] = [];

      const walk = async (folder: string) => {
        let offset = 0;
        for (;;) {
          const res = await fetch(`${root}/storage/v1/object/list/${bucket}`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({
              prefix: folder ? `${folder}/` : "",
              limit: 1000,
              offset,
              sortBy: { column: "name", order: "asc" },
            }),
          });
          if (!res.ok) return;

          const rows = (await res.json()) as { name: string; id: string | null }[];
          if (rows.length === 0) return;

          for (const r of rows) {
            const full = folder ? `${folder}/${r.name}` : r.name;
            // A null id is a folder, not an object.
            if (r.id === null) await walk(full);
            else out.push(full);
          }

          if (rows.length < 1000) return;
          offset += rows.length;
        }
      };

      await walk(prefix.replace(/\/$/, ""));
      return out;
    },
  };
}

/**
 * Which driver an environment implies, and whether it is allowed.
 *
 * Pure, and exported, so the rule can be tested rather than a
 * re-statement of it. A test that reimplements the condition it is
 * checking passes when the real code is deleted.
 */
export function chooseDriver(env: NodeJS.ProcessEnv = process.env): {
  name: "local" | "supabase";
  refuse?: string;
} {
  const name = (env.STORAGE_DRIVER ?? (env.SUPABASE_URL ? "supabase" : "local")) as
    "local" | "supabase";

  if (name === "local" && env.VERCEL) {
    return {
      name,
      refuse:
        "STORAGE_MISCONFIGURED: the local driver cannot be used on Vercel — the " +
        "filesystem is ephemeral, so every uploaded image would disappear. Set " +
        "STORAGE_DRIVER=supabase.",
    };
  }

  if (name === "supabase" && !(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY)) {
    return {
      name,
      refuse:
        "STORAGE_MISCONFIGURED: STORAGE_DRIVER=supabase needs SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY. Refusing to fall back to local disk — on a " +
        "serverless host that silently loses every image.",
    };
  }

  return { name };
}

let cached: Driver | null = null;

export function storage(): Driver {
  if (cached) return cached;

  const { name: chosen, refuse } = chooseDriver();

  // Loud, and at startup rather than on the first upload that
  // vanishes.
  if (refuse) throw new Error(refuse);

  cached = chosen === "supabase" ? supabaseDriver() : localDriver;
  return cached;
}

/**
 * Validate and store one image.
 *
 * Refuses on the bytes, not on what the caller said about them.
 */
export async function putImage(
  data: Buffer, claimedMime?: string, prefix = "products",
): Promise<StoredObject & { width: number | null; height: number | null; checksum: string }> {
  if (data.length === 0) throw new Error("EMPTY_IMAGE: nothing was uploaded");
  if (data.length > MAX_BYTES) {
    throw new Error(
      `IMAGE_TOO_LARGE: ${(data.length / 1048576).toFixed(1)}MB exceeds the ` +
      `${MAX_BYTES / 1048576}MB limit`);
  }

  const found = inspect(data);
  if (!found) {
    throw new Error(
      "NOT_AN_IMAGE: the file does not begin like a JPEG, PNG, WebP or AVIF. " +
      "The declared content type is not evidence.");
  }
  if (claimedMime && claimedMime !== found.mime) {
    // Worth saying out loud rather than quietly correcting: a caller
    // whose type is wrong usually has a bug worth knowing about.
    throw new Error(
      `IMAGE_TYPE_MISMATCH: sent as ${claimedMime} but the bytes are ${found.mime}`);
  }

  const key = keyFor(data, found.mime, prefix);
  const written = await storage().put(key, data, found.mime);

  return {
    key,
    bytes: data.length,
    mime: found.mime,
    deduplicated: !written,
    width: found.width,
    height: found.height,
    checksum: checksumOf(data),
  };
}
