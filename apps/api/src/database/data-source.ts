import 'dotenv/config';
import { DataSource } from 'typeorm';
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

// Used by the TypeORM CLI for generating/running migrations.
// The running NestJS app configures its own connection via TypeOrmModule in app.module.ts.
export default new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USERNAME ?? 'als_inventory',
  password: process.env.DB_PASSWORD ?? 'als_inventory_dev',
  database: process.env.DB_NAME ?? 'als_inventory',
  entities: [User, Location, Asset, AssetHistory, AssetAudit, Batch, Lot, ExpectedLineItem, Product, Pallet, PalletLine],
  migrations: ['src/database/migrations/*.ts'],
  synchronize: false,
});
