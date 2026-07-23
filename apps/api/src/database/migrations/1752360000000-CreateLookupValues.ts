import { MigrationInterface, QueryRunner } from 'typeorm';

// Master lookup values for the searchable dropdowns (Layout 2 pallet entry, and
// future forms). New table + seed data; nothing existing depends on it.
export class CreateLookupValues1752360000000 implements MigrationInterface {
  name = 'CreateLookupValues1752360000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "lookup_values" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "category" character varying NOT NULL,
        "value" character varying NOT NULL,
        "parent_id" uuid,
        "active" boolean NOT NULL DEFAULT true,
        "sort_order" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_lookup_values" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_lookup_values_parent') THEN
          ALTER TABLE "lookup_values" ADD CONSTRAINT "FK_lookup_values_parent"
            FOREIGN KEY ("parent_id") REFERENCES "lookup_values"("id") ON DELETE CASCADE;
        END IF;
      END $$;
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_lookup_values_category" ON "lookup_values" ("category")`,
    );
    // Case-insensitive uniqueness per category (+ parent for dependent lists).
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_lookup_top" ON "lookup_values" ("category", lower("value")) WHERE "parent_id" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_lookup_child" ON "lookup_values" ("category", lower("value"), "parent_id") WHERE "parent_id" IS NOT NULL`,
    );

    // ---- Seed ----
    const seedTop = async (category: string, values: string[]) => {
      for (let i = 0; i < values.length; i++) {
        await queryRunner.query(
          `INSERT INTO "lookup_values" ("category","value","sort_order") VALUES ($1,$2,$3)
           ON CONFLICT DO NOTHING`,
          [category, values[i], i],
        );
      }
    };

    await seedTop('manufacturer', [
      'Dell', 'HP', 'Lenovo', 'Fujitsu', 'Acer', 'ASUS', 'Apple', 'Microsoft',
      'Toshiba', 'Dynabook', 'Samsung', 'MSI', 'Huawei', 'LG', 'Panasonic',
      'Intel NUC', 'Gigabyte', 'Shuttle', 'Zotac',
    ]);
    await seedTop('chassis', [
      'Tiny', 'Mini PC', 'SFF', 'Desktop', 'Mini Tower', 'Tower', 'All-in-One',
      'Laptop', 'Workstation', 'Rack Server',
    ]);
    await seedTop('cpu', [
      'Intel Core i3', 'Intel Core i5', 'Intel Core i7', 'Intel Core i9',
      'AMD Ryzen 3', 'AMD Ryzen 5', 'AMD Ryzen 7', 'AMD Ryzen 9',
      'Intel Xeon E3', 'Intel Xeon E5', 'Intel Xeon W',
    ]);
    await seedTop('ram', ['2 GB', '4 GB', '8 GB', '16 GB', '32 GB', '64 GB', '128 GB']);
    await seedTop('storage', [
      'None', '128 GB SSD', '256 GB SSD', '512 GB SSD', '1 TB SSD',
      '1 TB HDD', '2 TB HDD', '512 GB NVMe', '1 TB NVMe',
    ]);

    // Models, scoped to their manufacturer.
    const seedModels = async (manufacturer: string, models: string[]) => {
      for (let i = 0; i < models.length; i++) {
        await queryRunner.query(
          `INSERT INTO "lookup_values" ("category","value","parent_id","sort_order")
           SELECT 'model', $2, m.id, $3 FROM "lookup_values" m
           WHERE m.category = 'manufacturer' AND m.value = $1
           ON CONFLICT DO NOTHING`,
          [manufacturer, models[i], i],
        );
      }
    };
    await seedModels('Dell', [
      'OptiPlex 3050', 'OptiPlex 3060', 'OptiPlex 3070', 'OptiPlex 3080',
      'OptiPlex 5090', 'Latitude 5400', 'Latitude 5410', 'Latitude 5420',
      'Precision 3630',
    ]);
    await seedModels('HP', [
      'EliteDesk 800 G5', 'ProDesk 600 G5', 'EliteBook 840 G6', 'EliteDesk 800 G6',
    ]);
    await seedModels('Lenovo', [
      'ThinkCentre M720', 'ThinkCentre M920', 'ThinkPad T480', 'ThinkPad T490',
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "lookup_values"`);
  }
}
