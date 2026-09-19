-- Remediation step 13: how many erasure certificates already issued are affected?
--
-- READ ONLY. Every statement is a SELECT, and the transaction is opened
-- READ ONLY, so Postgres itself refuses any write even if something here were
-- wrong. Paste the whole file into the Railway dashboard: project
-- loving-abundance -> the "postgres" database (the cube icon, NOT the old
-- "Postgres" elephant) -> Data -> Query. Or run it with psql against that
-- database. It prints asset tags and stock status only - no customer data.
--
-- What each result means for the owner's decision (notify / re-wipe / destroy):
--   (a) discard     - a block discard (TRIM) was recorded as a wipe. TRIM is not
--                     an erase. These no longer produce a certificate (40fac73),
--                     but any certificate downloaded BEFORE that said
--                     "unrecoverable" about a drive that may still hold data.
--   (b) controller  - a firmware erase whose read-back FAILED, certified on the
--                     drive's own word ("controller-confirmed").
--   (c) mixed       - a machine with a failed wipe AND a wiped one. Before step 11
--                     its certificate listed every drive as wiped.
-- For each: units still in stock can simply be wiped again with the station.
-- Units already sold are the ones where a buyer may hold a wrong certificate.

BEGIN READ ONLY;

-- Totals, for scale.
SELECT count(*) AS wiped_rows,
       count(DISTINCT asset_id) AS wiped_assets,
       min(created_at) AS first_wipe, max(created_at) AS last_wipe
  FROM asset_audits WHERE data_wipe_status = 'wiped';

-- (a) TRIM / block discard recorded as a wipe.
SELECT a.tag, a.stock_status::text AS stock_status,
       count(*) AS matching_rows, max(w.created_at) AS last_match
  FROM asset_audits w JOIN assets a ON a.id = w.asset_id
 WHERE w.data_wipe_status = 'wiped'
   AND w.data_wipe_method ~* '(block discard|blkdiscard|\mtrim\M)'
 GROUP BY a.tag, a.stock_status
 ORDER BY a.stock_status, a.tag;

-- (b) "controller-confirmed": the read-back failed and the drive's word was taken.
SELECT a.tag, a.stock_status::text AS stock_status,
       count(*) AS matching_rows, max(w.created_at) AS last_match
  FROM asset_audits w JOIN assets a ON a.id = w.asset_id
 WHERE w.data_wipe_status = 'wiped'
   AND w.data_wipe_method ILIKE '%controller-confirmed%'
 GROUP BY a.tag, a.stock_status
 ORDER BY a.stock_status, a.tag;

-- (c) Mixed results: a failed wipe AND a wiped one on the same machine.
-- blocked_now = what step 11 does today (a failed row newer than the latest
-- wiped one, or within 24 h before it, withholds the certificate).
WITH latest AS (
  SELECT DISTINCT ON (asset_id) asset_id, created_at
    FROM asset_audits WHERE data_wipe_status = 'wiped'
   ORDER BY asset_id, created_at DESC)
SELECT a.tag, a.stock_status::text AS stock_status,
       (SELECT count(*) FROM asset_audits f
         WHERE f.asset_id = a.id AND f.data_wipe_status = 'failed') AS failed_rows,
       EXISTS (SELECT 1 FROM asset_audits f
                WHERE f.asset_id = a.id AND f.data_wipe_status = 'failed'
                  AND f.created_at > l.created_at - interval '24 hours') AS blocked_now,
       l.created_at AS latest_wiped
  FROM latest l JOIN assets a ON a.id = l.asset_id
 WHERE EXISTS (SELECT 1 FROM asset_audits f
                WHERE f.asset_id = l.asset_id AND f.data_wipe_status = 'failed')
 ORDER BY a.stock_status, a.tag;

-- Context: wipes recorded by hand (already labelled "manually recorded").
SELECT a.stock_status::text AS stock_status, count(*) AS manual_wiped_rows
  FROM asset_audits w JOIN assets a ON a.id = w.asset_id
 WHERE w.data_wipe_status = 'wiped' AND w.wipe_source = 'manual'
 GROUP BY a.stock_status ORDER BY 1;

ROLLBACK;
