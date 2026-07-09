'use client';

import { useEffect } from 'react';

export function ServiceWorkerRegister() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // Non-fatal: the app still works, it just won't be installable/offline-launchable.
      });
    }
  }, []);
  return null;
}
