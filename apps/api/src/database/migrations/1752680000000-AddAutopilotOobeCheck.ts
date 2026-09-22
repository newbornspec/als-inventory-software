import { MigrationInterface, QueryRunner } from 'typeorm';

// The one Autopilot answer that is not a guess.
//
// Autopilot registration lives in Microsoft's cloud against the device's
// hardware hash. No third party can query it - not the refurbisher, not the
// station, not anyone but the tenant that registered it. So every offline
// check the audit station makes is evidence, never proof, and a wiped disk
// carries no evidence at all.
//
// There is exactly one moment the truth appears for free: the first boot after
// imaging. A registered device reaches OOBE, asks the ZTD service, and is shown
// the OWNING ORGANISATION'S branded sign-in screen. Today a technician sees
// that and it goes nowhere - the station is not running at that point (it
// booted from the stick, and the machine has since rebooted into Windows), so
// the observation has to be recorded afterwards, by a person, against the
// asset.
//
// Hence a column of its own rather than a field inside hardware_profile: the
// profile is machine-captured and is REPLACED wholesale on every re-capture
// (see record_install in tools/gui/server.py), so a human finding stored in it
// would be destroyed by the next audit of the same machine.
//
// jsonb rather than columns, because this is one indivisible observation - what
// was seen, by whom, when - and it is read as a whole or not at all.
export class AddAutopilotOobeCheck1752680000000 implements MigrationInterface {
  name = 'AddAutopilotOobeCheck1752680000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "asset_audits"
      ADD COLUMN IF NOT EXISTS "autopilot_oobe" jsonb
    `);
    // The result word is constrained, because the whole value of this record is
    // that it distinguishes three states that must never blur into each other:
    //
    //   organisation  OOBE named an organisation. The device IS registered.
    //   generic       OOBE was Microsoft's own. No profile was served THAT DAY,
    //                 to THAT hardware hash - which is the strongest negative
    //                 obtainable, and still not a guarantee for all time.
    //   blocked       the check could not be made (no network at OOBE, machine
    //                 would not boot, imaging skipped). NOT a negative.
    //
    // A row with no autopilot_oobe at all means nobody has looked yet, which is
    // different again - and is the state every existing row is left in. There is
    // no backfill here and there must not be: inventing "generic" for machines
    // nobody checked would be exactly the false-clean answer this column exists
    // to prevent.
    await queryRunner.query(`
      ALTER TABLE "asset_audits"
      DROP CONSTRAINT IF EXISTS "CHK_asset_audits_autopilot_oobe_result"
    `);
    await queryRunner.query(`
      ALTER TABLE "asset_audits"
      ADD CONSTRAINT "CHK_asset_audits_autopilot_oobe_result"
      CHECK (
        "autopilot_oobe" IS NULL
        OR ("autopilot_oobe" ->> 'result') IN ('organisation', 'generic', 'blocked')
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "asset_audits"
      DROP CONSTRAINT IF EXISTS "CHK_asset_audits_autopilot_oobe_result"
    `);
    await queryRunner.query(`
      ALTER TABLE "asset_audits"
      DROP COLUMN IF EXISTS "autopilot_oobe"
    `);
  }
}
