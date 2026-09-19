import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
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
  verifyRecord,
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

// THE PUBLIC CHECK walks the chain, and anyone can ask for it, so the walk
// is bounded (review of step 30: with 10,000 certificates a full walk is
// about 7 s of synchronous crypto, and every request did its own, holding
// the whole chain in memory). Now:
//   - The chain is walked in seq order, WALK_BATCH certificates per query,
//     handing the event loop back between batches and holding one batch in
//     memory at a time.
//   - What a walk proved is kept: the highest seq verified back to the
//     first certificate (the checkpoint), or the first seq that failed. A
//     check of a certificate at or below the checkpoint reads that one row
//     and checks it in full; a newer certificate extends the walk from the
//     checkpoint, not from the start.
//   - One walk at a time per process: concurrent checks wait for the walk
//     already running instead of starting their own.
//   - Every CHAIN_RECHECK_MS the chain is walked again from the start, in
//     the background, while checks keep answering from the last result. The
//     table is insert-only, so this only matters if someone disabled the
//     trigger and edited an old row; the offline verifier and a restart
//     always start from scratch.
const CHAIN_RECHECK_MS = 15 * 60 * 1000;
// Certificates fetched and verified per step of a walk (~0.7 ms each).
const WALK_BATCH = 100;

// What the last walk proved.
interface ChainState {
  // Every certificate up to this seq verifies and links back to the first
  // (0: none yet), and the payload hash of that last one.
  throughSeq: number;
  throughSha: string | null;
  // The first certificate that did not verify or link; every certificate
  // from it on is invalid.
  broken: { seq: number; reason: string } | null;
  // When the last walk that started from the first certificate began.
  fullWalkAt: number;
}

type StoredRecord = CertificateRecord & { seq: number };

const RECORD_COLUMNS = `id, seq, number, asset_id, payload, payload_sha256,
  prev_sha256, signature, key_id, issued_at`;

function recordOf(r: Record<string, unknown>): StoredRecord {
  return {
    id: r.id as string,
    seq: Number(r.seq),
    number: r.number as string,
    assetId: r.asset_id as string,
    payload: r.payload as CertificatePayload,
    payloadSha256: r.payload_sha256 as string,
    prevSha256: (r.prev_sha256 as string | null) ?? null,
    signature: r.signature as string,
    keyId: r.key_id as string,
    issuedAt: r.issued_at as Date,
  };
}

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
  private readonly log = new Logger(CertificateLedger.name);
  private chain: ChainState | null = null;
  private walking: Promise<void> | null = null;

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

  // Is this certificate genuine and unaltered, with every certificate before
  // it? The certificate itself is re-hashed and its signature checked on
  // every call; the ones before it are covered by the chain walk (see
  // CHAIN_RECHECK_MS above). Pass the row when the caller already has it,
  // to save reading it again.
  async verify(target: string | ErasureCertificate): Promise<Verdict> {
    if (!this.signer) return { valid: false, reason: 'signing is off' };
    const rec =
      typeof target === 'string'
        ? await this.one(target)
        : { ...target, seq: Number(target.seq) };
    if (!rec) return { valid: false, reason: 'not found' };
    const own = verifyRecord(rec, this.signer.verifyKeys);
    if (!own.valid) return own;
    const chain = await this.chainThrough(rec.seq);
    if (chain.broken && rec.seq >= chain.broken.seq)
      return {
        valid: false,
        reason:
          rec.seq === chain.broken.seq
            ? chain.broken.reason
            : `an earlier certificate: ${chain.broken.reason}`,
      };
    if (rec.seq > chain.throughSeq)
      return { valid: false, reason: 'chain is broken' };
    return { valid: true };
  }

  // The chain state once it covers `seq` - verified through it, or broken
  // at or before it - walking only as far as needed, one walk at a time.
  private async chainThrough(seq: number): Promise<ChainState> {
    for (let attempt = 0; ; attempt++) {
      const s = this.chain;
      const covers =
        !!s && (s.throughSeq >= seq || (!!s.broken && s.broken.seq <= seq));
      const fresh = !!s && Date.now() - s.fullWalkAt < CHAIN_RECHECK_MS;
      if (s && covers) {
        // Answer from what was proved; start the re-check from the first
        // certificate in the background when it is due.
        if (!fresh && !this.walking)
          this.walk(true).catch((e: Error) =>
            this.log.error(`certificate chain re-check failed: ${e.message}`),
          );
        return s;
      }
      // A certificate newer than the checkpoint is missing from a walk only
      // if it was issued while that walk ran, and the next walk reaches it.
      // Give up rather than loop if even that does not.
      if (s && attempt >= 3) return s;
      await this.walk(!s || !fresh);
    }
  }

  // Joins the walk already running, if any; otherwise walks - from the
  // first certificate (`fromStart`) or on from the checkpoint.
  private walk(fromStart: boolean): Promise<void> {
    this.walking ??= this.walkChain(fromStart).finally(() => {
      this.walking = null;
    });
    return this.walking;
  }

  private async walkChain(fromStart: boolean): Promise<void> {
    const keys = this.signer!.verifyKeys;
    const startedAt = Date.now();
    const prev = fromStart ? null : this.chain;
    // Nothing after a break can verify; only a walk from the start (the
    // next re-check) looks again.
    if (prev?.broken) return;
    let throughSeq = prev?.throughSeq ?? 0;
    let throughSha = prev?.throughSha ?? null;
    let broken: ChainState['broken'] = null;
    for (;;) {
      const rows: Array<Record<string, unknown>> = await this.ds.query(
        `SELECT ${RECORD_COLUMNS} FROM erasure_certificates
         WHERE seq > $1 ORDER BY seq LIMIT $2`,
        [throughSeq, WALK_BATCH],
      );
      for (const row of rows) {
        const r = recordOf(row);
        const own = verifyRecord(r, keys);
        // Each certificate names the one issued just before it (the ledger
        // issues under one lock, in seq order) by the hash that one's
        // payload really has - which verifyRecord has just recomputed and
        // matched against its payloadSha256.
        const reason = !own.valid
          ? own.reason
          : r.prevSha256 !== throughSha
            ? 'chain is broken'
            : null;
        if (reason) {
          broken = { seq: r.seq, reason };
          break;
        }
        throughSeq = r.seq;
        throughSha = r.payloadSha256;
      }
      if (broken || rows.length < WALK_BATCH) break;
      // Hand the event loop back between batches, so a long walk never
      // holds up the rest of the API.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.chain = {
      throughSeq,
      throughSha,
      broken,
      fullWalkAt: prev ? prev.fullWalkAt : startedAt,
    };
  }

  private async one(id: string): Promise<StoredRecord | null> {
    const rows: Array<Record<string, unknown>> = await this.ds.query(
      `SELECT ${RECORD_COLUMNS} FROM erasure_certificates WHERE id = $1::uuid`,
      [id],
    );
    return rows.length ? recordOf(rows[0]) : null;
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
