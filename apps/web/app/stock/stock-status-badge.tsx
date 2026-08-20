import type { StockStatus } from '@/lib/actions/stock';

const LABEL: Record<StockStatus, string> = {
  in_stock: 'In Stock',
  low_stock: 'Low Stock',
  out_of_stock: 'Out of Stock',
};

const STYLE: Record<StockStatus, string> = {
  in_stock: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  low_stock: 'border-amber-200 bg-amber-50 text-amber-700',
  out_of_stock: 'border-red-200 bg-red-50 text-red-700',
};

export function StockStatusBadge({ status }: { status: StockStatus }) {
  return (
    <span className={'rounded-full border px-2 py-0.5 text-xs ' + STYLE[status]}>
      {LABEL[status]}
    </span>
  );
}
