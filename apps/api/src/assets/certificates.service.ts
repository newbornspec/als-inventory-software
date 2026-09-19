import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import PDFDocument from 'pdfkit';
import { Asset } from './asset.entity';
import { AssetAudit, DataWipeStatus } from './asset-audit.entity';
import { Batch } from '../batches/batch.entity';
import { COMPANY } from '../common/company';
import {
  lotAttestation,
  sourceOf,
  wipeAttestation,
  type LotAttestation,
} from './manual-wipe';
import { discardedNotice } from './wipe-method';
import { latestWipe, mixedNotice } from './certificate-eligibility';
import {
  expectedDrivesFromRows,
  refusalFor,
  rollupWipe,
  type WipeRollup,
} from '../devices/wipe-rollup';
import {
  buildDeviceCertificate,
  driveSerialsOf,
  isQualified,
  lockedNotice,
  lotRowDate,
  storageFittedOf,
  unfinishedNotice,
  wipeTimeLockStatus,
  type DeviceCertificate,
} from './certificate-content';
import {
  assertOwnsBatch,
  isScopedManager,
  managerCanAccessBatch,
  type RequestUser,
} from '../common/ownership';
import { CertificateLedger } from '../certificates/certificate-ledger';
import { SIGNATURE_ALGORITHM } from '../certificates/certificate-signing';
import type { ErasureCertificate } from '../certificates/erasure-certificate.entity';

// What a SIGNED certificate prints about its signature (plan step 29). Only
// ever present when CERT_SIGNING_KEY is set; without it the PDF says nothing
// about signatures at all.
export interface CertificateSeal {
  keyId: string;
  sha256: string;
}

// The answer GET /assets/:id/certificate-eligibility gives (contract C4 of the
// remediation brief). The web asset page and the kiosk read this instead of
// re-implementing the rule; a client talking to an older API gets a 404 and
// must treat that as "unknown", never as "no".
export interface CertificateEligibility {
  available: boolean;
  reason: string | null;
  verdict: 'wiped' | 'failed' | 'incomplete' | 'none';
  drives: Array<{
    key: string;
    serialNumber: string | null;
    model: string | null;
    status: 'wiped' | 'failed' | 'missing';
    method: string | null;
    wipedAt: string | null;
    manual: boolean;
  }>;
}

// Is this machine erased? The per-drive roll-up (devices/wipe-rollup.ts) over
// every WIPED and FAILED row of the asset, with the internal drives of the
// wipe-time hardware profile as the drives that must each have a wipe.
export function rollupFor(rows: AssetAudit[]): WipeRollup<AssetAudit> {
  return rollupWipe(rows, expectedDrivesFromRows(rows));
}

// erasurePeople lives in certificate-people.ts (the certificate content
// builder needs it too); re-exported here for existing callers.
export { erasurePeople } from './certificate-people';

@Injectable()
export class CertificatesService {
  constructor(
    @InjectRepository(Asset) private assets: Repository<Asset>,
    @InjectRepository(AssetAudit) private audits: Repository<AssetAudit>,
    @InjectRepository(Batch) private batches: Repository<Batch>,
    // Signed, stored certificates (plan step 29). Optional so the specs that
    // build this service by hand can leave it out; absent, or present with
    // signing off, the certificate is built on every download as before.
    @Optional() private ledger?: CertificateLedger,
  ) {}

