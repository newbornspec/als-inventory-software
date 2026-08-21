import { MigrationInterface, QueryRunner } from 'typeorm';

// Backfill assets.audit_status from the audit trail.
//
// audit_status only. condition_grade is deliberately NOT backfilled: every path that
// writes an audit row already denormalizes the grade alongside it (ingest on both
// branches, AssetsService.createAudit, PowerSyncService.applyAuditSideEffects), so that
// half of the column never drifted and has nothing to repair. Writing it anyway would
// be an unmotivated write to a publication-replicated table, and it would resurrect a
// stale grade on any asset whose grade was deliberately cleared via PATCH /assets/:id.
//
// DevicesService.ingest() — the path behind the USB capture tool, the wipe-completion
// callback and the web "Add asset" form — filed asset_audits rows without ever
// denormalizing the outcome onto the asset. Everything that reads audit state off the
// asset rather than the trail therefore under-reported audited work: the dashboard's
// "Never audited" row, ReportsService.getOverview's awaitingAudit, the noAudit list
// filter and the per-lot audited counts. In production that was 35 of 38 assets with
// audit_status NULL against ~29 audit events in 30 days.
//
// Copying the newest asset_audits row would fix none of them: that path never wrote
// audit_status to the audit row either, so those rows are NULL too. This derives the
// same floor ingest() now derives going forward:
//
//   1. the newest non-null audit_status the asset ever recorded — deliberately not
//      "the newest row", since a later spec re-capture must not erase a graded audit
//      recorded earlier through the web form;
//   2. else data_wiped / data_wipe_failed if ANY row carries that wipe result — same
//      reasoning: a later plain re-capture must not erase wipe evidence;
//   3. else power_on if the tool ever actually ran on the machine. The capture tool
//      boots on the device itself, so a real capture is proof the unit powers on and
//      POSTs. A hardware_profile on the audit row is NOT sufficient evidence of that
//      on its own — the web "Add asset" form builds a profile out of typed fields and
//      posts it to the same endpoint. ingest() separates the two by dto.manual; in
//      the data that distinction survives only as the asset_history note it writes,
//      so that is what this reads.
//
// Hand-entered devices are therefore left NULL, which is correct — they were typed
// off a label, never tested.
//
// Fills blanks only (WHERE ... IS NULL), so it cannot overwrite a value a technician
// set and re-running is harmless. Data-only and additive: safe in either deploy order
// relative to the code change.
//
// One documented boundary: the UPDATE drives off asset_audits, so an asset carrying a
// capture history note but no audit row at all is left NULL. ingest() always writes
// both, so this cannot arise from the app — but a lot deletion CASCADEs the audit rows
// while the history rows go with the asset, so a hand-repaired database could show it.
export class BackfillAssetAuditStatus1752550000000 implements MigrationInterface {
  name = 'BackfillAssetAuditStatus1752550000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The trailing evidence filter is not redundant with the IS NULL guard: without
    // it, an asset whose audits establish nothing would be "updated" from NULL to
    // NULL. That is a no-op to Postgres but still a WAL record, and assets replicates
    // to every offline client through the powersync publication.
    await queryRunner.query(`
      WITH recorded AS (
        SELECT DISTINCT ON ("asset_id") "asset_id", "audit_status"
        FROM "asset_audits"
        WHERE "audit_status" IS NOT NULL
        ORDER BY "asset_id", "created_at" DESC, "id" DESC
      ),
      evidence AS (
        SELECT
          "asset_id",
          bool_or("data_wipe_status" = 'wiped')  AS wiped,
          bool_or("data_wipe_status" = 'failed') AS wipe_failed
        FROM "asset_audits"
        GROUP BY "asset_id"
      ),
      -- The capture tool physically ran on these. Note wording comes from ingest():
      -- 'Hardware audit captured into <lot>' for a real capture against 'Manually
      -- added to <lot>' for the form. An asset added by hand and later captured for
      -- real has both, and correctly counts as captured.
      captured AS (
        SELECT DISTINCT "asset_id"
        FROM "asset_history"
        -- The ::text cast is load-bearing — do not "simplify" it away. 'audited' is
        -- added to this enum by ALTER TYPE ... ADD VALUE in AddAuditEventTypes
        -- (1752033800000), and Postgres refuses to let a newly added label be used in
        -- the same transaction that added it: SQLSTATE 55P04, "New enum values must be
        -- committed before they can be used". TypeORM runs the whole chain in ONE
        -- transaction, so comparing this as an enum aborts the entire run and rolls
        -- back to empty on any from-scratch database — local dev, CI, a rebuilt
        -- Railway DB. Production survives only because the label was committed several
        -- deploys ago. Comparing as text never resolves the literal against the enum,
        -- so the check does not apply. Verified against Postgres 16: fails without the
        -- cast, passes with it.
        WHERE "event_type"::text = 'audited'
          AND "notes" LIKE 'Hardware audit captured into%'
      )
      UPDATE "assets" a
      SET "audit_status" = COALESCE(
            r."audit_status",
            CASE
              WHEN e.wiped               THEN 'data_wiped'
              WHEN e.wipe_failed         THEN 'data_wipe_failed'
              WHEN c."asset_id" IS NOT NULL THEN 'power_on'
            END::"assets_audit_status_enum"
          )
      FROM evidence e
      LEFT JOIN recorded r ON r."asset_id" = e."asset_id"
      LEFT JOIN captured c ON c."asset_id" = e."asset_id"
      WHERE a."id" = e."asset_id"
        AND a."audit_status" IS NULL
        AND (
          r."audit_status" IS NOT NULL
          OR e.wiped
          OR e.wipe_failed
          OR c."asset_id" IS NOT NULL
        )
    `);
  }

  // Deliberately a no-op. audit_status is a denormalized cache of the audit trail, and
  // the rows this filled were blank only because of the bug — there is no prior state
  // worth restoring, and nothing distinguishes a value this migration wrote from one a
  // technician has since set on top of it. Reverting would mean blanking real audit
  // results. The trail in asset_audits is untouched either way.
  public async down(): Promise<void> {
    /* no-op — see above */
  }
}
