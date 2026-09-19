import { randomUUID } from 'node:crypto';
import { In, type DataSource, type EntityManager } from 'typeorm';
import { Asset } from '../assets/asset.entity';
import { AssetAudit, DataWipeStatus } from '../assets/asset-audit.entity';
import {
  buildDeviceCertificate,
  certificateNumber,
} from '../assets/certificate-content';
import { latestWipe } from '../assets/certificate-eligibility';
import {
  expectedDrivesFromRows,
  rollupWipe,
  type WipeRollup,
} from '../devices/wipe-rollup';
import { storable } from './canonical-json';
import {
  canonicalBytes,
  sha256Hex,
  verifyChain,
  type CertificatePayload,
  type CertificateRecord,
  type CertificateSigner,
  type CertificateSummary,
  type Verdict,
} from './certificate-signing';
import { ErasureCertificate } from './erasure-certificate.entity';

// Issues, stores and checks signed erasure certificates (plan step 29).
//
// INERT without a key: with CERT_SIGNING_KEY unset `signer` is null,
// `enabled` is false, and nothing here reads or writes the table - the
// certificate route builds the PDF on every download exactly as before.
//
// With a key, a certificate is issued ONCE, when the machine first becomes
// certifiable (the per-drive roll-up says 'wiped') - at ingest, right after
// the wipe status settles - and, if that did not happen (signing switched on
// later, or the issue failed), on the first download. Every later download
// is drawn from the stored snapshot, so it keeps its number and issued date.
// A later wipe of the machine changes the set of wipe records the roll-up
// certifies, and that issues a NEW certificate with a new number; the old
// one stays as it was (the table refuses UPDATE and DELETE).
//
// THE CHAIN. Each certificate carries the hash of the one issued before it
// (any asset), so certificates form one line. Issuing takes a
// transaction-scoped advisory lock (pg_advisory_xact_lock) so two API
// instances can never both read the same chain head and fork it - the
// UNIQUE on prev_sha256 would refuse the second anyway, but as an error.

// Two int4 keys for pg_advisory_xact_lock: an app-wide namespace and this
// lock. Any other advisory lock in the app must use a different pair.
const LOCK_NAMESPACE = 0x414c53; // 'ALS'
const LOCK_CERT_CHAIN = 29;

// How long a certificate verified back to the start stays a checkpoint for
// later walks in this process. The table is insert-only, so a checkpoint
// only hides tampering by someone who disabled the trigger - and only for
// this long; the offline verifier and a restart always walk in full.
const CHECKPOINT_TTL_MS = 15 * 60 * 1000;
// Predecessors fetched per query while walking the chain.
const WALK_BATCH = 500;

const LEVEL_RANK = { none: 0, clear: 1, purge: 2 } as const;

// The public summary (owner decision D30): make, model, how many drives,
// and the weakest level any of them reached. Nothing that identifies a
// drive, a person or a customer.
export function summaryOf(
  cert: ReturnType<typeof buildDeviceCertificate>,
  rollup: WipeRollup<AssetAudit>,
): CertificateSummary {
  const device = Object.fromEntries(cert.device);
  const rows = rollup.drives.map((d) => d.row).filter((r) => !!r);
  let level: CertificateSummary['sanitisationLevel'] = rows.length
    ? 'purge'
    : null;
  for (const r of rows) {
    const l = r.sanitisationLevel as keyof typeof LEVEL_RANK | null;
    if (!l || !(l in LEVEL_RANK)) {
      level = null;
      break;
    }
    if (level && LEVEL_RANK[l] < LEVEL_RANK[level]) level = l;
  }
  return {
    make: device.Manufacturer?.trim() || null,
    model: device.Model?.trim() || null,
    driveCount: cert.drives.length,
    sanitisationLevel: level,
  };
}

type Inputs =
  | { certifiable: false }
  | {
      certifiable: true;
      asset: Asset;
      rollup: WipeRollup<AssetAudit>;
      certRow: AssetAudit;
      sources: string[];
    };

export class CertificateLedger {
  private checkpoints = new Map<string, number>();

  constructor(
    private readonly ds: DataSource,
    readonly signer: CertificateSigner | null,
  ) {}

  get enabled(): boolean {
    return this.signer !== null;
  }

