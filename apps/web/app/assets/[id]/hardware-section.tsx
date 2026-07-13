// Renders the auto-captured hardware profile (assets.hardware_profile JSONB).
// Deliberately generic: it walks whatever the audit tool sent, so new fields
// added to the capture script show up here with no frontend change. Read-only —
// this is machine-captured data, kept separate from the editable warehouse fields.

const CATEGORY_LABELS: Record<string, string> = {
  identification: 'Identification',
  system: 'System & firmware',
  cpu: 'Processor',
  memory: 'Memory',
  storage: 'Storage',
  graphics: 'Graphics',
  display: 'Display',
  battery: 'Battery',
  network: 'Network',
  security: 'Security',
};

const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);

// Singular label for each element of an array-valued category.
const ITEM_LABELS: Record<string, string> = { storage: 'Drive', graphics: 'GPU' };

// Keys whose humanized form isn't just Title-Cased words.
const KEY_LABELS: Record<string, string> = {
  cpu: 'CPU',
  biosUuid: 'BIOS UUID',
  biosVersion: 'BIOS version',
  biosReleaseDate: 'BIOS release date',
  bootMode: 'Boot mode',
  tpm: 'TPM',
  tpmVersion: 'TPM version',
  macAddress: 'MAC address',
  vram: 'VRAM',
  smartStatus: 'SMART status',
  totalGb: 'Total (GB)',
  maxGb: 'Max (GB)',
  expressServiceCode: 'Express service code',
  serialNumber: 'Serial number',
  serviceTag: 'Service tag',
  os: 'OS',
  osVersion: 'OS version',
  osBuild: 'OS build',
  productName: 'Product name',
  productFamily: 'Product family',
  deviceType: 'Device type',
  maxClock: 'Max clock',
  baseClock: 'Base clock',
  cycleCount: 'Cycle count',
  designCapacity: 'Design capacity',
  fullChargeCapacity: 'Full charge capacity',
  secureBoot: 'Secure Boot',
  bitlocker: 'BitLocker',
  biosPassword: 'BIOS password',
  assetTag: 'Asset tag',
  refreshRate: 'Refresh rate',
};

function humanize(key: string): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key];
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatValue(v: unknown): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.map(formatValue).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function KVRows({ obj }: { obj: Record<string, unknown> }) {
  const entries = Object.entries(obj).filter(([, v]) => v != null && v !== '');
  if (entries.length === 0) return null;
  return (
    <dl className="space-y-1.5">
      {entries.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 text-sm">
          <dt className="shrink-0 text-neutral-500">{humanize(k)}</dt>
          <dd className="text-right text-neutral-200 break-all">{formatValue(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function CategoryCard({ name, value }: { name: string; value: unknown }) {
  const title = CATEGORY_LABELS[name] ?? humanize(name);

  let body: React.ReactNode = null;
  if (Array.isArray(value)) {
    const itemLabel = ITEM_LABELS[name] ?? 'Item';
    const items = value.filter((el) => el && typeof el === 'object');
    if (items.length === 0) return null;
    body = (
      <div className="space-y-3">
        {items.map((el, i) => (
          <div key={i} className="rounded-md border border-neutral-800 p-2">
            <div className="mb-1 text-xs font-medium text-neutral-500">
              {itemLabel} {i + 1}
            </div>
            <KVRows obj={el as Record<string, unknown>} />
          </div>
        ))}
      </div>
    );
  } else if (value && typeof value === 'object') {
    body = <KVRows obj={value as Record<string, unknown>} />;
    if (Object.values(value as Record<string, unknown>).every((v) => v == null || v === '')) {
      return null;
    }
  } else {
    body = <div className="text-sm text-neutral-200">{formatValue(value)}</div>;
  }

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        {title}
      </h3>
      {body}
    </div>
  );
}

export function HardwareSection({ profile }: { profile: Record<string, unknown> | null | undefined }) {
  if (!profile || Object.keys(profile).length === 0) return null;

  const known = CATEGORY_ORDER.filter((k) => k in profile);
  const extra = Object.keys(profile).filter((k) => !CATEGORY_ORDER.includes(k));
  const ordered = [...known, ...extra];

  return (
    <section className="md:col-span-2">
      <div className="flex items-baseline gap-3">
        <h2 className="text-sm font-medium text-neutral-400">Hardware profile</h2>
        <span className="text-xs text-neutral-600">Auto-captured · read-only</span>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {ordered.map((cat) => (
          <CategoryCard key={cat} name={cat} value={profile[cat]} />
        ))}
      </div>
    </section>
  );
}
