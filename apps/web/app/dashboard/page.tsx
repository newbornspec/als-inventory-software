import Link from 'next/link';
import { apiFetch } from '@/lib/api-server';
import type { Asset } from '@/lib/actions/assets';
import { Nav } from '@/app/components/nav';

interface Notification {
  id: string;
  severity: 'critical' | 'warning';
  assetId: string;
  message: string;
}

export default async function DashboardPage() {
  const [assets, notifications] = await Promise.all([
    apiFetch<Asset[]>('/assets'),
    apiFetch<Notification[]>('/notifications'),
  ]);

  const counts = assets.reduce<Record<string, number>>((acc, asset) => {
    acc[asset.stockStatus] = (acc[asset.stockStatus] ?? 0) + 1;
    return acc;
  }, {});

  const tiles = [
    { label: 'Total assets', value: assets.length },
    { label: 'In stock', value: counts.in_stock ?? 0 },
    { label: 'Allocated', value: counts.allocated ?? 0 },
    { label: 'Quarantined', value: counts.quarantined ?? 0 },
  ];

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {tiles.map((tile) => (
            <div
              key={tile.label}
              className="rounded-lg border border-neutral-800 bg-neutral-900 p-4"
            >
              <div className="text-2xl font-semibold">{tile.value}</div>
              <div className="mt-1 text-sm text-neutral-400">{tile.label}</div>
            </div>
          ))}
        </div>

        <div className="mt-8">
          <h2 className="text-sm font-medium text-neutral-400">Alerts</h2>
          <ul className="mt-3 space-y-2">
            {notifications.map((n) => (
              <li key={n.id}>
                <Link
                  href={`/assets/${n.assetId}`}
                  className={
                    'block rounded-md border px-4 py-2 text-sm ' +
                    (n.severity === 'critical'
                      ? 'border-red-900 bg-red-950/40 text-red-300'
                      : 'border-amber-900 bg-amber-950/40 text-amber-300')
                  }
                >
                  {n.message}
                </Link>
              </li>
            ))}
            {notifications.length === 0 && (
              <li className="text-sm text-neutral-500">No alerts right now.</li>
            )}
          </ul>
        </div>
      </div>
    </main>
  );
}
