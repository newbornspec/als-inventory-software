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

// Dark-surface palette (validated against the card surface #171717 with the
// dataviz six-checks script; CVD floor band mitigated by the legend + counts
// tables that always accompany the donut). Categorical slots in FIXED order.
const CATEGORICAL = [
  '#3987e5', // blue
  '#199e70', // aqua
  '#c98500', // yellow
  '#008300', // green
  '#9085e9', // violet
  '#e66767', // red
  '#d55181', // magenta
  '#d95926', // orange
];
const OTHER_GRAY = '#6b6a66';
const SINGLE_BLUE = '#3987e5';
const SINGLE_AQUA = '#199e70';
const INK_MUTED = '#898781';
const GRID = '#2c2c2a';
const SURFACE = '#171717';

const tooltipStyle = {
  backgroundColor: '#262626',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6,
  fontSize: 12,
  color: '#fff',
};

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
      <div className="h-52 w-52 shrink-0">
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
      <ul className="min-w-[10rem] flex-1 space-y-1 text-sm">
        {rows.map((r, i) => (
          <li key={r.label} className="flex items-center gap-2">
            <span
              className="h-3 w-3 shrink-0 rounded-sm"
              style={{
                backgroundColor:
                  r.label === 'Other' ? OTHER_GRAY : CATEGORICAL[i % CATEGORICAL.length],
              }}
            />
            <span className="flex-1 truncate text-neutral-300">{r.label}</span>
            <span className="tabular-nums text-neutral-400">{r.count}</span>
            <span className="w-12 text-right text-xs tabular-nums text-neutral-500">
              {total > 0 ? `${((r.count / total) * 100).toFixed(0)}%` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface MonthPoint {
  month: string; // 'YYYY-MM'
  revenue: number;
  profit: number;
  units: number;
}

// Two-series money trend over the rolling 12 months: Revenue (blue) and Profit
// (aqua). Both are £ on one axis (dataviz: never dual-axis). Legend is always
// present for two series; 2px lines, recessive grid, crosshair tooltip.
export function MonthlyTrend({ data }: { data: MonthPoint[] }) {
  const fmtMonth = (m: string) => {
    const [y, mo] = m.split('-');
    return new Date(Number(y), Number(mo) - 1, 1).toLocaleString('en-GB', { month: 'short' });
  };
  const gbp = (v: number) => `£${Number(v).toLocaleString('en-GB')}`;

  return (
    <div>
      <div className="mb-2 flex items-center gap-4 text-xs text-neutral-400">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-4 rounded-sm" style={{ backgroundColor: SINGLE_BLUE }} /> Revenue
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-4 rounded-sm" style={{ backgroundColor: SINGLE_AQUA }} /> Profit
        </span>
      </div>
      <div className="h-56">
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
              tickFormatter={(v) => (v >= 1000 ? `£${(v / 1000).toFixed(0)}k` : `£${v}`)}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              labelFormatter={(m) => {
                const [y, mo] = String(m).split('-');
                return new Date(Number(y), Number(mo) - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });
              }}
              formatter={(v, name) => [gbp(Number(v ?? 0)), name === 'revenue' ? 'Revenue' : 'Profit']}
            />
            <Line type="monotone" dataKey="revenue" stroke={SINGLE_BLUE} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="profit" stroke={SINGLE_AQUA} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
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
    <div style={{ height }}>
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
            width={130}
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
  );
}