  // One bundled certificate listing every device in a lot that has a completed
  // wipe on record. Devices without a wipe are excluded; if none qualify it
  // refuses, same as the per-device certificate.
  async lotErasureCertificate(
    batchId: string,
    user?: RequestUser,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const batch = await this.batches.findOne({ where: { id: batchId } });
    if (!batch) throw new NotFoundException(`Lot ${batchId} not found`);
    assertOwnsBatch(batch.ownerId, user); // 403 for a manager who doesn't own it

    const assets = await this.assets
      .createQueryBuilder('asset')
      .addSelect('asset.hardwareProfile')
      .where('asset.batchId = :id', { id: batchId })
      .getMany();

    // FAILED rows too: the mixed-result guard below needs them.
    const outcomes = assets.length
      ? await this.audits.find({
          where: {
            assetId: In(assets.map((a) => a.id)),
            dataWipeStatus: In([DataWipeStatus.WIPED, DataWipeStatus.FAILED]),
          },
          order: { createdAt: 'DESC' },
        })
      : [];
    const byAsset = new Map<string, AssetAudit[]>();
    for (const o of outcomes) {
      const list = byAsset.get(o.assetId) ?? [];
      list.push(o);
      byAsset.set(o.assetId, list);
    }
    // Per device: is the MACHINE erased - every drive's latest record a wipe,
    // every internal drive accounted for (rollupFor; per drive, plan step
    // 23). A device that is not is left off, and the certificate counts what
    // it left off and why, so nobody reads a short list as the whole lot:
    //   - discard: its latest "wipe" was a block discard (TRIM), never an
    //     erase - see wipe-method.ts;
    //   - mixed: legacy records only (no drive identity) and a drive failed
    //     close to the wipe on record - the interim D11 rule;
    //   - unfinished: a drive failed and was not wiped since, or a drive of
    //     the machine has no wipe on record at all.
    // A device with only failures and no wipe at all was never listed and is
    // still not counted, as before.
    const latest = new Map<
      string,
      { cert: AssetAudit; rollup: WipeRollup<AssetAudit> }
    >();
    const discarded: string[] = [];
    const mixed: string[] = [];
    const unfinished: string[] = [];
    for (const [id, list] of byAsset) {
      const r = rollupFor(list);
      if (r.verdict === 'wiped')
        latest.set(id, { cert: latestWipe(list) as AssetAudit, rollup: r });
      else if (!latestWipe(list)) continue;
      else if (r.reason === 'discard') discarded.push(id);
      else if (r.reason === 'mixed') mixed.push(id);
      else unfinished.push(id);
    }

    const rows = assets
      .filter((a) => latest.has(a.id))
      .map((a) => {
        const { cert: w, rollup } = latest.get(a.id)!;
        const hp = (a.hardwareProfile ?? {}) as Record<string, any>;
        const ident = (hp.identification ?? {}) as Record<string, any>;
        // Each drive's own method (a machine's drives can be erased
        // differently), marked as a hand record where it is one.
        const drives = rollup.drives.filter((d) => d.row);
        const limited = drives.some(
          (d) => sourceOf(d.row!) === 'station' && isQualified(d.row!),
        );
        // D39: a LOCKED device is still listed, and marked.
        const locked = wipeTimeLockStatus(rollup) === 'LOCKED';
        const when = lotRowDate(rollup);
        const methods = [
          ...new Set(
            drives.map(
              (d) =>
                (d.row!.dataWipeMethod?.trim() || 'Not specified') +
                wipeAttestation(sourceOf(d.row!)).methodSuffix,
            ),
          ),
        ];
        return {
          serial: a.serialNumber ?? ident.serialNumber ?? a.tag,
          device:
            [
              ident.manufacturer ?? w.manufacturer,
              ident.model ?? w.model ?? a.name,
            ]
              .filter(Boolean)
              .join(' ') + (locked ? ' (device LOCKED)' : ''),
          // What was fitted when it was wiped, not what a later capture saw.
          storage: storageFittedOf(rollup, w),
          drives: driveSerialsOf(rollup),
          // Limitations on any drive: the lot's lead sentence scopes its
          // "unrecoverable" claim to rows without this mark (step 39).
          method:
            methods.join('; ') + (limited ? ' (limitations recorded)' : ''),
          manual: drives.every((d) => sourceOf(d.row!) === 'manual'),
          limited,
          locked,
          when,
        };
      });

    if (rows.length === 0) {
      const why: string[] = [];
      if (discarded.length)
        why.push(
          `${discarded.length} recorded wipe${discarded.length === 1 ? ' was a block discard' : 's were block discards'} (TRIM), which ${discarded.length === 1 ? 'is' : 'are'} not an erase`,
        );
      if (mixed.length)
        why.push(
          `${mixed.length} device${mixed.length === 1 ? ' has' : 's have'} a drive that failed its wipe close to (or after) the wipe on record`,
        );
      if (unfinished.length)
        why.push(
          `${unfinished.length} device${unfinished.length === 1 ? ' has' : 's have'} a drive that failed its wipe, or was never wiped, and has not been wiped since`,
        );
      throw new BadRequestException(
        why.length
          ? `No device in this lot can be certified: ${why.join('; ')}. Wipe those drives again with the ALS audit station.`
          : 'No wiped devices in this lot — record data-wipe audits with status "Wiped" first.',
      );
    }

    // Headline, lead sentence and date column all depend on the mix of
    // station wipes, hand records and rows with limitations - see
    // lotAttestation in manual-wipe.ts.
    const lot = lotAttestation(
      rows.filter((r) => r.manual).length,
      rows.length,
      rows.filter((r) => r.limited).length,
    );
    const locked = rows.filter((r) => r.locked).length;
    const notices = [
      ...(discarded.length ? [discardedNotice(discarded.length)] : []),
      ...(mixed.length ? [mixedNotice(mixed.length)] : []),
      ...(unfinished.length ? [unfinishedNotice(unfinished.length)] : []),
      ...(locked ? [lockedNotice(locked)] : []),
    ];
    const buffer = await this.renderLot(
      batch,
      rows.map((r) => ({
        serial: r.serial as string,
        device: r.device,
        storage: r.storage,
        drives: r.drives,
        method: r.method,
        // A date that is only when the record arrived says so, unless the
        // column itself is headed "Recorded".
        date:
          r.when.date.toLocaleDateString('en-GB') +
          (r.when.recorded && lot.dateHeader !== 'Recorded'
            ? ' (recorded)'
            : ''),
      })),
      lot,
      notices,
    );
    return { buffer, filename: `erasure-certificate-${batch.batchNumber}.pdf` };
  }

