"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Barcode capture for the receiving flow.
 *
 * ── Why this is not a library ──
 *
 * Chrome and Android WebView ship `BarcodeDetector` natively. On a
 * shop-floor Android phone — which is the device this exists for —
 * that is a camera stream and about forty lines. Pulling in a WASM
 * decoder would add ~300KB to the one screen where load time is
 * measured with a stopwatch against a paper process.
 *
 * ── The fallback is not a consolation prize ──
 *
 * Handheld USB and Bluetooth scanners present as keyboards: they type
 * the barcode and press Enter. That path works everywhere, needs no
 * camera permission, and is what most warehouses actually use. It is
 * wired first and always available; the camera is the addition.
 */

type Props = {
  /** Called with the decoded value. */
  onScan: (code: string) => void;
  /** Shown under the input as a hint. */
  hint?: string;
};

export function Scanner({ onScan, hint }: Props) {
  const [cameraOn, setCameraOn] = useState(false);
  const [supported, setSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    setSupported(
      typeof window !== "undefined" &&
      "BarcodeDetector" in window &&
      !!navigator.mediaDevices?.getUserMedia,
    );
  }, []);

  // Keep the keyboard-wedge input focused. A handheld scanner types
  // into whatever has focus, so losing it means the barcode lands in
  // a quantity box.
  useEffect(() => {
    if (!cameraOn) inputRef.current?.focus();
  }, [cameraOn]);

  useEffect(() => {
    if (!cameraOn) return;
    let cancelled = false;

    (async () => {
      try {
        const Detector = (window as any).BarcodeDetector;
        const detector = new Detector({
          formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"],
        });

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        const tick = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const found = await detector.detect(videoRef.current);
            if (found.length > 0) {
              const value = found[0].rawValue as string;
              // Debounce: one barcode stays in frame for many frames.
              setLast((prev) => {
                if (prev !== value) {
                  navigator.vibrate?.(40);
                  onScan(value);
                }
                return value;
              });
            }
          } catch { /* a dropped frame is not an error */ }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (e) {
        setError(
          e instanceof DOMException && e.name === "NotAllowedError"
            ? "Camera permission was refused. Use the scanner or type the code."
            : "Could not start the camera. Use the scanner or type the code.",
        );
        setCameraOn(false);
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [cameraOn, onScan]);

  return (
    <div className="card card-pad">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1">
          <label className="label" htmlFor="scan">Scan or type a barcode</label>
          <input
            ref={inputRef}
            id="scan"
            className="field text-lg tnum"
            inputMode="text"
            autoComplete="off"
            placeholder="8901234500011"
            onKeyDown={(e) => {
              // A handheld scanner ends its burst with Enter.
              if (e.key !== "Enter") return;
              e.preventDefault();
              const el = e.currentTarget;
              const v = el.value.trim();
              if (v) { onScan(v); el.value = ""; }
            }}
          />
        </div>

        {supported && (
          <button
            type="button"
            onClick={() => { setError(null); setCameraOn((v) => !v); }}
            className={cameraOn ? "btn btn-danger" : "btn btn-ghost"}
          >
            {cameraOn ? "Stop camera" : "Use camera"}
          </button>
        )}
      </div>

      {hint && <p className="meta mt-2">{hint}</p>}

      {!supported && (
        <p className="meta mt-2">
          This browser has no barcode camera. A handheld scanner works here — it types the
          code and presses Enter, which is what the box above is waiting for.
        </p>
      )}

      {error && <div className="notice notice-warn mt-3">{error}</div>}

      {cameraOn && (
        <div className="relative mt-3 overflow-hidden rounded-lg bg-ink-950">
          <video ref={videoRef} playsInline muted
                 className="block max-h-64 w-full object-cover" />
          {/* A frame to aim with. Nothing clever — people point at
              the thing that looks like a target. */}
          <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="h-20 w-3/4 rounded-md border-2 border-white/70" />
          </div>
          {last && (
            <div className="absolute inset-x-0 bottom-0 bg-ink-950/80 px-3 py-2 text-center">
              <span className="mono text-sm text-white">{last}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
