"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withSession } from "@/lib/db";
import { currentClaims } from "@/lib/session";
import { attachStagedImage } from "@/lib/attach-image";

export async function createProduct(formData: FormData) {
  const claims = await currentClaims();

  const name = String(formData.get("name") ?? "").trim();
  const uom = String(formData.get("base_uom") ?? "PCS");
  const tracking = String(formData.get("tracking_mode") ?? "NONE");
  const category = String(formData.get("category") ?? "").trim() || null;
  const hsn = String(formData.get("hsn_code") ?? "").trim() || null;
  const shelfRaw = String(formData.get("shelf_life_days") ?? "").trim();
  const barcode = String(formData.get("barcode") ?? "").trim() || null;
  const weighed = formData.get("is_weighed") === "on";

  const row = {
    name,
    base_uom: uom,
    category,
    hsn_code: hsn,
    tracking_mode: tracking,
    is_weighed: weighed,
    shelf_life_days: shelfRaw ? Number(shelfRaw) : null,
    barcode,
  };

  // Reuse the same import function the CSV screen calls. One code
  // path for "create a product" means the form and the spreadsheet
  // can never disagree about what is valid.
  const report = await withSession(claims, async (c) => {
    const { rows } = await c.query(
      "select * from catalog.import_products($1::jsonb)",
      [JSON.stringify([row])],
    );
    return rows[0];
  });

  if (report?.status === "FAILED") {
    redirect(`/products/new?error=${encodeURIComponent(report.message)}`);
  }

  // ── the photograph, if one was staged ──
  //
  // The form carries only the KEY: the bytes were uploaded before the
  // product existed. attachStagedImage re-reads every other fact off
  // the stored object rather than trusting the hidden fields — see
  // lib/attach-image.ts for why that matters.
  const imageKey = String(formData.get("image_key") ?? "").trim();

  if (imageKey && report?.sku_code) {
    try {
      await withSession(claims, (c) =>
        attachStagedImage(c, report.sku_code, {
          key: imageKey,
          thumbKey: String(formData.get("image_thumb_key") ?? ""),
          alt: String(formData.get("image_alt") ?? ""),
        }));
    } catch (e) {
      // The PRODUCT was created. Saying "failed" here would be a lie
      // that sends somebody back to a form which would then create a
      // duplicate. Report the part that failed, on the product itself.
      const raw = e instanceof Error ? e.message : String(e);
      const msg = /^[A-Z_]{3,}:\s*(.*)$/s.exec(raw)?.[1] ?? raw;
      redirect(`/products/${report.sku_code}?error=${encodeURIComponent(
        `The product was created, but its photograph was not attached: ${msg}`)}`);
    }

    revalidatePath("/products");
    redirect(`/products/${report.sku_code}?ok=${encodeURIComponent(
      "product created with its photograph")}`);
  }

  revalidatePath("/products");
  redirect(report?.sku_code ? `/products/${report.sku_code}` : "/products");
}
