'use client';

import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
// Type-only import — erased at build, so it doesn't pull tesseract into the bundle.
import type { Worker as TesseractWorker } from 'tesseract.js';

interface CameraScannerProps {
  onDecode: (text: string) => void;
  onReadText?: (text: string) => void;
  cooldownMs?: number;
}

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

const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: 'environment',
  width: { ideal: 1920 },
  height: { ideal: 1080 },
};

// The OCR crop region (fractions of the frame) — a wide central band, matching
// the on-screen guide box. Barcode detection runs on the full frame (more
// forgiving); the box just helps the user aim.
const BOX = { x: 0.08, y: 0.34 };

function boxRect(v: HTMLVideoElement) {
  const sx = Math.round(v.videoWidth * BOX.x);
  const sy = Math.round(v.videoHeight * BOX.y);
  return { sx, sy, sw: v.videoWidth - sx * 2, sh: v.videoHeight - sy * 2 };
}

// From the barcodes found in frame, prefer a Dell-service-tag-shaped value
// (7 alphanumerics, letters+digits) over, say, the numeric Express Service Code
// that sits right beside it on the label.
function pickBarcode(codes: DetectedBarcode[]): string {
  const vals = codes.map((c) => c.rawValue.trim()).filter(Boolean);
  const tag = vals.find((v) => /^[A-Za-z0-9]{7}$/.test(v) && /[A-Za-z]/.test(v) && /[0-9]/.test(v));
  return tag ?? vals[0] ?? '';
}

// Anchor on the "SERVICE TAG"/"S/N" caption, then Express Service Code, then the
// Dell service-tag shape (excluding regulatory codes), then longest token.
function pickSerial(text: string): string {
  const up = text.toUpperCase().replace(/\|/g, 'I');
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
  const esc = up.match(/EXPRESS\s*SERVICE\s*CODE\s*[:#.\-]*\s*([0-9]{8,14})/);
  if (esc) return esc[1];
  const tokens = up.match(/[A-Z0-9]{5,}/g) ?? [];
  const REG = /^(P62G|MSIP|CMM|IEC|ISO|EN\d|NMB|ICES|CAN|ZU\d|DPN|DPC|M0|R4|R-)/;
  const dell = tokens.find(
    (t) => t.length === 7 && /[A-Z]/.test(t) && /[0-9]/.test(t) && !REG.test(t),
  );
  if (dell) return dell;
  const mixed = tokens.filter((t) => /[A-Z]/.test(t) && /[0-9]/.test(t));
  const byLen = (a: string, b: string) => b.length - a.length;
  return mixed.sort(byLen)[0] ?? tokens.sort(byLen)[0] ?? '';
}

export function CameraScanner({ onDecode, onReadText, cooldownMs = 1500 }: CameraScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastDecodeRef = useRef<{ text: string; at: number } | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<'native' | 'zxing' | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [torchFailed, setTorchFailed] = useState(false);
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
        trackRef.current = stream.getVideoTracks()[0] ?? null;
        setEngine('native');

        const loop = async () => {
          if (cancelled) return;
          try {
            const codes = await detector.detect(video!);
            if (codes.length > 0) accept(pickBarcode(codes));
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
        if (cancelled) {
          controls.stop();
        } else {
          zxingControls = controls;
          // zxing manages its own stream; grab the track for the torch toggle.
          trackRef.current =
            (video!.srcObject as MediaStream | null)?.getVideoTracks()[0] ?? null;
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
      trackRef.current = null;
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cooldownMs]);

  async function toggleTorch() {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    try {
      // `torch` is a real Android/Chrome constraint but not in the TS DOM lib.
      await track.applyConstraints({ advanced: [{ torch: next }] } as unknown as MediaTrackConstraints);
      setTorchOn(next);
    } catch {
      setTorchFailed(true); // this device won't do torch from the browser
    }
  }

  async function readText() {
    const video = videoRef.current;
    if (!video || !onReadText || ocrBusy) return;
    setOcrBusy(true);
    setOcrError(null);
    setOcrStatus('starting…');
    let worker: TesseractWorker | undefined;
    try {
      if (!video.videoWidth || !video.videoHeight) {
        setOcrError('Camera not ready yet — try again in a second.');
        return;
      }
      const { sx, sy, sw, sh } = boxRect(video);
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(sw * scale);
      canvas.height = Math.round(sh * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        setOcrError('Could not capture the frame.');
        return;
      }
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const v = Math.max(0, Math.min(255, (g - 128) * 1.7 + 128));
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      ctx.putImageData(img, 0, 0);

      const Tesseract = await import('tesseract.js');
      worker = await Tesseract.createWorker('eng', 1, {
        logger: (m: { status?: string; progress?: number }) => {
          if (m.status && typeof m.progress === 'number') {
            setOcrStatus(`${m.status} ${Math.round(m.progress * 100)}%`);
          }
        },
      });
      await worker.setParameters({
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/():. ',
        tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK,
      });
      const { data } = await worker.recognize(canvas);
      const serial = pickSerial(data.text ?? '');
      if (!serial) {
        setOcrError('No readable text found — hold the Service Tag inside the box, closer and steady.');
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
        <div
          className="pointer-events-none absolute rounded-md border-2 border-emerald-400/70"
          style={{ left: '8%', right: '8%', top: '34%', bottom: '34%' }}
        />
        {engine && !torchFailed && (
          <button
            type="button"
            onClick={toggleTorch}
            aria-pressed={torchOn}
            className={
              'absolute right-2 top-2 rounded-full px-3 py-1.5 text-xs font-medium ' +
              (torchOn ? 'bg-amber-400 text-neutral-900' : 'bg-black/60 text-neutral-100')
            }
          >
            {torchOn ? '⚡ Flash on' : '⚡ Flash'}
          </button>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-neutral-500">
          Fill the frame with the Service Tag barcode — it reads automatically.
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
      <p className="text-[11px] text-neutral-600">
        Scanner:{' '}
        {engine === 'native'
          ? 'fast (native)'
          : engine === 'zxing'
            ? 'compatibility mode'
            : 'starting…'}
        {torchFailed ? ' · flash not supported here' : ''}
      </p>
      {ocrBusy && ocrStatus && <p className="text-xs text-neutral-500">{ocrStatus}</p>}
      {ocrError && <p className="text-xs text-amber-400">{ocrError}</p>}
    </div>
  );
}
