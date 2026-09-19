import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
  type WipeAttestation,
  type WipeSource,
} from './manual-wipe';
import { DISCARD_REFUSAL, discardedNotice } from './wipe-method';
import {
  MIXED_REFUSAL,
  certificateBlock,
  latestWipe,
  mixedNotice,
} from './certificate-eligibility';
import {
  assertOwnsBatch,
  isScopedManager,
  managerCanAccessBatch,
  type RequestUser,
} from '../common/ownership';



// Who the certificate names, and as what (remediation spec C-1).
//
// The station signs in as ONE shared account, so the account on a station
// record is not the person who wiped the drive - yet the certificate printed
// it as "Performed by", naming e.g. the admin account for every wipe ever
// done. The name the operator typed at the station (operator_name) was never
// printed at all. Now:
//   - the typed name prints as "Operator (self-declared)": nothing verifies
//     it, and the label says so;
//   - the account prints as what it is, "Filed by account";
//   - an older station record with no typed name prints only the account,
//     still labelled as the account, never as the performer.
// A manual record keeps "Recorded by" (manual-wipe.ts): there the account is
// a personal web login, and the person behind it did record the wipe.
export function erasurePeople(
  source: WipeSource,
  att: WipeAttestation,
  operatorName: string | null | undefined,
  accountName: string | null | undefined,
): [string, string][] {
  const operator = operatorName?.trim();
  const account = accountName?.trim() || '—';
  const rows: [string, string][] = [];
  if (operator) rows.push(['Operator (self-declared)', operator]);
  rows.push([
    source === 'manual' ? att.performerLabel : 'Filed by account',
    account,
  ]);
  return rows;
}

