import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import PDFDocument from 'pdfkit';
import { Asset } from './asset.entity';
import { AssetAudit, DataWipeStatus } from './asset-audit.entity';

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
  ) {}

  // A Certificate of Data Erasure for a device that has a completed wipe on
  // record. Refuses to issue one if no wipe was recorded — the document must
  // reflect an action that actually happened.
  async erasureCertificate(assetId: string): Promise<{ buffer: Buffer; filename: string }> {
    const asset = await this.assets
      .createQueryBuilder('asset')
      .addSelect('asset.hardwareProfile')
      .where('asset.id = :id', { id: assetId })
      .getOne();
    if (!asset) throw new NotFoundException(`Asset ${assetId} not found`);

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
}
