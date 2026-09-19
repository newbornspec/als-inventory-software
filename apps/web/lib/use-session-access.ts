'use client';

import { useEffect, useState } from 'react';
import type { SessionAccess } from './permissions';

// The signed-in user's role and permissions, for client components that must
// work OFFLINE - the Scan page above all, which is the one screen a technician
// uses in a warehouse with no signal.
//
// Online it asks /api/me (DB-fresh, the same source the nav uses) and remembers
// the answer on this device. Offline it uses that remembered answer, so a person
// allowed to hand-record wipes can still do it with no signal, and a person
// who cannot record audits is not handed a form whose result the server will
// discard on sync.
//
// This is UI gating ONLY. The API enforces every one of these permissions on
// upload regardless (powersync.service.ts screen()), so a stale cached "yes"
// after a grant is revoked shows a choice the server then refuses - never one
// it accepts.
const KEY = 'als.sessionAccess';

function readCache(): SessionAccess | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && typeof v.userId === 'string' && Array.isArray(v.permissions) ? (v as SessionAccess) : null;
  } catch {
    return null; // private mode, blocked storage, or a corrupt value
  }
}

function writeCache(v: SessionAccess | null) {
  try {
    if (v) window.localStorage.setItem(KEY, JSON.stringify(v));
    else window.localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: online answers still work, offline falls back to "no" */
  }
}

export function useSessionAccess(): SessionAccess | null {
  // Start from the remembered answer, so offline there is no flash of the
  // "no permission" state before anything could have loaded.
  const [access, setAccess] = useState<SessionAccess | null>(null);

  useEffect(() => {
    setAccess(readCache());
    let live = true;
    fetch('/api/me')
      .then(async (r) => {
        if (r.status === 401) {
          // Signed out: forget the previous person's permissions on this device.
          writeCache(null);
          if (live) setAccess(null);
          return;
        }
        if (!r.ok) return; // server trouble: keep the remembered answer
        const me = (await r.json()) as SessionAccess;
        writeCache(me);
        if (live) setAccess(me);
      })
      .catch(() => {
        /* offline: the remembered answer stands */
      });
    return () => {
      live = false;
    };
  }, []);

  return access;
}