  // The asset's current certificate - issuing it if the machine is
  // certifiable and its current wipe records have none yet. null when
  // signing is off or the machine is not certifiable.
  async ensure(assetId: string): Promise<ErasureCertificate | null> {
    if (!this.signer) return null;
    // Fast path, no lock: already issued for exactly these wipe records.
    const seen = await this.inputs(this.ds.manager, assetId);
    if (!seen.certifiable) return null;
    const have = await this.latestFor(this.ds.manager, assetId);
    if (have && sameSources(have, seen.sources)) return have;

    return this.ds.transaction(async (m) => {
      await m.query('SELECT pg_advisory_xact_lock($1, $2)', [
        LOCK_NAMESPACE,
        LOCK_CERT_CHAIN,
      ]);
      // Again under the lock: another request may have issued it meanwhile,
      // or a drive may have failed since.
      const now = await this.inputs(m, assetId);
      if (!now.certifiable) return null;
      const latest = await this.latestFor(m, assetId);
      if (latest && sameSources(latest, now.sources)) return latest;
      return this.issue(m, now);
    });
  }

  find(id: string): Promise<ErasureCertificate | null> {
    return this.ds.getRepository(ErasureCertificate).findOne({ where: { id } });
  }

  // Re-hash, check the signature and walk the chain back to the first
  // certificate, or to a checkpoint (a certificate this process verified
  // back to the start within CHECKPOINT_TTL_MS).
  async verify(id: string): Promise<Verdict> {
    if (!this.signer) return { valid: false, reason: 'signing is off' };
    const chain: CertificateRecord[] = [];
    let rows = await this.walk('id', id);
    for (;;) {
      if (!rows.length) break;
      chain.push(...rows);
      const last = rows[rows.length - 1];
      if (last.prevSha256 === null) break;
      // A checkpoint among the predecessors: no need to fetch further.
      if (chain.slice(1).some((r) => this.isCheckpoint(r.payloadSha256))) break;
      if (rows.length < WALK_BATCH) break; // predecessor missing
      rows = await this.walk('sha', last.prevSha256);
    }
    const verdict = verifyChain(chain, this.signer.verifyKeys, (h) =>
      this.isCheckpoint(h),
    );
    if (verdict.valid) {
      const until = Date.now() + CHECKPOINT_TTL_MS;
      for (const r of chain) this.checkpoints.set(r.payloadSha256, until);
    }
    return verdict;
  }

  private isCheckpoint(sha: string): boolean {
    const until = this.checkpoints.get(sha);
    if (until === undefined) return false;
    if (until < Date.now()) {
      this.checkpoints.delete(sha);
      return false;
    }
    return true;
  }

  // Up to WALK_BATCH certificates: the one named (by id, or by its stored
  // hash) and its predecessors in order, following prev_sha256.
  private async walk(
    by: 'id' | 'sha',
    key: string,
  ): Promise<CertificateRecord[]> {
    const rows: Array<Record<string, unknown>> = await this.ds.query(
      `WITH RECURSIVE chain AS (
         SELECT c.*, 1 AS depth FROM erasure_certificates c
         WHERE ${by === 'id' ? 'c.id = $1::uuid' : 'c.payload_sha256 = $1'}
         UNION ALL
         SELECT p.*, chain.depth + 1 FROM erasure_certificates p
         JOIN chain ON p.payload_sha256 = chain.prev_sha256
         WHERE chain.depth < $2
       )
       SELECT id, number, asset_id, payload, payload_sha256, prev_sha256,
              signature, key_id, issued_at
       FROM chain ORDER BY depth`,
      [key, WALK_BATCH],
    );
    return rows.map((r) => ({
      id: r.id as string,
      number: r.number as string,
      assetId: r.asset_id as string,
      payload: r.payload as CertificatePayload,
      payloadSha256: r.payload_sha256 as string,
      prevSha256: (r.prev_sha256 as string | null) ?? null,
      signature: r.signature as string,
      keyId: r.key_id as string,
      issuedAt: r.issued_at as Date,
    }));
  }

  private latestFor(
    m: EntityManager,
    assetId: string,
  ): Promise<ErasureCertificate | null> {
    return m.getRepository(ErasureCertificate).findOne({
      where: { assetId },
      order: { seq: 'DESC' },
    });
  }

  // What the certificate route reads, read the same way: the asset with its
  // profile, and every WIPED and FAILED record with the account that filed it.
  private async inputs(m: EntityManager, assetId: string): Promise<Inputs> {
    const asset = await m
      .getRepository(Asset)
      .createQueryBuilder('asset')
      .addSelect('asset.hardwareProfile')
      .where('asset.id = :id', { id: assetId })
      .getOne();
    if (!asset) return { certifiable: false };
    const rows = await m.getRepository(AssetAudit).find({
      where: {
        assetId,
        dataWipeStatus: In([DataWipeStatus.WIPED, DataWipeStatus.FAILED]),
      },
      order: { createdAt: 'DESC' },
      relations: ['auditedBy'],
    });
    const rollup = rollupWipe(rows, expectedDrivesFromRows(rows));
    if (rollup.verdict !== 'wiped') return { certifiable: false };
    const sources = rollup.drives
      .map((d) => (d.row ? wipeKey(d.row) : null))
      .filter((k): k is string => !!k)
      .sort();
    return {
      certifiable: true,
      asset,
      rollup,
      certRow: latestWipe(rows) as AssetAudit,
      sources,
    };
  }

