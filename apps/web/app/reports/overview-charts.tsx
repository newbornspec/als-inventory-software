'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

// Light-surface palette. Re-validated when the app moved from the dark theme:
// the previous steps were tuned for the #171717 card and failed the
// normal-vision floor on white (magenta vs red, ΔE 7.8). These are the
// light-mode steps, all six checks passing — worst adjacent CVD ΔE 9.1,
// worst adjacent normal-vision ΔE 19.6. Categorical slots in FIXED order:
// assigned by position, never cycled, never reordered by rank.
const CATEGORICAL = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
];
// Aqua, yellow and magenta sit below 3:1 on white — the relief rule applies,
// which the legend rows and counts tables beside every chart already satisfy.
const OTHER_GRAY = '#8a8a85';
const SINGLE_BLUE = '#2a78d6';
const SINGLE_AQUA = '#1baf7a';
const INK_MUTED = '#52514e';
const GRID = '#e5e5e5';
const SURFACE = '#ffffff';

const tooltipStyle = {
  backgroundColor: '#ffffff',
  border: '1px solid #e5e5e5',
  borderRadius: 6,
  fontSize: 12,
  color: '#0b0b0b',
  boxShadow: '0 8px 24px rgba(15,23,42,0.08)',
};

// --- Accessible equivalent for every chart ----------------------------------
// recharts renders an SVG with role="application" and no accessible name: it is
// a keyboard focus stop that announces nothing, and every value in it is
// reachable only by hovering a tooltip with a mouse. So each chart is marked
// aria-hidden and paired with the same numbers as a real table, collapsed
// behind a "View data" disclosure so the visual design is unchanged.
function ChartData({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: (string | number)[][];
}) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs font-medium text-neutral-700">View data</summary>
      <div role="region" aria-label={caption} tabIndex={0} className="mt-2 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">{caption}</caption>
          <thead className="text-neutral-600">
            <tr>
              {columns.map((c) => (
                <th key={c} scope="col" className="py-1 pr-4 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-neutral-200">
                {r.map((cell, j) => (
                  <td key={j} className="py-1 pr-4 tabular-nums">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export interface LabelCount {
  label: string;
  count: number;
}

// Donut for identity+share (e.g. inventory by category). Slices carry a 2px
// surface gap; identity is doubled by the legend rows next to it (never
// color alone). Rows beyond the 7th fold into "Other".
export function CategoryDonut({ data }: { data: LabelCount[] }) {
  const top = data.slice(0, 7);
  const rest = data.slice(7);
  const rows = [
    ...top,
    ...(rest.length > 0
      ? [{ label: 'Other', count: rest.reduce((s, r) => s + r.count, 0) }]
      : []),
  ];
  const total = rows.reduce((s, r) => s + r.count, 0);

  return (
    <div className="flex flex-wrap items-center gap-4">
      <div aria-hidden="true" className="h-52 w-52 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={rows}
              dataKey="count"
              nameKey="label"
              innerRadius="62%"
              outerRadius="100%"
              stroke={SURFACE}
              strokeWidth={2}
              isAnimationActive={false}
            >
              {rows.map((r, i) => (
                <Cell
                  key={r.label}
                  fill={r.label === 'Other' ? OTHER_GRAY : CATEGORICAL[i % CATEGORICAL.length]}
                />
              ))}
            </Pie>
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => [String(v ?? 0), 'units']} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      {/* The legend beside the donut already carries every label, count and
          share as text, so this chart needs no separate data table. */}
      <ul className="min-w-0 basis-full space-y-1 text-sm sm:flex-1 sm:basis-0">
        {rows.map((r, i) => (
          <li key={r.label} className="flex items-center gap-2">
            <span
              className="h-3 w-3 shrink-0 rounded-sm"
              style={{
                backgroundColor:
                  r.label === 'Other' ? OTHER_GRAY : CATEGORICAL[i % CATEGORICAL.length],
              }}
            />
            <span className="min-w-0 flex-1 truncate text-neutral-700">{r.label}</span>
            <span className="shrink-0 tabular-nums text-neutral-600">{r.count}</span>
            <span className="w-10 shrink-0 text-right text-xs tabular-nums text-neutral-600">
              {total > 0 ? `${((r.count / total) * 100).toFixed(0)}%` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface DayPoint {
  date: string; // 'YYYY-MM-DD'
  count: number;
}

// Vertical bars, one per day — the warehouse throughput pulse. Single blue
// series (magnitude only), thin bars with a rounded top, recessive grid.
// Only every Nth date is labelled so a 30-day axis stays legible.
export function DailyBars({ data }: { data: DayPoint[] }) {
  const step = Math.max(1, Math.ceil(data.length / 8));
  const fmt = (d: string, i: number) => {
    if (i % step !== 0) return '';
    const [, mo, day] = d.split('-');
    return `${day}/${mo}`;
  };
  return (
    <div>
      <div aria-hidden="true" className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ left: 4, right: 8, top: 4, bottom: 4 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={fmt}
            interval={0}
            stroke={GRID}
            tick={{ fill: INK_MUTED, fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: GRID }}
          />
          <YAxis
            stroke={GRID}
            tick={{ fill: INK_MUTED, fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: GRID }}
            width={28}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            cursor={{ fill: 'rgba(255,255,255,0.04)' }}
            labelFormatter={(d) => new Date(String(d)).toLocaleDateString('en-GB')}
            formatter={(v) => [String(v ?? 0), 'events']}
          />
          <Bar dataKey="count" fill={SINGLE_BLUE} radius={[3, 3, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
      </div>
      <ChartData
        caption="Units per day"
        columns={['Date', 'Units']}
        rows={data.map((d) => [d.date, d.count])}
      />
    </div>
  );
}

export interface MonthPoint {
  month: string; // 'YYYY-MM'
  [k: string]: number | string;
}

const ACCENT = { blue: SINGLE_BLUE, aqua: SINGLE_AQUA } as const;

// Configurable two-series monthly trend over the rolling 12 months. Both series
// share one axis (dataviz: never dual-axis, so both must be the same measure —
// two £ series, or two count series). Legend always present; 2px lines,
// recessive grid, crosshair tooltip.
export function MonthlyTrend({
  data,
  series,
  format = 'gbp',
  unitLabel = '',
}: {
  data: MonthPoint[];
  series: { key: string; label: string; color: 'blue' | 'aqua' }[];
  format?: 'gbp' | 'count';
  unitLabel?: string;
}) {
  const fmtMonth = (m: string) => {
    const [y, mo] = m.split('-');
    return new Date(Number(y), Number(mo) - 1, 1).toLocaleString('en-GB', { month: 'short' });
  };
  const fmtVal = (v: number) =>
    format === 'gbp' ? `£${Number(v).toLocaleString('en-GB')}` : `${Number(v).toLocaleString('en-GB')}${unitLabel ? ' ' + unitLabel : ''}`;
  const fmtAxis = (v: number) =>
    format === 'gbp'
      ? v >= 1000 ? `£${(v / 1000).toFixed(0)}k` : `£${v}`
      : v >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`;
  const labelByKey = new Map(series.map((s) => [s.key, s.label]));

  return (
    <div>
      <div className="mb-2 flex items-center gap-4 text-xs text-neutral-500">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-4 rounded-sm" style={{ backgroundColor: ACCENT[s.color] }} />
            {s.label}
          </span>
        ))}
      </div>
      <div aria-hidden="true" className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis
              dataKey="month"
              tickFormatter={fmtMonth}
              stroke={GRID}
              tick={{ fill: INK_MUTED, fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: GRID }}
            />
            <YAxis
              stroke={GRID}
              tick={{ fill: INK_MUTED, fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: GRID }}
              width={54}
              tickFormatter={(v) => fmtAxis(Number(v))}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              labelFormatter={(m) => {
                const [y, mo] = String(m).split('-');
                return new Date(Number(y), Number(mo) - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });
              }}
              formatter={(v, name) => [fmtVal(Number(v ?? 0)), labelByKey.get(String(name)) ?? String(name)]}
            />
            {series.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                stroke={ACCENT[s.color]}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ChartData
        caption="Monthly trend"
        columns={['Month', ...series.map((sr) => sr.label)]}
        rows={data.map((d) => [
          fmtMonth(String(d.month)),
          ...series.map((sr) => fmtVal(Number(d[sr.key] ?? 0))),
        ])}
      />
    </div>
  );
}

// Horizontal bars for one measure across categories — a single hue (identity
// lives in the row labels, so multicolored bars would be noise). Thin marks,
// 4px rounded data end, recessive grid.
export function CountBars({
  data,
  color = 'blue',
  max = 10,
}: {
  data: LabelCount[];
  color?: 'blue' | 'aqua';
  max?: number;
}) {
  const rows = data.slice(0, max);
  const fill = color === 'aqua' ? SINGLE_AQUA : SINGLE_BLUE;
  const height = Math.max(120, rows.length * 30 + 24);

  return (
    <div>
      <div aria-hidden="true" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
          <XAxis
            type="number"
            stroke={GRID}
            tick={{ fill: INK_MUTED, fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: GRID }}
            allowDecimals={false}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={96}
            stroke={GRID}
            tick={{ fill: INK_MUTED, fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: GRID }}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            cursor={{ fill: 'rgba(255,255,255,0.04)' }}
            formatter={(v) => [String(v ?? 0), 'units']}
          />
          <Bar
            dataKey="count"
            fill={fill}
            barSize={16}
            radius={[0, 4, 4, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
      </div>
      <ChartData
        caption="Units by category"
        columns={['Category', 'Units']}
        rows={rows.map((r) => [r.label, r.count])}
      />
    </div>
  );
}
