-- Remediation wave 2: which machines stop being certifiable when the per-drive
-- rule ships? Run this BEFORE pushing wave 2 (cross-check finding).
--
-- READ ONLY. One SELECT, inside a READ ONLY transaction, so Postgres itself
-- refuses any write. Paste the whole file into the Railway dashboard: project
-- loving-abundance -> the "postgres" database (the cube icon, NOT the old
-- "Postgres" elephant) -> Data -> Query. Or run it with psql against that
-- database. It prints asset tags, statuses and DRIVE serials only - no
-- customer data.
--
-- WHY. Wave 1 (840e824, deployed) sticks already file one record per drive,
-- naming the drive. Wave 2 judges those records per drive: every internal
-- drive listed in a hardware profile captured when the machine was wiped
-- must have a wipe, and each drive's LATEST record must be a wipe. A machine
-- that got a certificate yesterday because one of its two listed drives was
-- wiped is refused after the push ("Not every drive in this device has been
-- wiped"), and its lot certificate leaves it off. Nothing re-settles the
-- asset's own status: settling runs only when a new wipe is filed, so a
-- machine listed here with audit_status = data_wiped KEEPS saying data_wiped
-- while its certificate is refused, until it is wiped again.
--
-- WHAT EACH COLUMN MEANS
--   tag, stock_status, audit_status - the asset as it stands.
--   listed_drives   - internal drives with a serial in any wipe-time profile.
--   not_wiped       - of those, the serials with no wipe on record.
--   failed_last     - serials whose latest record (on the station's clock or
--                     the server's) is a FAILED wipe.
--   unserialled     - listed drives that report no serial: this query cannot
--                     match them, so a machine with any is worth a look by
--                     hand in the app (the asset page explains per drive).
-- Units still in stock can simply be wiped again with the station. Units
-- already sold with a certificate are the ones to decide about.
--
-- It is a close SQL copy of apps/api/src/devices/wipe-rollup.ts, checked
-- against it by apps/api/src/devices/wipe-rollup-sql.pg.spec.ts. Simplified:
-- drives are matched by serial only (not by WWN/model/size), and a legacy
-- record filed after the per-drive ones is not counted. The asset page and
-- GET /assets/:id/certificate-eligibility give the exact answer per machine.

BEGIN READ ONLY;

WITH outcome AS (
  SELECT w.id, w.asset_id, w.data_wipe_status, w.hardware_profile,
         w.wiped_drive, w.created_at,
         COALESCE(w.wiped_at, w.created_at) AS station_time,
         upper(COALESCE(NULLIF(btrim(w.wiped_drive_serial), ''),
                        NULLIF(btrim(w.wiped_drive->>'serialNumber'), ''))) AS serial,
         -- assets/manual-wipe.ts sourceOf: a recorded source wins; an older
         -- row with a hardware profile came from the station.
         CASE WHEN w.wipe_source IN ('station', 'manual')
              THEN w.wipe_source = 'manual'
              ELSE w.hardware_profile IS NULL END AS manual
    FROM asset_audits w
   WHERE w.data_wipe_status IN ('wiped', 'failed')
),
-- Station records that name their drive (serial or device path).
identified AS (
  SELECT * FROM outcome
   WHERE NOT manual
     AND (serial IS NOT NULL
          OR NULLIF(btrim(wiped_drive->>'devicePath'), '') IS NOT NULL)
),
machines AS (SELECT DISTINCT asset_id FROM identified),
-- A hand record newer than every station record, on both clocks, speaks for
-- the whole machine (wipe-rollup.ts); such machines are judged by it.
manual_covered AS (
  SELECT DISTINCT m.asset_id
    FROM outcome m JOIN machines USING (asset_id)
   WHERE m.manual
     AND NOT EXISTS (
       SELECT 1 FROM outcome s
        WHERE s.asset_id = m.asset_id AND NOT s.manual
          AND (s.station_time >= m.station_time OR s.created_at >= m.created_at))
),
-- The internal drives any wipe-time profile lists (expectedDrivesOf): not
-- USB, not removable, and not under 1 GB (eMMC boot partitions, zram).
profile_drive AS (
  SELECT i.asset_id, d
    FROM identified i
   CROSS JOIN LATERAL jsonb_array_elements(
     CASE WHEN jsonb_typeof(i.hardware_profile->'storage') = 'array'
          THEN i.hardware_profile->'storage' ELSE '[]'::jsonb END) d
   WHERE jsonb_typeof(d) = 'object'
     AND concat_ws(' ', d->>'interface', d->>'transport', d->>'type') !~* '\musb\M'
     AND COALESCE(d->>'removable', '') NOT IN ('true', '1')
     AND COALESCE(d->>'capacity', '') !~* '^\s*\d+(\.\d+)?\s*[KM]I?B?\s*$'
     AND COALESCE(d->>'capacity', '') !~* '^\s*0*(\.\d+)?\s*GI?B?\s*$'
),
listed AS (
  SELECT DISTINCT asset_id, upper(btrim(d->>'serialNumber')) AS serial
    FROM profile_drive
   WHERE NULLIF(btrim(d->>'serialNumber'), '') IS NOT NULL
),
unserialled AS (
  SELECT asset_id, count(*) AS n FROM (
    SELECT DISTINCT asset_id, d FROM profile_drive
     WHERE NULLIF(btrim(d->>'serialNumber'), '') IS NULL
       AND (NULLIF(btrim(d->>'model'), '') IS NOT NULL
            OR NULLIF(btrim(concat_ws(' ', d->>'interface', d->>'transport')), '') IS NOT NULL)
  ) u GROUP BY asset_id
),
-- Each drive's latest record on each clock; a FAILED one wins a tie.
latest_station AS (
  SELECT DISTINCT ON (asset_id, serial) asset_id, serial, data_wipe_status
    FROM identified WHERE serial IS NOT NULL
   ORDER BY asset_id, serial, station_time DESC, created_at DESC,
            (data_wipe_status = 'failed') DESC
),
latest_received AS (
  SELECT DISTINCT ON (asset_id, serial) asset_id, serial, data_wipe_status
    FROM identified WHERE serial IS NOT NULL
   ORDER BY asset_id, serial, created_at DESC, station_time DESC,
            (data_wipe_status = 'failed') DESC
),
wiped_now AS (
  SELECT s.asset_id, s.serial
    FROM latest_station s JOIN latest_received r USING (asset_id, serial)
   WHERE s.data_wipe_status = 'wiped' AND r.data_wipe_status = 'wiped'
),
failed_now AS (
  SELECT DISTINCT asset_id, serial FROM latest_station
  EXCEPT
  SELECT asset_id, serial FROM wiped_now
),
not_wiped AS (
  SELECT asset_id, serial FROM listed
  EXCEPT
  SELECT asset_id, serial FROM identified WHERE data_wipe_status = 'wiped' AND serial IS NOT NULL
)
SELECT a.tag,
       a.stock_status::text AS stock_status,
       a.audit_status::text AS audit_status,
       (SELECT count(*) FROM listed l WHERE l.asset_id = a.id) AS listed_drives,
       (SELECT string_agg(n.serial, ', ' ORDER BY n.serial)
          FROM not_wiped n WHERE n.asset_id = a.id) AS not_wiped,
       (SELECT string_agg(f.serial, ', ' ORDER BY f.serial)
          FROM failed_now f WHERE f.asset_id = a.id) AS failed_last,
       COALESCE((SELECT u.n FROM unserialled u WHERE u.asset_id = a.id), 0) AS unserialled
  FROM machines m JOIN assets a ON a.id = m.asset_id
 WHERE m.asset_id NOT IN (SELECT asset_id FROM manual_covered)
   AND (EXISTS (SELECT 1 FROM not_wiped n WHERE n.asset_id = m.asset_id)
        OR EXISTS (SELECT 1 FROM failed_now f WHERE f.asset_id = m.asset_id))
 ORDER BY (a.audit_status::text = 'data_wiped') DESC, a.stock_status, a.tag;

ROLLBACK;
