'use client';

import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';

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

// Pull the most serial-number-like token out of a blob of OCR text: an
// alphanumeric run of 5+ chars, preferring ones that mix letters and digits
// (as serials/service tags usually do), longest first.
function pickSerial(text: string): string {
  const tokens = (text.toUpperCase().match(/[A-Z0-9][A-Z0-9-]{4,}/g) ?? []).map((s) =>
    s.replace(/^-+|-+$/g, ''),
  );
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
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
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
          if (!cancelled) loopTimer = setTimeout(loop, 200); // ~5 checks/sec
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
          { video: { facingMode: 'environment' } },
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
    try {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) {
        setOcrError('Camera not ready yet — try again in a second.');
        return;
      }
      // Crop to the central guide box to cut background/label edges.
      const mx = vw * 0.08;
      const my = vh * 0.08;
      const cw = vw - mx * 2;
      const ch = vh - my * 2;
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        setOcrError('Could not capture the frame.');
        return;
      }
      ctx.drawImage(video, mx, my, cw, ch, 0, 0, cw, ch);

      // Loaded on demand so the OCR engine isn't in the main bundle.
      const Tesseract = await import('tesseract.js');
      const { data } = await Tesseract.recognize(canvas, 'eng', {
        logger: (m: { status?: string; progress?: number }) => {
          if (m.status && typeof m.progress === 'number') {
            setOcrStatus(`${m.status} ${Math.round(m.progress * 100)}%`);
          }
        },
      });
      const serial = pickSerial(data.text ?? '');
      if (!serial) {
        setOcrError('No readable text found — hold closer and steadier over the serial.');
        return;
      }
      onReadText(serial);
    } catch {
      setOcrError('Text reading failed — try again.');
    } finally {
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
            ? 'Point at a barcode or QR (compatibility mode).'
            : 'Point at a barcode or QR code.'}
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