  // A Certificate of Data Erasure for a device that has a completed wipe on
  // record. Refuses to issue one if no wipe was recorded — the document must
  // reflect an action that actually happened.
  async erasureCertificate(
    assetId: string,
    user?: RequestUser,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const asset = await this.accessibleAsset(assetId, user);

    const outcomes = await this.wipeRows(assetId);
    const rollup = rollupFor(outcomes);
    // Refused unless the MACHINE is erased: every drive's latest record a
    // wipe and every internal drive of the wipe-time profile accounted for.
    // The sentence is the same one the eligibility endpoint gives.
    const refusal = refusalFor(rollup);
    if (refusal !== null) throw new BadRequestException(refusal);
    // The row the certificate NUMBER has always come from (see
    // certificateNumber in certificate-content.ts), so a certificate
    // downloaded again keeps the number it was first issued with.
    const certRow = latestWipe(outcomes) as AssetAudit;
    const filename = `erasure-certificate-${asset.tag}.pdf`;

    // Signing on (plan step 29): the certificate issued for these wipe
    // records - issued now if it was not at ingest - drawn from its stored
    // snapshot, so every download carries the same number and issued date.
    if (this.ledger?.enabled) {
      const stored = await this.ledger.ensure(assetId);
      // Only if a drive failed between the check above and the lock.
      if (!stored)
        throw new BadRequestException(
          refusalFor(rollupFor(await this.wipeRows(assetId))) ??
            'This device cannot be certified right now.',
        );
      const buffer = await this.render(
        stored.payload.certificate,
        new Date(stored.issuedAt),
        sealOf(stored),
      );
      return { buffer, filename };
    }

    const buffer = await this.render(
      buildDeviceCertificate(asset, rollup, certRow),
      new Date(),
    );
    return { buffer, filename };
  }

  // GET /assets/:id/certificate-eligibility (contract C4): the same roll-up
  // and the same refusal sentence as the certificate route, so the web page
  // and the kiosk can say why before anyone clicks - and neither keeps its
  // own copy of the rule. Same access rule as the certificate itself.
  async eligibility(assetId: string, user?: RequestUser): Promise<CertificateEligibility> {
    await this.accessibleAsset(assetId, user);
    const rollup = rollupFor(await this.wipeRows(assetId));
    return {
      available: rollup.verdict === 'wiped',
      reason: refusalFor(rollup),
      verdict: rollup.verdict,
      drives: rollup.drives.map((d) => ({
        key: d.key,
        serialNumber: d.serialNumber,
        model: d.model,
        status: d.status,
        method: d.row?.dataWipeMethod ?? null,
        // The station's own time for the wipe; null on legacy and manual
        // rows, which never had one (receipt time is not a wipe time).
        wipedAt: d.row?.wipedAt ? new Date(d.row.wipedAt).toISOString() : null,
        manual: d.manual,
      })),
    };
  }

  private async accessibleAsset(assetId: string, user?: RequestUser): Promise<Asset> {
    const asset = await this.assets
      .createQueryBuilder('asset')
      .addSelect('asset.hardwareProfile')
      .where('asset.id = :id', { id: assetId })
      .getOne();
    if (!asset) throw new NotFoundException(`Asset ${assetId} not found`);
    // A scoped manager can only certify a device in a lot they can access.
    if (isScopedManager(user) && !(await managerCanAccessBatch(this.batches, asset.batchId, user!))) {
      throw new NotFoundException(`Asset ${assetId} not found`);
    }
    return asset;
  }

