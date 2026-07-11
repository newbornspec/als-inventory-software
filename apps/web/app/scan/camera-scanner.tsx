'use client';

import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
// Type-only import — erased at build, so it doesn't pull tesseract into the bundle.
import type { Worker as TesseractWorker } from 'tesseract.js';

// Prefer a higher-res back camera — small barcodes and serial text need the
// detail. `ideal` degrades gracefully on devices that can't hit it.
const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: 'environment',
  width: { ideal: 1920 },
  height: { ideal: 1080 },
};

interface CameraScannerProps {
  onDecode: (text: string) => void;
  // Called with text read via OCR — fallible, so the caller should let the
  // user confirm it rather than acting on it directly.
  onReadText?: (text: string) => void;
  // Minimum time between accepted decodes, so a code that's still in frame
  // doesn't fire the same scan repeatedly while the phone is held steady.
  cooldownMs?: number;
}

// Minimal typing for the experimental BarcodeDetector API (not in TS DOM libs).
interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

// Extract the asset identifier from OCR'd label text. Vendor labels (e.g. Dell)
// print the serial next to a "SERVICE TAG" / "S/N" caption amid a lot of
// regulatory noise (model, reg model, agency codes) — a plain "longest token"
// pick reliably grabs the wrong thing (P62G001, ZU10190, MSIP-...). So: anchor
// on the caption first, then the Express Service Code, then the Dell
// service-tag shape (7 alphanumerics, excluding the regulatory codes), and only
// then fall back to a generic longest-mixed-token.
function pickSerial(text: string): string {
  const up = text.toUpperCase().replace(/\|/g, 'I');

  // 1) Value following a Service Tag / Serial caption — most reliable.
  const captioned = [
    /SERVICE\s*TAG\s*\(?\s*S\s*\/?\s*N\s*\)?\s*[:#.\-]*\s*([A-Z0-9]{5,14})/,
    /SERVICE\s*TAG\s*[:#.\-]*\s*([A-Z0-9]{5,14})/,
    /\bS\s*\/\s*N\b\s*[:#.\-]*\s*([A-Z0-9]{5,14})/,
    /SERIAL(?:\s*(?:NO|NUMBER))?\s*[:#.\-]*\s*([A-Z0-9]{5,14})/,
  ];
  for (const re of captioned) {
    const m = up.match(re);
    if (m) return m[1];
  }

  // 2) Express Service Code caption (numeric).
  const esc = up.match(/EXPRESS\s*SERVICE\s*CODE\s*[:#.\-]*\s*([0-9]{8,14})/);
  if (esc) return esc[1];

  const tokens = up.match(/[A-Z0-9]{5,}/g) ?? [];

  // 3) Dell service-tag shape: exactly 7 alphanumerics (letters + digits), not
  //    one of the regulatory/model codes also printed on the label.
  const REG = /^(P62G|MSIP|CMM|IEC|ISO|EN\d|NMB|ICES|CAN|ZU\d|DPN|DPC|M0|R4|R-)/;
  const dell = tokens.find(
    (t) => t.length === 7 && /[A-Z]/.test(t) && /[0-9]/.test(t) && !REG.test(t),
  );
  if (dell) return dell;

  // 4) Fallback: longest mixed-alphanumeric token.
  const mixed = tokens.filter((t) => /[A-Z]/.test(t) && /[0-9]/.test(t));
  const byLen = (a: string, b: string) => b.length - a.length;
  return mixed.sort(byLen)[0] ?? tokens.sort(byLen)[0] ?? '';
}

// Points the phone's back camera at a label. Two barcode engines — the
// browser-native BarcodeDetector (fast + reliable on Android Chrome, what
// Google Lens uses) when available, else @zxing as a fallback — plus a
// "Read text" button that OCRs the frame for labels with no scannable code.
export function CameraScanner({ onDecode, onReadText, cooldownMs = 1500 }: CameraScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastDecodeRef = useRef<{ text: string; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<'native' | 'zxing' | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrStatus, setOcrStatus] = useState('');
  const [ocrError, setOcrError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | undefined;
    let loopTimer: ReturnType<typeof setTimeout> | undefined;
    let zxingControls: { stop: () => void } | undefined;
    const video = videoRef.current;
    if (!video) return;

    function accept(text: string) {
      const clean = text.trim();
      if (!clean) return;
      const now = Date.now();
      const last = lastDecodeRef.current;
      if (last && last.text === clean && now - last.at < cooldownMs) return;
      lastDecodeRef.current = { text: clean, at: now };
      onDecode(clean);
    }

    function failed(err: unknown) {
      const e = err as { name?: string; message?: string };
      setError(
        e.name === 'NotAllowedError'
          ? 'Camera access was denied. Allow camera permission for this site and reload.'
          : `Could not start camera: ${e.message ?? 'unknown error'}`,
      );
    }

    async function startNative(Ctor: BarcodeDetectorCtor): Promise<boolean> {
      try {
        const formats = await Ctor.getSupportedFormats();
        const detector = new Ctor({ formats });
        stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return true;
        }
        video!.srcObject = stream;
        await video!.play();
        setEngine('native');
        const loop = async () => {
          if (cancelled) return;
          try {
            const codes = await detector.detect(video!);
            if (codes.length > 0) accept(codes[0].rawValue);
          } catch {
            /* transient per-frame detect errors are expected; keep going */
          }
          if (!cancelled) loopTimer = setTimeout(loop, 120); // ~8 checks/sec
        };
        loop();
        return true;
      } catch {
        stream?.getTracks().forEach((t) => t.stop());
        stream = undefined;
        return false;
      }
    }

    async function startZxing() {
      try {
        const reader = new BrowserMultiFormatReader();
        const controls = await reader.decodeFromConstraints(
          { video: VIDEO_CONSTRAINTS },
          video!,
          (result) => {
            if (result) accept(result.getText());
          },
        );
        if (cancelled) controls.stop();
        else {
          zxingControls = controls;
          setEngine('zxing');
        }
      } catch (err) {
        failed(err);
      }
    }

    (async () => {
      const Ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
      if (Ctor && (await startNative(Ctor))) return;
      await startZxing();
    })();

    return () => {
      cancelled = true;
      if (loopTimer) clearTimeout(loopTimer);
      zxingControls?.stop();
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cooldownMs]);

  async function readText() {
    const video = videoRef.current;
    if (!video || !onReadText || ocrBusy) return;
    setOcrBusy(true);
    setOcrError(null);
    setOcrStatus('starting…');
    let worker: TesseractWorker | undefined;
    try {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) {
        setOcrError('Camera not ready yet — try again in a second.');
        return;
      }
      // Crop to the central guide box, then upscale ~2x — OCR is markedly
      // better on larger glyphs.
      const mx = vw * 0.08;
      const my = vh * 0.08;
      const cw = vw - mx * 2;
      const ch = vh - my * 2;
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(cw * scale);
      canvas.height = Math.round(ch * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        setOcrError('Could not capture the frame.');
        return;
      }
      ctx.drawImage(video, mx, my, cw, ch, 0, 0, canvas.width, canvas.height);

      // Grayscale + contrast stretch so the serial stands out from the label.
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const v = Math.max(0, Math.min(255, (g - 128) * 1.7 + 128));
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      ctx.putImageData(img, 0, 0);

      // Loaded on demand so the OCR engine isn't in the main bundle. The worker
      // API lets us constrain recognition to serial characters and treat the
      // crop as a single block — both big accuracy wins over free-form OCR.
      const Tesseract = await import('tesseract.js');
      worker = await Tesseract.createWorker('eng', 1, {
        logger: (m: { status?: string; progress?: number }) => {
          if (m.status && typeof m.progress === 'number') {
            setOcrStatus(`${m.status} ${Math.round(m.progress * 100)}%`);
          }
        },
      });
      await worker.setParameters({
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-',
        tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK,
      });
      const { data } = await worker.recognize(canvas);
      const serial = pickSerial(data.text ?? '');
      if (!serial) {
        setOcrError('No readable text found — hold closer and steadier over the serial.');
        return;
      }
      onReadText(serial);
    } catch {
      setOcrError('Text reading failed — try again.');
    } finally {
      if (worker) await worker.terminate();
      setOcrBusy(false);
      setOcrStatus('');
    }
  }

  if (error) {
    return (
      <div className="max-w-sm rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
        {error}
      </div>
    );
  }

  return (
    <div className="max-w-sm space-y-2">
      <div className="relative overflow-hidden rounded-md border border-neutral-700 bg-black">
        <video ref={videoRef} className="w-full" muted playsInline autoPlay />
        <div className="pointer-events-none absolute inset-8 rounded-md border-2 border-emerald-400/70" />
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-neutral-500">
          {engine === 'zxing'
            ? 'Point at the Service Tag barcode — it reads automatically (compatibility mode).'
            : 'Point at the Service Tag barcode — it reads automatically.'}
        </p>
        {onReadText && (
          <button
            type="button"
            onClick={readText}
            disabled={ocrBusy}
            className="shrink-0 rounded-md border border-neutral-600 px-3 py-1.5 text-xs font-medium text-neutral-100 disabled:opacity-50"
          >
            {ocrBusy ? 'Reading…' : 'Read text (no barcode)'}
          </button>
        )}
      </div>
      {ocrBusy && ocrStatus && <p className="text-xs text-neutral-500">{ocrStatus}</p>}
      {ocrError && <p className="text-xs text-amber-400">{ocrError}</p>}
    </div>
  );
}
