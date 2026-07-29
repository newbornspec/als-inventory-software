import { MigrationInterface, QueryRunner } from 'typeorm';

// Backfill the spec normalisation rules over data already captured.
//
// RAM: the audit tool read /proc/meminfo, which reports memory the OS can use —
// installed capacity minus what the firmware reserved for integrated graphics.
// That put 7, 15 and 31 GB on real rows (41% of audited units at the time of
// writing), none of which is a capacity you can buy. Round up to the nearest
// even GB, keeping the original reading in hardware_profile.memory.detectedGb.
//
// Screen size: only devices with a built-in panel should carry one, and the
// values that exist are inconsistently formatted ('14"' vs '13.3'). Sizes are
// cleared only for chassis types KNOWN to have no panel — a real Latitude 7490 in
// the data has device_type NULL and category 'Laptop', so treating unknown as
// desktop would delete its correct 14".
//
// No schema change — asset_audits.screen_size and .ram_gb already exist, so this
// is data-only and additive. Kept idempotent so a re-run is harmless.
export class StandardiseRamAndScreenSize1752440000000 implements MigrationInterface {
  name = 'StandardiseRamAndScreenSize1752440000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- RAM: flat audit column ----
    await queryRunner.query(`
      UPDATE "asset_audits"
      SET "ram_gb" = CEIL("ram_gb"::numeric / 2) * 2
      WHERE "ram_gb" IS NOT NULL
        AND "ram_gb" > 0
        AND "ram_gb" % 2 = 1
    `);

    // ---- RAM: inside the hardware_profile JSON on both tables ----
    // detectedGb is written first so the raw reading survives; the WHERE clause
    // means rows that were already even are left completely untouched.
    for (const table of ['assets', 'asset_audits']) {
      await queryRunner.query(`
        UPDATE "${table}"
        SET "hardware_profile" = jsonb_set(
              jsonb_set(
                "hardware_profile",
                '{memory,detectedGb}',
                "hardware_profile" -> 'memory' -> 'totalGb'
              ),
              '{memory,totalGb}',
              to_jsonb((CEIL((("hardware_profile" -> 'memory' ->> 'totalGb')::numeric) / 2) * 2)::int)
            )
        WHERE "hardware_profile" -> 'memory' ->> 'totalGb' ~ '^[0-9]+(\\.[0-9]+)?$'
          AND (("hardware_profile" -> 'memory' ->> 'totalGb')::numeric) > 0
          AND (CEIL((("hardware_profile" -> 'memory' ->> 'totalGb')::numeric) / 2) * 2)
              <> (("hardware_profile" -> 'memory' ->> 'totalGb')::numeric)
      `);
    }

    // ---- Screen size: add the missing inch mark on a bare number ----
    await queryRunner.query(`
      UPDATE "asset_audits"
      SET "screen_size" = "screen_size" || '"'
      WHERE "screen_size" ~ '^[0-9]+(\\.[0-9]+)?$'
    `);
    for (const table of ['assets', 'asset_audits']) {
      await queryRunner.query(`
        UPDATE "${table}"
        SET "hardware_profile" = jsonb_set(
              "hardware_profile",
              '{display,size}',
              to_jsonb(("hardware_profile" -> 'display' ->> 'size') || '"')
            )
        WHERE "hardware_profile" -> 'display' ->> 'size' ~ '^[0-9]+(\\.[0-9]+)?$'
      `);
    }

    // ---- Screen size: clear it on anything without a built-in panel ----
    // asset_audits has no device_type of its own, so it joins through to the asset.
    await queryRunner.query(`
      UPDATE "asset_audits" AS aa
      SET "screen_size" = NULL
      FROM "assets" AS a
      WHERE aa."asset_id" = a."id"
        AND aa."screen_size" IS NOT NULL
        AND LOWER(COALESCE(a."device_type", a."hardware_profile" -> 'identification' ->> 'deviceType', a."category", ''))
            IN ('desktop', 'tower', 'sff', 'small form factor', 'micro', 'mini',
                 'mini pc', 'server', 'workstation', 'thin client', 'blade', 'rack', 'node')
    `);
    await queryRunner.query(`
      UPDATE "assets"
      SET "hardware_profile" = jsonb_set(
            "hardware_profile",
            '{display}',
            ("hardware_profile" -> 'display') - 'size'
          )
      WHERE "hardware_profile" -> 'display' ? 'size'
        AND LOWER(COALESCE("device_type", "hardware_profile" -> 'identification' ->> 'deviceType', "category", ''))
            IN ('desktop', 'tower', 'sff', 'small form factor', 'micro', 'mini',
                 'mini pc', 'server', 'workstation', 'thin client', 'blade', 'rack', 'node')
    `);
    await queryRunner.query(`
      UPDATE "asset_audits" AS aa
      SET "hardware_profile" = jsonb_set(
            aa."hardware_profile",
            '{display}',
            (aa."hardware_profile" -> 'display') - 'size'
          )
      FROM "assets" AS a
      WHERE aa."asset_id" = a."id"
        AND aa."hardware_profile" -> 'display' ? 'size'
        AND LOWER(COALESCE(a."device_type", a."hardware_profile" -> 'identification' ->> 'deviceType', a."category", ''))
            IN ('desktop', 'tower', 'sff', 'small form factor', 'micro', 'mini',
                 'mini pc', 'server', 'workstation', 'thin client', 'blade', 'rack', 'node')
    `);
  }

  // The pre-standardisation RAM figure is recoverable from memory.detectedGb where
  // one was written; the flat ram_gb column is restored from it. Screen sizes that
  // were cleared are not restored — they were mis-detected data on desktops, and
  // reintroducing them would undo the point of the migration.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "asset_audits" AS aa
      SET "ram_gb" = (aa."hardware_profile" -> 'memory' ->> 'detectedGb')::int
      WHERE aa."hardware_profile" -> 'memory' ->> 'detectedGb' ~ '^[0-9]+$'
    `);
    for (const table of ['assets', 'asset_audits']) {
      await queryRunner.query(`
        UPDATE "${table}"
        SET "hardware_profile" = jsonb_set(
              "hardware_profile",
              '{memory,totalGb}',
              "hardware_profile" -> 'memory' -> 'detectedGb'
            ) #- '{memory,detectedGb}'
        WHERE "hardware_profile" -> 'memory' ? 'detectedGb'
      `);
    }
  }
}
