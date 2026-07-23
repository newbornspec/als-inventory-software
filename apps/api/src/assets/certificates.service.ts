import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import PDFDocument from 'pdfkit';
import { Asset } from './asset.entity';
import { AssetAudit, DataWipeStatus } from './asset-audit.entity';
import { Batch } from '../batches/batch.entity';
import { assertOwnsBatch, isScopedManager, type RequestUser } from '../common/ownership';

// Issuer details for compliance documents. Overridable via env so the same
// codebase can be white-labelled without a code change.
const COMPANY = {
  name: process.env.COMPANY_NAME || 'ALS Trade Wholesales',
  registration: process.env.COMPANY_REG || '11269566',
};

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

    const wipes = assets.length
      ? await this.audits.find({
          where: { assetId: In(assets.map((a) => a.id)), dataWipeStatus: DataWipeStatus.WIPED },
          order: { createdAt: 'DESC' },
        })
      : [];
    const latest = new Map<string, AssetAudit>();
    for (const w of wipes) if (!latest.has(w.assetId)) latest.set(w.assetId, w);

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
          method: w.dataWipeMethod?.trim() || 'Not specified',
          date: new Date(w.createdAt),
        };
      });

    if (rows.length === 0) {
      throw new BadRequestException(
        'No wiped devices in this lot — record data-wipe audits with status "Wiped" first.',
      );
    }

    const buffer = await this.renderLot(batch, rows);
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
    // A scoped manager can only certify a device in a lot they own.
    if (isScopedManager(user)) {
      const owns =
        asset.batchId != null &&
        (await this.batches.count({ where: { id: asset.batchId, ownerId: user!.userId } })) > 0;
      if (!owns) throw new NotFoundException(`Asset ${assetId} not found`);
    }

    const wipe = await this.audits.findOne({
      where: { assetId, dataWipeStatus: DataWipeStatus.WIPED },
      order: { createdAt: 'DESC' },
      relations: ['auditedBy'],
    });
    if (!wipe) {
      throw new BadRequestException(
        'No completed data erasure on record for this device — record an audit with data-wipe status "Wiped" first.',
      );
    }

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
      const technician = (wipe.auditedBy as any)?.name ?? '—';
      const method = wipe.dataWipeMethod?.trim() || 'Not specified';
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
        .text(
          'This certifies that the data-storage media contained in the device identified below has been sanitised using the method stated, rendering previously stored data unrecoverable by generally available means.',
          { align: 'left' },
        );
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
        ['Result', 'Wiped — data unrecoverable'],
        ['Date performed', wipedOn],
        ['Performed by', technician],
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
    rows: Array<{ serial: string; device: string; storage: string; method: string; date: Date }>,
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
        .text(`Devices certified erased: ${rows.length}`);
      doc.moveDown(0.5);
      doc
        .font('Helvetica')
        .fontSize(9.5)
        .fillColor('#222222')
        .text(
          'This certifies that the data-storage media in each device listed below has been sanitised using the method stated, rendering previously stored data unrecoverable by generally available means.',
          { width: right - left },
        );
      doc.moveDown(0.6);

      const cols = [
        { key: 'idx', label: '#', x: left, w: 20 },
        { key: 'serial', label: 'Serial / Tag', x: left + 20, w: 108 },
        { key: 'device', label: 'Device', x: left + 128, w: 150 },
        { key: 'storage', label: 'Storage', x: left + 278, w: 85 },
        { key: 'method', label: 'Method', x: left + 363, w: 92 },
        { key: 'date', label: 'Wiped', x: left + 455, w: right - (left + 455) },
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
