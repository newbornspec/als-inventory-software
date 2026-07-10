'use client';

import { useEffect, useRef, useState } from 'react';
import { getPowerSyncDb } from '@/lib/powersync/client';
import { Nav } from '@/app/components/nav';
import { AuditForm } from '@/app/components/audit-form';
import { formatLabel } from '@/lib/asset-options';
import { CameraScanner } from './camera-scanner';

type ScannedAsset = { id: string; name: string; tag: string; stock_status: string };

type ScanResult =
  | { status: 'ok'; asset: ScannedAsset }
  | { status: 'not_found'; tag: string }
  | null;

type Mode = 'keyboard' | 'camera';

interface OpenBatch {
  id: string;
  batch_number: string;
  expected_unit_count: number | null;
}

export default function ScanPage() {
  const [mode, setMode] = useState<Mode>('keyboard');
  const [tag, setTag] = useState('');
  const [result, setResult] = useState<ScanResult>(null);
  const [showAudit, setShowAudit] = useState(false);
  const [recent, setRecent] = useState<{ tag: string; name: string; when: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Receiving: when a batch is selected, every resolved scan also links the
  // asset to it (assets.batch_id) — same local-write, offline-safe path as
  // everything else on this page. receivedCount is a live COUNT(*) against
  // local SQLite, so it's accurate even before anything has synced.
  const [openBatches, setOpenBatches] = useState<OpenBatch[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [receivedCount, setReceivedCount] = useState(0);

  useEffect(() => {
    if (mode === 'keyboard') inputRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    const db = getPowerSyncDb();
    // getAll<T>(sql, params) is the multi-row counterpart to db.get() used
    // elsewhere on this page — verify against @powersync/web's current API
    // if this errors after an SDK version bump.
    db.getAll<OpenBatch>(
      "SELECT id, batch_number, expected_unit_count FROM batches WHERE status IN ('open', 'receiving') ORDER BY batch_number DESC",
    ).then(setOpenBatches);
  }, []);

  useEffect(() => {
    if (!selectedBatchId) {
      setReceivedCount(0);
      return;
    }
    refreshReceivedCount(selectedBatchId);
  }, [selectedBatchId]);

  async function refreshReceivedCount(batchId: string) {
    const db = getPowerSyncDb();
    const row = await db.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM assets WHERE batch_id = ?',
      [batchId],
    );
    setReceivedCount(row?.count ?? 0);
  }

  // Shared by both scan sources: a USB/Bluetooth scanner emulating keyboard
  // input (or manual typing) submits through the form below; the phone
  // camera calls this directly from CameraScanner's onDecode. Either way it
  // resolves against local SQLite and writes the scan event the same way —
  // there is no "camera path" vs "keyboard path" beyond how the tag arrives.
  async function processScan(scannedTag: string) {
    const db = getPowerSyncDb();
    if (!scannedTag) return;
    setShowAudit(false);

    // getOptional(), not get() — a tag that doesn't match any asset is a
    // real, expected outcome here (handled below via the 'not_found' status),
    // not an exceptional one. db.get() throws "Result set is empty" on zero
    // rows; getOptional() returns null instead.
    const asset = await db.getOptional<ScannedAsset>(
      'SELECT id, name, tag, stock_status FROM assets WHERE tag = ?',
      [scannedTag],
    );

    if (!asset) {
      setResult({ status: 'not_found', tag: scannedTag });
      return;
    }

    await db.execute(
      `INSERT INTO asset_history (id, asset_id, event_type, user_id, created_at)
       VALUES (uuid(), ?, 'scanned', NULL, datetime('now'))`,
      [asset.id],
    );

    if (selectedBatchId) {
      await db.execute('UPDATE assets SET batch_id = ? WHERE id = ?', [selectedBatchId, asset.id]);
      await refreshReceivedCount(selectedBatchId);
    }

    setResult({ status: 'ok', asset });
    setRecent((prev) => [
      { tag: asset.tag, name: asset.name, when: new Date().toLocaleTimeString() },
      ...prev.slice(0, 9),
    ]);
  }

  async function handleFormScan(e: React.FormEvent) {
    e.preventDefault();
    const scannedTag = tag.trim();
    setTag('');
    inputRef.current?.focus();
    await processScan(scannedTag);
  }

  const selectedBatch = openBatches.find((b) => b.id === selectedBatchId);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Scan Asset</h1>
            <p className="mt-1 text-sm text-neutral-400">
              {mode === 'keyboard'
                ? 'Point a USB/Bluetooth scanner here, or type a tag and press Enter.'
                : "Point your phone's camera at a QR code or barcode."}{' '}
              Works offline.
            </p>
          </div>
          <div className="flex rounded-md border border-neutral-700 text-sm">
            <button
              onClick={() => setMode('keyboard')}
              className={
                'px-3 py-1.5 ' + (mode === 'keyboard' ? 'bg-neutral-100 text-neutral-900' : 'text-neutral-300')
              }
            >
              Keyboard
            </button>
            <button
              onClick={() => setMode('camera')}
              className={
                'px-3 py-1.5 ' + (mode === 'camera' ? 'bg-neutral-100 text-neutral-900' : 'text-neutral-300')
              }
            >
              Camera
            </button>
          </div>
        </div>

        <div className="mt-6 max-w-sm rounded-md border border-neutral-800 bg-neutral-900/50 p-3">
          <label className="text-xs text-neutral-400">Receiving into lot (optional)</label>
          <select
            value={selectedBatchId}
            onChange={(e) => setSelectedBatchId(e.target.value)}
            className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm"
          >
            <option value="">Not receiving — scan only</option>
            {openBatches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.batch_number}
              </option>
            ))}
          </select>
          {selectedBatch && (
            <p className="mt-2 text-sm text-neutral-300">
              {receivedCount} / {selectedBatch.expected_unit_count ?? '—'} units received —
              every scan below is added to this lot.
            </p>
          )}
        </div>

        {mode === 'keyboard' ? (
          <form onSubmit={handleFormScan} className="mt-6 max-w-sm">
            <input
              ref={inputRef}
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="Scan or type asset tag…"
              autoComplete="off"
              className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100 outline-none focus:border-neutral-500"
            />
          </form>
        ) : (
          <div className="mt-6">
            <CameraScanner onDecode={processScan} />
          </div>
        )}

        {result?.status === 'ok' && (
          <div className="mt-4 max-w-sm space-y-3">
            <div className="rounded-md border border-emerald-800 bg-emerald-950/50 p-3 text-sm">
              <div>
                Scanned <strong>{result.asset.name}</strong> ({result.asset.tag}) — status:{' '}
                {formatLabel(result.asset.stock_status)}
                {selectedBatch && ' — added to ' + selectedBatch.batch_number}
              </div>
              {!showAudit && (
                <button
                  onClick={() => setShowAudit(true)}
                  className="mt-2 text-xs text-emerald-300 underline"
                >
                  Record ITAD audit for this asset
                </button>
              )}
            </div>
            {showAudit && (
              <AuditForm assetId={result.asset.id} onSaved={() => setShowAudit(false)} />
            )}
          </div>
        )}
        {result?.status === 'not_found' && (
          <div className="mt-4 max-w-sm rounded-md border border-amber-800 bg-amber-950/50 p-3 text-sm">
            No asset found for tag &quot;{result.tag}&quot;.
          </div>
        )}

        {recent.length > 0 && (
          <div className="mt-8 max-w-sm">
            <h2 className="text-sm font-medium text-neutral-400">Recent scans this session</h2>
            <ul className="mt-2 space-y-1 text-sm">
              {recent.map((r, i) => (
                <li key={i} className="flex justify-between text-neutral-300">
                  <span>{r.name}</span>
                  <span className="text-neutral-500">{r.when}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </main>
  );
}
