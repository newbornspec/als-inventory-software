import 'dotenv/config';
import { DataSource } from 'typeorm';
import { ALL_ENTITIES } from './entities';

// Used by the TypeORM CLI for generating/running migrations.
// The running NestJS app configures its own connection via TypeOrmModule in app.module.ts.
export default new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USERNAME ?? 'als_inventory',
  password: process.env.DB_PASSWORD ?? 'als_inventory_dev',
  database: process.env.DB_NAME ?? 'als_inventory',
  entities: ALL_ENTITIES,
  migrations: ['src/database/migrations/*.ts'],
  synchronize: false,
});
