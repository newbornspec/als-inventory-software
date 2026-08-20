import { User } from '../users/user.entity';
import { Location } from '../locations/location.entity';
import { Asset } from '../assets/asset.entity';
import { AssetHistory } from '../assets/asset-history.entity';
import { AssetAudit } from '../assets/asset-audit.entity';
import { Batch } from '../batches/batch.entity';
import { Lot } from '../batches/lot.entity';
import { ExpectedLineItem } from '../batches/expected-line-item.entity';
import { Product } from '../products/product.entity';
import { Pallet } from '../pallets/pallet.entity';
import { PalletLine } from '../pallets/pallet-line.entity';
import { PalletSoldLine } from '../pallets/pallet-sold-line.entity';
import { PalletMerge } from '../pallets/pallet-merge.entity';
import { StockLine } from '../stock/stock-line.entity';
import { StockMovement } from '../stock/stock-movement.entity';
import { Customer } from '../customers/customer.entity';
import { SalesOrder } from '../sales/sales-order.entity';
import { OrderLine } from '../sales/order-line.entity';
import { AssetPhoto } from '../photos/asset-photo.entity';
import { ActivityLog } from '../activity/activity-log.entity';
import { LookupValue } from '../lookups/lookup-value.entity';
import { Invoice } from '../invoices/invoice.entity';

// EVERY entity, in ONE place.
//
// There used to be two hand-maintained lists — the runtime connection in
// app.module.ts and the CLI datasource used to generate and run migrations —
// and nothing kept them in step. They had already drifted apart before anyone
// noticed: the runtime list was missing PalletMerge, and the CLI list was
// missing LookupValue and Invoice.
//
// The runtime omission is the dangerous one, and it fails in a way that is
// almost designed to slip through: TypeORM's getRepository() does NOT resolve
// metadata, so Nest injects the repository and the app boots perfectly. The
// error only surfaces on the first QUERY against that entity —
// EntityMetadataNotFoundError, at runtime, on one endpoint. Registering the
// entity with TypeOrmModule.forFeature is not enough and gives false comfort.
//
// entities.spec.ts asserts this list against the *.entity.ts files on disk, so
// adding an entity and forgetting this file fails the build instead of one
// page in production.
export const ALL_ENTITIES = [
  User,
  Location,
  Asset,
  AssetHistory,
  AssetAudit,
  Batch,
  Lot,
  ExpectedLineItem,
  Product,
  Pallet,
  PalletLine,
  PalletSoldLine,
  PalletMerge,
  StockLine,
  StockMovement,
  Customer,
  SalesOrder,
  OrderLine,
  AssetPhoto,
  ActivityLog,
  LookupValue,
  Invoice,
];
