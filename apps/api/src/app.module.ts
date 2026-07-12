import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import configuration from './config/configuration';
import { User } from './users/user.entity';
import { Location } from './locations/location.entity';
import { Asset } from './assets/asset.entity';
import { AssetHistory } from './assets/asset-history.entity';
import { AssetAudit } from './assets/asset-audit.entity';
import { Batch } from './batches/batch.entity';
import { Lot } from './batches/lot.entity';
import { ExpectedLineItem } from './batches/expected-line-item.entity';
import { Product } from './products/product.entity';
import { Pallet } from './pallets/pallet.entity';
import { PalletLine } from './pallets/pallet-line.entity';
import { StockLine } from './stock/stock-line.entity';
import { StockMovement } from './stock/stock-movement.entity';
import { Customer } from './customers/customer.entity';
import { SalesOrder } from './sales/sales-order.entity';
import { OrderLine } from './sales/order-line.entity';
import { RepairLog } from './repairs/repair-log.entity';
import { AssetPhoto } from './photos/asset-photo.entity';
import { AuthModule } from './auth/auth.module';
import { PowerSyncModule } from './powersync/powersync.module';
import { AssetsModule } from './assets/assets.module';
import { LocationsModule } from './locations/locations.module';
import { ReportsModule } from './reports/reports.module';
import { UsersModule } from './users/users.module';
import { BatchesModule } from './batches/batches.module';
import { ProductsModule } from './products/products.module';
import { PalletsModule } from './pallets/pallets.module';
import { StockModule } from './stock/stock.module';
import { CustomersModule } from './customers/customers.module';
import { SalesModule } from './sales/sales.module';
import { RepairsModule } from './repairs/repairs.module';
import { PhotosModule } from './photos/photos.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get('database.host'),
        port: config.get('database.port'),
        username: config.get('database.username'),
        password: config.get('database.password'),
        database: config.get('database.name'),
        entities: [User, Location, Asset, AssetHistory, AssetAudit, Batch, Lot, ExpectedLineItem, Product, Pallet, PalletLine, StockLine, StockMovement, Customer, SalesOrder, OrderLine, RepairLog, AssetPhoto],
        // Migrations only — never let the app auto-mutate the schema.
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature([User, Location, Asset, AssetHistory]),
    AuthModule,
    PowerSyncModule,
    AssetsModule,
    LocationsModule,
    ReportsModule,
    UsersModule,
    BatchesModule,
    ProductsModule,
    PalletsModule,
    StockModule,
    CustomersModule,
    SalesModule,
    RepairsModule,
    PhotosModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
