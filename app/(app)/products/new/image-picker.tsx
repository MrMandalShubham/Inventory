"use client";

import { useRef, useState } from "react";
import { renditions, describeSaving } from "@/lib/resize";

/**
 * Picking a photograph while creating a product.
 *
 * The product does not exist yet, so there is nothing to attach to.
 * The bytes are uploaded immediately anyway — content addressing means
 * they are identified by what they are, not by what they belong to —
 * and the resulting keys ride along in hidden fields until the form is
 * submitted.
 *
 * Uploading now rather than on submit means the slow part happens
 * while the person is still typing the rest of the form, and a
 * validation failure elsewhere does not throw the photograph away.
 */

type Staged = {
  key: string;
  thumb_key: string | null;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  checksum: string;
  preview_url: string;
  deduplicated: boolean;
};

export function ImagePicker() {
  const [staged, setStaged] = useState<Staged | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function choose(file: File) {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const r = await renditions(file);

      const res = await fetch("/api/internal/images", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: r.data, thumb: r.thumb }),
      });

      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? `Upload failed (${res.status}).`);

      setStaged(body);
      setNote(
        body.deduplicated
          ? "That exact photograph is already stored — it costs nothing to use it again."
          : describeSaving(r));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStaged(null);
    } finally {
      setBusy(false);
    }
  }

  function clear() {
    setStaged(null);
    setNote(null);
    setError(null);
    if (input.current) input.current.value = "";
  }

  return (
    <div>
      {/* What the create action reads. Nothing here is trusted — the
          server re-reads every one of these facts off the stored bytes
          before writing the row. */}
      {staged && (
        <>
          <input type="hidden" name="image_key" value={staged.key} />
          <input type="hidden" name="image_thumb_key" value={staged.thumb_key ?? ""} />
        </>
      )}

      {staged ? (
        <div className="flex items-start gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={staged.preview_url}
            alt=""
            className="size-24 shrink-0 rounded border border-ink-100 bg-ink-50 object-contain"
          />
          <div className="min-w-0 flex-1">
            <div className="meta">
              {staged.width && staged.height
                ? <>{staged.width}×{staged.height} · </>
                : null}
              {(staged.bytes / 1024).toFixed(0)}KB
            </div>

            <div className="mt-2">
              <label className="label" htmlFor="image_alt">What is in the picture</label>
              <input
                id="image_alt"
                name="image_alt"
                className="field"
                placeholder="1kg pack of toor dal, yellow label"
              />
              <p className="meta mt-1">
                Read aloud by a screen reader, and shown when the photo will not load.
              </p>
            </div>

            <button
              type="button"
              onClick={clear}
              className="btn btn-ghost mt-2 text-[13px] py-1"
            >
              Choose a different photo
            </button>
          </div>
        </div>
      ) : (
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/avif"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void choose(f);
          }}
          className="block w-full text-sm file:mr-3 file:rounded-md file:border-0
                     file:bg-teal-600 file:px-3 file:py-2 file:text-sm file:font-semibold
                     file:text-white hover:file:bg-teal-700 disabled:opacity-50"
        />
      )}

      {busy && <p className="meta mt-2">Resizing and uploading…</p>}
      {note && <div className="notice notice-info mt-3">{note}</div>}
      {error && <div className="notice notice-bad mt-3"><b>Refused:</b> {error}</div>}

      {!staged && !busy && (
        <p className="meta mt-2">
          Optional — you can add photographs later. Resized in this browser before it is
          sent, so a 4MB phone picture leaves as about 300KB.
        </p>
      )}
    </div>
  );
}
