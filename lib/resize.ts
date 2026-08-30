/**
 * Downscaling a photograph, in the browser, before it is uploaded.
 *
 * Shared by the "add a product" form and the gallery on an existing
 * product, because a photo taken during creation and a photo added
 * later must come out identical — two copies of this would drift and
 * the catalogue would end up with two sizes of picture.
 *
 * ── Why the browser and not the server ──
 *
 * There is no image library in this stack. But the better reason is
 * that the photo comes off a phone, in a shop, over the shop's
 * connection — the constrained side. Uploading four megabytes so a
 * server can turn them into three hundred kilobytes spends the scarce
 * resource to save the plentiful one.
 */

export const MAX_EDGE = 1600;
export const THUMB_EDGE = 400;

async function encode(file: File | Blob, maxEdge: number, quality: number): Promise<string> {
  const bitmap = await createImageBitmap(file);

  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot resize images.");

  // A transparent PNG re-encoded as JPEG goes black without this.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Could not encode the image."))),
      "image/jpeg",
      quality));

  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // In chunks: String.fromCharCode(...bytes) on a 300KB array exceeds
  // the argument limit and throws.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

export type Renditions = {
  data: string;
  thumb: string;
  /** Original size, so the UI can say what it saved. */
  originalBytes: number;
  uploadedBytes: number;
};

export async function renditions(file: File): Promise<Renditions> {
  if (!file.type.startsWith("image/")) {
    throw new Error("That is not an image file.");
  }

  const [data, thumb] = await Promise.all([
    encode(file, MAX_EDGE, 0.82),
    encode(file, THUMB_EDGE, 0.75),
  ]);

  return {
    data,
    thumb,
    originalBytes: file.size,
    uploadedBytes: Math.round((data.length * 3) / 4),
  };
}

export function describeSaving(r: Renditions) {
  return `${(r.originalBytes / 1048576).toFixed(1)}MB became ${(r.uploadedBytes / 1024).toFixed(0)}KB.`;
}