function pretty(value: string | null | undefined): string {
  if (!value) return '—';
  return value
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

@Injectable()
export class CertificatesService {
  constructor(
    @InjectRepository(Asset) private assets: Repository<Asset>,
    @InjectRepository(AssetAudit) private audits: Repository<AssetAudit>,
    @InjectRepository(Batch) private batches: Repository<Batch>,
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
    // Per device: the wipe on record (the latest by the station's clock), or
    // why none can be certified - one rule, certificateBlock in
    // certificate-eligibility.ts, applied on both the station's and the
    // server's clocks.
    //
    // A device whose latest recorded wipe was a block discard (TRIM) is left
    // off: that was never an erase - see wipe-method.ts. The LATEST wipe
    // decides, not any wipe: an older proper wipe says nothing about the drive
    // after it was used and discarded again. A device where a drive failed its
    // wipe close to (or after) the wipe on record is left off the same way:
    // another drive of it may still hold data (owner decision D11, interim).
    // The certificate counts what it left off, so nobody reads a short list as
    // the whole lot.
    const latest = new Map<string, AssetAudit>();
    const discarded: string[] = [];
    const mixed: string[] = [];
    for (const [id, list] of byAsset) {
      const block = certificateBlock(list);
      if (block === 'discard') discarded.push(id);
      else if (block === 'mixed') mixed.push(id);
      else if (block === null) latest.set(id, latestWipe(list) as AssetAudit);
    }

    const rows = assets
      .filter((a) => latest.has(a.id))
      .map((a) => {
        const w = latest.get(a.id)!;
        const hp = (a.hardwareProfile ?? {}) as Record<string, any>;
        const ident = (hp.identification ?? {}) as Record<string, any>;
        const storage = Array.isArray(hp.storage)
          ? hp.storage
              .map((d: any) => [d.capacity, d.type].filter(Boolean).join(' '))
              .filter(Boolean)
              .join(', ')
          : w.storageCapacity ?? '';
        return {
          serial: a.serialNumber ?? ident.serialNumber ?? a.tag,
          device: [ident.manufacturer ?? w.manufacturer, ident.model ?? w.model ?? a.name]
            .filter(Boolean)
            .join(' '),
          storage,
          method: (w.dataWipeMethod?.trim() || 'Not specified') + wipeAttestation(sourceOf(w)).methodSuffix,
          manual: sourceOf(w) === 'manual',
          date: new Date(w.createdAt),
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
      throw new BadRequestException(
        why.length
          ? `No device in this lot can be certified: ${why.join('; ')}. Wipe those drives again with the ALS audit station.`
          : 'No wiped devices in this lot — record data-wipe audits with status "Wiped" first.',
      );
    }

    const buffer = await this.renderLot(
      batch,
      rows,
      discarded.length,
      mixed.length,
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

    // Every WIPED and FAILED row: the wipe on record is the latest by the
    // station's clock, and the mixed-result guard needs the failures - any
    // FAILED row for the device newer than the wipe, or within 24 hours
    // before it, on either clock, and there is no certificate. See
    // certificate-eligibility.ts (owner decision D11, interim).
    const outcomes = await this.audits.find({
      where: {
        assetId,
        dataWipeStatus: In([DataWipeStatus.WIPED, DataWipeStatus.FAILED]),
      },
      order: { createdAt: 'DESC' },
      relations: ['auditedBy'],
    });
    const block = certificateBlock(outcomes);
    if (block === 'none') {
      throw new BadRequestException(
        'No completed data erasure on record for this device — record an audit with data-wipe status "Wiped" first.',
      );
    }
    if (block === 'discard') throw new BadRequestException(DISCARD_REFUSAL);
    if (block === 'mixed') throw new BadRequestException(MIXED_REFUSAL);
    const wipe = latestWipe(outcomes) as AssetAudit;

    const buffer = await this.render(asset, wipe);
    return { buffer, filename: `erasure-certificate-${asset.tag}.pdf` };
  }

  private render(asset: Asset, wipe: AssetAudit): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 56 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const hp = (asset.hardwareProfile ?? {}) as Record<string, any>;
      const ident = (hp.identification ?? {}) as Record<string, any>;
      const storage = Array.isArray(hp.storage)
        ? hp.storage
            .map((d: any) => [d.capacity, d.type].filter(Boolean).join(' '))
            .filter(Boolean)
            .join(', ')
        : wipe.storageCapacity ?? '';

      const manufacturer = ident.manufacturer ?? wipe.manufacturer ?? '';
      const model = ident.model ?? wipe.model ?? asset.name ?? '';
      const serial = asset.serialNumber ?? ident.serialNumber ?? wipe.serialNumber ?? asset.tag;
      const deviceType = asset.deviceType ?? ident.deviceType ?? asset.category ?? '';
      const wipedOn = new Date(wipe.createdAt).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
      });
      const issuedOn = new Date().toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
      });
      const account = wipe.auditedBy?.name ?? null;
      // What this certificate may truthfully claim depends on who recorded
      // the wipe - the station, which erased and read back the drive, or a
      // person typing an outcome. See manual-wipe.ts.
      const source = sourceOf(wipe);
      const att = wipeAttestation(source);
      const method = (wipe.dataWipeMethod?.trim() || 'Not specified') + att.methodSuffix;
      const d = new Date(wipe.createdAt);
      const certNo = `ERA-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
        d.getDate(),
      ).padStart(2, '0')}-${asset.id.slice(0, 8).toUpperCase()}`;

      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;

      doc.font('Helvetica-Bold').fontSize(20).fillColor('#111111').text(COMPANY.name);
      doc.font('Helvetica').fontSize(9).fillColor('#666666').text(`Company No. ${COMPANY.registration}`);
      doc.moveDown(1.1);

      doc.font('Helvetica-Bold').fontSize(16).fillColor('#111111').text('Certificate of Data Erasure');
      doc.moveDown(0.3);
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#666666')
        .text(`Certificate No: ${certNo}`)
        .text(`Issued: ${issuedOn}`);

      doc.moveDown(0.6);
      doc.strokeColor('#cccccc').lineWidth(1).moveTo(left, doc.y).lineTo(right, doc.y).stroke();
      doc.moveDown(0.8);

      doc
        .font('Helvetica')
        .fontSize(10.5)
        .fillColor('#222222')
        .text(att.intro, { align: 'left' });
      doc.moveDown(1);

      const section = (title: string, rows: [string, string][]) => {
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111').text(title);
        doc.moveDown(0.3);
        const labelW = 140;
        for (const [k, v] of rows) {
          const y = doc.y;
          doc.font('Helvetica').fontSize(10).fillColor('#666666').text(k, left, y, { width: labelW });
          doc
            .font('Helvetica')
            .fontSize(10)
            .fillColor('#111111')
            .text(v || '—', left + labelW, y, { width: right - left - labelW });
          doc.moveDown(0.2);
        }
        doc.moveDown(0.7);
      };

      section('Device', [
        ['Manufacturer', manufacturer],
        ['Model', model],
        ['Device type', deviceType],
        ['Serial number', serial],
        ['Asset tag', asset.tag],
        ['Storage media', storage],
      ]);

      section('Data erasure', [
        ['Method', method],
        ['Result', att.result],
        [att.dateLabel, wipedOn],
        ...erasurePeople(source, att, wipe.operatorName, account),
      ]);

      const extra: [string, string][] = [];
      if (wipe.cosmeticGrade) extra.push(['Cosmetic grade', pretty(wipe.cosmeticGrade)]);
      if (wipe.finalDisposition) extra.push(['Disposition', pretty(wipe.finalDisposition)]);
      if (extra.length) section('Additional', extra);

      doc.moveDown(0.6);
      doc.strokeColor('#cccccc').lineWidth(1).moveTo(left, doc.y).lineTo(right, doc.y).stroke();
      doc.moveDown(0.8);
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#666666')
        .text(
          `Issued by ${COMPANY.name} (Company No. ${COMPANY.registration}). This certificate relates solely to the device identified above.`,
        );

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
    rows: Array<{ serial: string; device: string; storage: string; method: string; manual: boolean; date: Date }>,
    discarded = 0,
    mixed = 0,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const left = 40;
      const right = doc.page.width - 40;
      const lot = lotAttestation(rows.filter((r) => r.manual).length, rows.length);
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
      // Headline, lead sentence and date column all depend on the mix of
      // station wipes and hand records - see lotAttestation in manual-wipe.ts.
      doc.font('Helvetica').fontSize(9.5).fillColor('#222222').text(lot.intro, { width: right - left });
      if (discarded > 0) {
        doc.moveDown(0.4);
        doc
          .font('Helvetica')
          .fontSize(9.5)
          .fillColor('#222222')
          .text(discardedNotice(discarded), { width: right - left });
      }
      if (mixed > 0) {
        doc.moveDown(0.4);
        doc
          .font('Helvetica')
          .fontSize(9.5)
          .fillColor('#222222')
          .text(mixedNotice(mixed), { width: right - left });
      }
      doc.moveDown(0.6);

      const cols = [
        { key: 'idx', label: '#', x: left, w: 20 },
        { key: 'serial', label: 'Serial / Tag', x: left + 20, w: 108 },
        { key: 'device', label: 'Device', x: left + 128, w: 150 },
        { key: 'storage', label: 'Storage', x: left + 278, w: 85 },
        { key: 'method', label: 'Method', x: left + 363, w: 92 },
        { key: 'date', label: lot.dateHeader, x: left + 455, w: right - (left + 455) },
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
          method: r.method,
          date: r.date.toLocaleDateString('en-GB'),
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
