import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api-server';
import type { Asset } from '@/lib/actions/assets';
import { PrintButton } from './print-button';

export default async function AssetLabelPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let asset: Asset;
  try {
    asset = await apiFetch<Asset>(`/assets/${id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  return (
    <main className="min-h-screen bg-white p-8 text-neutral-900">
      <div className="mx-auto mb-4 max-w-xs print:hidden">
        <Link
          href={`/assets/${asset.id}`}
          className="text-sm text-neutral-600 hover:text-neutral-900"
        >
          ← Back to device
        </Link>
      </div>
      <div className="mx-auto max-w-xs border border-neutral-300 p-4 text-center print:border-black">
        <div className="text-sm font-semibold">{asset.name}</div>
        <div className="text-xs text-neutral-500">{asset.category}</div>

        <img
          src={`/api/assets/${asset.id}/barcode?type=qr`}
          alt={`QR code for ${asset.tag}`}
          className="mx-auto mt-3 h-32 w-32"
        />
        <img
          src={`/api/assets/${asset.id}/barcode?type=code128`}
          alt={`Barcode for ${asset.tag}`}
          className="mx-auto mt-2 h-16"
        />

        <div className="mt-2 text-sm font-mono">{asset.tag}</div>
      </div>

      <div className="mx-auto mt-6 max-w-xs print:hidden">
        <PrintButton />
      </div>
    </main>
  );
}
