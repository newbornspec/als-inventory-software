'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { deletePhoto, type PhotoMeta } from '@/lib/actions/photos';

// Resize/compress in the browser so DB rows stay small (photos are stored as
// bytea). Longest edge capped at 1600px, JPEG q0.82 — usually well under 500KB.
function compress(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const max = 1600;
      let { width, height } = img;
      if (width > max || height > max) {
        const s = Math.min(max / width, max / height);
        width = Math.round(width * s);
        height = Math.round(height * s);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('canvas unsupported'));
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.82).split(',')[1]);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('not an image'));
    };
    img.src = url;
  });
}

export function PhotosSection({
  assetId,
  photos,
  canManage,
}: {
  assetId: string;
  photos: PhotoMeta[];
  canManage: boolean;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const data = await compress(file);
      const res = await fetch(`/api/assets/${assetId}/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data, contentType: 'image/jpeg', caption: caption.trim() || undefined }),
      });
      if (!res.ok) throw new Error('upload failed');
      setCaption('');
      router.refresh();
    } catch {
      setError('Upload failed — please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await deletePhoto(assetId, id);
      router.refresh();
    } catch {
      setError('Couldn’t delete that photo.');
    }
  }

  return (
    <section>
      <h2 className="text-sm font-medium text-neutral-400">Photos</h2>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder="caption (optional)"
          className="w-48 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={onFile}
          className="hidden"
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="rounded bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 disabled:opacity-50"
        >
          {busy ? 'Uploading…' : '+ Add photo'}
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>

      {photos.length > 0 ? (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {photos.map((p) => (
            <div key={p.id} className="overflow-hidden rounded-lg border border-neutral-800">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/assets/${assetId}/photos/${p.id}`}
                alt={p.caption ?? 'Device photo'}
                className="h-32 w-full object-cover"
              />
              <div className="flex items-center justify-between gap-2 px-2 py-1">
                <span className="truncate text-xs text-neutral-400">{p.caption ?? '—'}</span>
                {canManage && (
                  <button
                    onClick={() => remove(p.id)}
                    className="shrink-0 text-xs text-red-400 hover:underline"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-neutral-500">No photos yet.</p>
      )}
    </section>
  );
}
