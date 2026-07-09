'use client';

import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';

interface CameraScannerProps {
  onDecode: (text: string) => void;
  // Minimum time between accepted decodes, so a code that's still in frame
  // doesn't fire the same scan repeatedly while the phone is held steady.
  cooldownMs?: number;
}

// Wraps @zxing/browser's continuous decode loop around the phone's back
// camera. This is what makes the installed PWA a real scanner, not just a
// manual-entry form: point the camera, get an instant local-SQLite write via
// the same handleScan path the keyboard-wedge/manual input uses.
export function CameraScanner({ onDecode, cooldownMs = 1500 }: CameraScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastDecodeRef = useRef<{ text: string; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const reader = new BrowserMultiFormatReader();
    let controls: { stop: () => void } | undefined;
    let cancelled = false;

    // decodeFromConstraints(constraints, videoElement, callback) is the
    // documented @zxing/browser pattern as of writing — verify against the
    // current README if this errors after an SDK version bump.
    reader
      .decodeFromConstraints(
        { video: { facingMode: 'environment' } },
        videoRef.current!,
        (result) => {
          if (!result) return;
          const text = result.getText();
          const now = Date.now();
          const last = lastDecodeRef.current;
          if (last && last.text === text && now - last.at < cooldownMs) return;
          lastDecodeRef.current = { text, at: now };
          onDecode(text);
        },
      )
      .then((c) => {
        if (cancelled) {
          c.stop();
        } else {
          controls = c;
        }
      })
      .catch((err: Error) => {
        setError(
          err.name === 'NotAllowedError'
            ? 'Camera access was denied. Allow camera permission for this site and reload.'
            : `Could not start camera: ${err.message}`,
        );
      });

    return () => {
      cancelled = true;
      controls?.stop();
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
    <div className="relative max-w-sm overflow-hidden rounded-md border border-neutral-700 bg-black">
      <video ref={videoRef} className="w-full" muted playsInline />
      <div className="pointer-events-none absolute inset-8 rounded-md border-2 border-emerald-400/70" />
    </div>
  );
}