  private async issue(
    m: EntityManager,
    inp: Extract<Inputs, { certifiable: true }>,
  ): Promise<ErasureCertificate> {
    const signer = this.signer!;
    const head: Array<{ payload_sha256: string }> = await m.query(
      'SELECT payload_sha256 FROM erasure_certificates ORDER BY seq DESC LIMIT 1',
    );
    const prevSha256 = head[0]?.payload_sha256 ?? null;

    const certificate = buildDeviceCertificate(
      inp.asset,
      inp.rollup,
      inp.certRow,
    );
    // The number the unsigned certificate always printed for this wipe, so
    // a customer holding an earlier download sees the same number. Unique
    // in the table: a same-day re-wipe gets -2, -3...
    const base = certificate.certNo;
    let number = base;
    for (let n = 2; ; n++) {
      const taken: unknown[] = await m.query(
        'SELECT 1 FROM erasure_certificates WHERE number = $1',
        [number],
      );
      if (!taken.length) break;
      number = `${base}-${n}`;
    }
    certificate.certNo = number;

    const id = randomUUID();
    const issuedAt = new Date();
    const payload = storable<CertificatePayload>({
      v: 1,
      id,
      number,
      assetId: inp.asset.id,
      issuedAt: issuedAt.toISOString(),
      prevSha256,
      keyId: signer.keyId,
      sources: inp.sources,
      certificate,
      summary: summaryOf(certificate, inp.rollup),
    });
    const bytes = canonicalBytes(payload);
    const row = m.getRepository(ErasureCertificate).create({
      id,
      number,
      assetId: inp.asset.id,
      payload,
      payloadSha256: sha256Hex(bytes),
      prevSha256,
      signature: signer.sign(bytes),
      keyId: signer.keyId,
      issuedAt,
    });
    await m.getRepository(ErasureCertificate).insert(row);
    return row;
  }
}

// What makes two wipe records the SAME erasure, for deciding whether the
// machine needs a new certificate: the drive as the record itself names it,
// the outcome and method, and when the station says it wiped. NOT the row
// id: ingest has no de-duplication, so a stick whose upload response was
// lost re-sends the identical wipe (its offline queue keeps the original
// wipedAt), a second row is filed, and keying on row ids issued a second
// certificate - a new "-2" number and issued date for one erasure, while the
// customer already held the first (review of step 29; D23 keeps a record's
// number stable). A genuine re-wipe always has a new wipedAt. The drive is
// taken from the row alone, not from the roll-up's key for it, because that
// key can change when an unrelated record of another drive arrives.
//
// Rows from sticks that predate wipedAt carry only the day the API received
// them, so they are keyed by that day - the same day the unsigned
// certificate number is made from (certificateNumber), which already gave a
// same-day duplicate the same number. Owner-reversible: a re-wipe by an old
// stick on the same day then keeps the day's certificate.
export function wipeKey(
  row: Pick<
    AssetAudit,
    | 'dataWipeStatus'
    | 'dataWipeMethod'
    | 'createdAt'
    | 'wipedAt'
    | 'wipedDriveSerial'
    | 'wipedDrive'
  >,
): string {
  const t = (v: unknown) =>
    typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
  const d = (row.wipedDrive ?? {}) as Record<string, unknown>;
  const drive = [
    t(row.wipedDriveSerial ?? d.serialNumber).toUpperCase(),
    t(d.wwn).toLowerCase(),
    t(d.model),
    t(d.sizeBytes),
    t(d.devicePath),
  ].join('/');
  const when = row.wipedAt
    ? `at:${new Date(row.wipedAt).toISOString()}`
    : `day:${certificateNumber('', row).slice(4, 12)}`;
  return [drive, t(row.dataWipeStatus), t(row.dataWipeMethod), when].join('|');
}

function sameSources(c: ErasureCertificate, sources: string[]): boolean {
  const had = Array.isArray(c.payload?.sources) ? c.payload.sources : [];
  return had.length === sources.length && had.every((s, i) => s === sources[i]);
}
