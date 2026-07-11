'use client';

import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';

interface CameraScannerProps {
  onDecode: (text: string) => void;
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

// Points the phone's back camera at a label and reads barcodes/QR codes. Two
// engines: the browser-native BarcodeDetector (fast + reliable on Android
// Chrome — this is what Google Lens uses) when available, otherwise @zxing as
// a fallback for browsers that don't ship it. Either way the decoded string
// is handed to onDecode exactly as a keyboard/manual scan would be.
export function CameraScanner({ onDecode, cooldownMs = 1500 }: CameraScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastDecodeRef = useRef<{ text: string; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<'native' | 'zxing' | null>(null);

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
      } catch (err) {
        // Native path failed to start — fall back to zxing rather than error out.
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

  if (error) {
    return (
      <div className="max-w-sm rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
        {error}
      </div>
    );
  }

  return (
    <div className="max-w-sm space-y-1">
      <div className="relative overflow-hidden rounded-md border border-neutral-700 bg-black">
        <video ref={videoRef} className="w-full" muted playsInline autoPlay />
        <div className="pointer-events-none absolute inset-8 rounded-md border-2 border-emerald-400/70" />
      </div>
      <p className="text-xs text-neutral-500">
        {engine === 'native'
          ? 'Point at a barcode or QR code.'
          : engine === 'zxing'
            ? 'Point at a barcode or QR code (compatibility mode).'
            : 'Starting camera…'}
      </p>
    </div>
  );
}