  // Every WIPED and FAILED row of the device: the roll-up needs the failures
  // as much as the wipes.
  private wipeRows(assetId: string): Promise<AssetAudit[]> {
    return this.audits.find({
      where: {
        assetId,
        dataWipeStatus: In([DataWipeStatus.WIPED, DataWipeStatus.FAILED]),
      },
      order: { createdAt: 'DESC' },
      relations: ['auditedBy'],
    });
  }

  private render(
    c: DeviceCertificate,
    issued: Date,
    seal?: CertificateSeal,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 56 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const issuedOn = issued.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
      });
      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const bottom = () => doc.page.height - doc.page.margins.bottom;

      doc.font('Helvetica-Bold').fontSize(20).fillColor('#111111').text(COMPANY.name);
      doc.font('Helvetica').fontSize(9).fillColor('#666666').text(`Company No. ${COMPANY.registration}`);
      doc.moveDown(1.1);

      doc.font('Helvetica-Bold').fontSize(16).fillColor('#111111').text('Certificate of Data Erasure');
      doc.moveDown(0.3);
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#666666')
        .text(`Certificate No: ${c.certNo}`)
        .text(`Issued: ${issuedOn}`);

      doc.moveDown(0.6);
      doc.strokeColor('#cccccc').lineWidth(1).moveTo(left, doc.y).lineTo(right, doc.y).stroke();
      doc.moveDown(0.8);

      doc.font('Helvetica').fontSize(10.5).fillColor('#222222').text(c.intro, { align: 'left' });
      doc.moveDown(1);

      // A machine with several drives no longer fits one page, so a section
      // and each row move to a new page rather than running off the bottom.
      const section = (title: string, rows: [string, string][]) => {
        if (doc.y + 60 > bottom()) doc.addPage();
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111').text(title, left, doc.y);
        doc.moveDown(0.3);
        const labelW = 140;
        for (const [k, v] of rows) {
          const value = v || '—';
          const h = doc.font('Helvetica').fontSize(10).heightOfString(value, { width: right - left - labelW });
          if (doc.y + h > bottom()) doc.addPage();
          const y = doc.y;
          doc.font('Helvetica').fontSize(10).fillColor('#666666').text(k, left, y, { width: labelW });
          doc
            .font('Helvetica')
            .fontSize(10)
            .fillColor('#111111')
            .text(value, left + labelW, y, { width: right - left - labelW });
          doc.moveDown(0.2);
        }
        doc.moveDown(0.7);
      };

      section('Device', c.device);
      section('Data erasure', c.erasure);
      for (const d of c.drives) section(d.title, d.rows);
      for (const n of c.notices) {
        if (doc.y + 40 > bottom()) doc.addPage();
        doc.font('Helvetica').fontSize(10).fillColor('#222222').text(n, left, doc.y, { width: right - left });
        doc.moveDown(0.6);
      }
      if (c.extra.length) section('Additional', c.extra);

      if (doc.y + 110 > bottom()) doc.addPage();
      doc.moveDown(0.6);
      doc.strokeColor('#cccccc').lineWidth(1).moveTo(left, doc.y).lineTo(right, doc.y).stroke();
      doc.moveDown(0.8);
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#666666')
        .text(`Issued by ${COMPANY.name} (Company No. ${COMPANY.registration}). ${c.footer}`, left, doc.y, {
          width: right - left,
        });
      if (seal) {
        doc.moveDown(0.6);
        doc
          .font('Helvetica')
          .fontSize(8)
          .fillColor('#666666')
          .text(
            `Digitally signed (${SIGNATURE_ALGORITHM}, key ID ${seal.keyId}). This certificate was stored when it was issued and cannot be altered; SHA-256 of its signed content: ${seal.sha256}`,
            left,
            doc.y,
            { width: right - left },
          );
      }

      doc.moveDown(2);
      const sigY = doc.y;
      doc.strokeColor('#111111').lineWidth(1).moveTo(left, sigY).lineTo(left + 200, sigY).stroke();
      doc.strokeColor('#111111').moveTo(right - 160, sigY).lineTo(right, sigY).stroke();
      doc.font('Helvetica').fontSize(9).fillColor('#666666').text('Authorised signatory', left, sigY + 4);
      doc.text('Date', right - 160, sigY + 4);

      doc.end();
    });
  }

  private renderLot(
    batch: Batch,
    rows: Array<{
      serial: string;
      device: string;
      storage: string;
      drives: string;
      method: string;
      date: string;
    }>,
    lot: LotAttestation,
    notices: string[],
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const left = 40;
      const right = doc.page.width - 40;
      const t = new Date();
      const ymd = `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(
        t.getDate(),
      ).padStart(2, '0')}`;
      const certNo = `ERA-LOT-${batch.batchNumber}-${ymd}`;
      const issuedOn = t.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });

      doc.font('Helvetica-Bold').fontSize(18).fillColor('#111111').text(COMPANY.name);
      doc.font('Helvetica').fontSize(9).fillColor('#666666').text(`Company No. ${COMPANY.registration}`);
      doc.moveDown(0.8);
      doc
        .font('Helvetica-Bold')
        .fontSize(14)
        .fillColor('#111111')
        .text('Certificate of Data Erasure — Bulk / Lot');
      doc.moveDown(0.2);
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#666666')
        .text(`Certificate No: ${certNo}`)
        .text(`Issued: ${issuedOn}`);
      doc.moveDown(0.5);
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor('#222222')
        .text(`Lot: ${batch.batchNumber}${batch.source ? '     Supplier: ' + batch.source : ''}`)
        .text(lot.headline);
      doc.moveDown(0.5);
      doc.font('Helvetica').fontSize(9.5).fillColor('#222222').text(lot.intro, { width: right - left });
      for (const n of notices) {
        doc.moveDown(0.4);
        doc
          .font('Helvetica')
          .fontSize(9.5)
          .fillColor('#222222')
          .text(n, { width: right - left });
      }
      doc.moveDown(0.6);

      const cols = [
        { key: 'idx', label: '#', x: left, w: 20 },
        { key: 'serial', label: 'Serial / Tag', x: left + 20, w: 88 },
        { key: 'device', label: 'Device', x: left + 108, w: 112 },
        // Which drive(s) the row certifies (plan step 20): a lot line used
        // to name the machine only.
        { key: 'drives', label: 'Drive serial(s)', x: left + 220, w: 92 },
        { key: 'storage', label: 'Storage', x: left + 312, w: 62 },
        { key: 'method', label: 'Method', x: left + 374, w: 88 },
        { key: 'date', label: lot.dateHeader, x: left + 462, w: right - (left + 462) },
      ] as const;
      const bottom = doc.page.height - doc.page.margins.bottom - 80;

      const header = () => {
        const y = doc.y;
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#111111');
        for (const c of cols) doc.text(c.label, c.x, y, { width: c.w });
        doc.moveDown(0.15);
        doc.strokeColor('#999999').lineWidth(0.5).moveTo(left, doc.y).lineTo(right, doc.y).stroke();
        doc.moveDown(0.2);
      };
      header();

      rows.forEach((r, i) => {
        const vals: Record<string, string> = {
          idx: String(i + 1),
          serial: r.serial,
          device: r.device || '—',
          storage: r.storage || '—',
          drives: r.drives || '—',
          method: r.method,
          date: r.date,
        };
        doc.font('Helvetica').fontSize(8).fillColor('#222222');
        const h = Math.max(...cols.map((c) => doc.heightOfString(vals[c.key], { width: c.w - 4 })));
        if (doc.y + h > bottom) {
          doc.addPage();
          header();
          // header() leaves the document bold, so the first row of every
          // continuation page was drawn in the header's font.
          doc.font('Helvetica').fontSize(8).fillColor('#222222');
        }
        const y = doc.y;
        for (const c of cols) doc.text(vals[c.key], c.x, y, { width: c.w - 4 });
        doc.y = y + h + 3;
        doc.strokeColor('#eeeeee').lineWidth(0.5).moveTo(left, doc.y - 1).lineTo(right, doc.y - 1).stroke();
      });

      if (doc.y + 90 > doc.page.height - doc.page.margins.bottom) doc.addPage();
      doc.moveDown(1);
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor('#666666')
        .text(`Issued by ${COMPANY.name} (Company No. ${COMPANY.registration}).`, left, doc.y);
      doc.moveDown(2.5);
      const sy = doc.y;
      doc.strokeColor('#111111').lineWidth(1).moveTo(left, sy).lineTo(left + 200, sy).stroke();
      doc.moveTo(right - 160, sy).lineTo(right, sy).stroke();
      doc.font('Helvetica').fontSize(9).fillColor('#666666').text('Authorised signatory', left, sy + 4);
      doc.text('Date', right - 160, sy + 4);

      doc.end();
    });
  }
}

function sealOf(c: ErasureCertificate): CertificateSeal {
  return { keyId: c.keyId, sha256: c.payloadSha256 };
}
