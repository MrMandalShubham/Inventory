"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withSession } from "@/lib/db";
import { currentClaims } from "@/lib/session";

async function run(sku: string, fn: (c: any) => Promise<void>, ok: string) {
  const claims = await currentClaims();
  try {
    await withSession(claims, fn);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    redirect(`/products/${sku}?error=${encodeURIComponent(msg)}`);
  }
  revalidatePath(`/products/${sku}`);
  redirect(`/products/${sku}?ok=${encodeURIComponent(ok)}`);
}

export async function makePrimary(formData: FormData) {
  const sku = String(formData.get("sku"));
  const id = String(formData.get("id"));
  await run(sku,
    async (c) => { await c.query("select catalog.set_primary_image($1)", [id]); },
    "primary photo changed — this is the one the customer app shows");
}

export async function deleteImage(formData: FormData) {
  const sku = String(formData.get("sku"));
  const id = String(formData.get("id"));

  await run(sku, async (c) => {
    // The function returns the storage key, but the bytes are left
    // alone deliberately: the same content-addressed object may be on
    // another product, and deleting it would blank that one too.
    // scripts/storage-gc.mjs collects what nothing references.
    await c.query("select catalog.remove_product_image($1)", [id]);
  }, "photo removed");
}

export async function moveImage(formData: FormData) {
  const sku = String(formData.get("sku"));
  const productId = String(formData.get("product_id"));
  const id = String(formData.get("id"));
  const dir = String(formData.get("dir")) === "up" ? -1 : 1;

  await run(sku, async (c) => {
    const { rows } = await c.query(
      `select id from catalog.product_image where product_id = $1
        order by position, created_at`, [productId]);

    const order = rows.map((r: any) => r.id as string);
    const i = order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;

    [order[i], order[j]] = [order[j], order[i]];
    await c.query("select catalog.reorder_product_images($1,$2::uuid[])", [productId, order]);
  }, "order changed");
}
