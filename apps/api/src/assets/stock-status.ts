import { AssetStockStatus } from './asset.entity';

// The one place the app decides what a stock status MEANS.
//
// These three lists answer "is this device still ours, and can we sell it?".
// They used to live inside dashboard.service.ts, which meant the dashboard
// could count one set while the list it linked to filtered another — and it
// did: the "In stock" tile counted all of AVAILABLE while its link asked for
// stock_status = 'in_stock' alone. Keeping the definition here, with both the
// dashboard and the assets register importing it, is what stops that drifting
// apart again.
//
// Worth knowing when reading these: 'in_stock' is NOT the ordinary state of
// held stock. The column defaults to 'received', the audit ingest writes
// 'audited', and the only production path that ever writes 'in_stock' is an
// admin undoing a sale (AssetsService.returnFromSold). So a filter on
// 'in_stock' alone finds almost nothing in a real warehouse, which is exactly
// why the dashboard link was wrong.

// Gone: no longer inventory we hold.
export const GONE = [
  AssetStockStatus.SOLD,
  AssetStockStatus.SHIPPED,
  AssetStockStatus.DISPOSED,
] as const;

// On the shelf and free to allocate.
export const AVAILABLE = [
  AssetStockStatus.IN_STOCK,
  AssetStockStatus.RECEIVED,
  AssetStockStatus.AUDITED,
  AssetStockStatus.AWAITING_AUDIT,
  AssetStockStatus.RETURNED,
] as const;

// Spoken for but still on site.
export const COMMITTED = [
  AssetStockStatus.ALLOCATED,
  AssetStockStatus.PICKED,
  AssetStockStatus.PACKED,
] as const;

// The lists are `as const` so their members stay literal for anything that
// needs the exact union; this keeps the one widening cast in a single place
// rather than at each call site.
export const isAvailable = (status: AssetStockStatus): boolean =>
  (AVAILABLE as readonly AssetStockStatus[]).includes(status);
