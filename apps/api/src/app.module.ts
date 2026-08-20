import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import configuration from './config/configuration';
import { ALL_ENTITIES } from './database/entities';
import { User } from './users/user.entity';
import { Location } from './locations/location.entity';
import { Asset } from './assets/asset.entity';
import { AssetHistory } from './assets/asset-history.entity';
import { AuthModule } from './auth/auth.module';
import { ActivityModule } from './activity/activity.module';
import { LookupsModule } from './lookups/lookups.module';
import { PowerSyncModule } from './powersync/powersync.module';
import { AssetsModule } from './assets/assets.module';
import { LocationsModule } from './locations/locations.module';
import { ReportsModule } from './reports/reports.module';
import { UsersModule } from './users/users.module';
import { BatchesModule } from './batches/batches.module';
import { ProductsModule } from './products/products.module';
import { PalletsModule } from './pallets/pallets.module';
import { InvoicesModule } from './invoices/invoices.module';
import { StockModule } from './stock/stock.module';
import { CustomersModule } from './customers/customers.module';
import { SalesModule } from './sales/sales.module';
import { PhotosModule } from './photos/photos.module';
import { DevicesModule } from './devices/devices.module';
import { DashboardModule } from './dashboard/dashboard.module';

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
        entities: ALL_ENTITIES,
        // Migrations only — never let the app auto-mutate the schema.
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature([User, Location, Asset, AssetHistory]),
    AuthModule,
    ActivityModule,
    LookupsModule,
    PowerSyncModule,
    AssetsModule,
    LocationsModule,
    ReportsModule,
    DashboardModule,
    UsersModule,
    BatchesModule,
    ProductsModule,
    PalletsModule,
    InvoicesModule,
    StockModule,
    CustomersModule,
    SalesModule,
    PhotosModule,
    DevicesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
