"use client";

import { useRef, useState } from "react";
import { renditions, describeSaving } from "@/lib/resize";

/**
 * Adding a photograph to a product that already exists.
 *
 * The resizing lives in lib/resize.ts and is shared with the "add a
 * product" form — two copies would drift, and the catalogue would end
 * up with two sizes of picture depending on which screen was used.
 */

export function ImageUpload({ sku }: { sku: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [alt, setAlt] = useState("");
  const input = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const r = await renditions(file);

      const res = await fetch(`/api/internal/products/${sku}/images`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: r.data, thumb: r.thumb, alt: alt.trim() || null }),
      });

      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error?.message ?? `Upload failed (${res.status}).`);
      }

      setNote(
        body?.deduplicated
          ? "That exact photo was already stored — it now appears here too, at no extra cost."
          : `Uploaded. ${describeSaving(r)}`);
      setAlt("");
      if (input.current) input.current.value = "";

      // The gallery is server-rendered, so the new photo appears on
      // reload rather than being patched into the DOM twice.
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card card-pad">
      <div className="mb-3">
        <label className="label" htmlFor="alt">
          What is in the picture
        </label>
        <input
          id="alt"
          value={alt}
          onChange={(e) => setAlt(e.target.value)}
          placeholder="1kg pack of toor dal, yellow label"
          className="field"
        />
        <p className="meta mt-1">
          Read aloud by a screen reader, and shown when the photo fails to load. Worth
          the ten seconds.
        </p>
      </div>

      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/avif"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
        }}
        className="block w-full text-sm file:mr-3 file:rounded-md file:border-0
                   file:bg-teal-600 file:px-3 file:py-2 file:text-sm file:font-semibold
                   file:text-white hover:file:bg-teal-700 disabled:opacity-50"
      />

      {busy && <p className="meta mt-2">Resizing and uploading…</p>}
      {note && <div className="notice notice-info mt-3">{note}</div>}
      {error && <div className="notice notice-bad mt-3"><b>Refused:</b> {error}</div>}

      <p className="meta mt-3">
        Photos are resized in this browser before they are sent — a 4MB phone picture
        leaves as about 300KB, which matters on a shop&rsquo;s connection rather than
        ours.
      </p>
    </div>
  );
}
