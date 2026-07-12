import type { StockStatus } from '@/lib/actions/stock';

const LABEL: Record<StockStatus, string> = {
  in_stock: 'In Stock',
  low_stock: 'Low Stock',
  out_of_stock: 'Out of Stock',
};

const STYLE: Record<StockStatus, string> = {
  in_stock: 'border-emerald-900 bg-emerald-950/40 text-emerald-300',
  low_stock: 'border-amber-900 bg-amber-950/40 text-amber-300',
  out_of_stock: 'border-red-900 bg-red-950/40 text-red-300',
};

export function StockStatusBadge({ status }: { status: StockStatus }) {
  return (
    <span className={'rounded-full border px-2 py-0.5 text-xs ' + STYLE[status]}>
      {LABEL[status]}
    </span>
  );
}
