import PDFDocument from 'pdfkit';
import { COMPANY } from '../common/company';
import { Invoice } from './invoice.entity';

// The customer-facing invoice. Same table mechanics as the pallet costing sheet
// (landscape A4, columns derived from one width array, repeating header on page
// breaks) but a different document: it carries the buyer's address, an invoice
// number, and a VAT block, and it is priced at what the customer is charged.

function money(n: number): string {
  return `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function slugLabel(value: string | null): string {
  if (!value) return '';
  return value
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function renderInvoice(invoice: Invoice): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 40;
    const right = doc.page.width - 40;
    const issued = new Date(invoice.invoiceDate + 'T00:00:00').toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    });

    // --- header ---------------------------------------------------------------
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#111111').text(COMPANY.name, left, 40);
    doc.font('Helvetica').fontSize(9).fillColor('#666666').text(`Company No. ${COMPANY.registration}`);
    if (invoice.vatRegistered && invoice.vatNumber) {
      doc.text(`VAT No. ${invoice.vatNumber}`);
    }

    // Document identity, right-aligned opposite the company block.
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#111111')
      .text('INVOICE', left, 40, { width: right - left, align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor('#222222')
      .text(invoice.invoiceNumber, left, 66, { width: right - left, align: 'right' })
      .text(issued, left, 80, { width: right - left, align: 'right' });

    doc.y = 110;

    // --- bill to --------------------------------------------------------------
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#666666').text('BILL TO', left, doc.y);
    doc.moveDown(0.2);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111').text(invoice.buyerName, left);
    doc.font('Helvetica').fontSize(9.5).fillColor('#333333');
    for (const part of [
      invoice.buyerAddress1,
      invoice.buyerAddress2,
      invoice.buyerCity,
      invoice.buyerPostcode,
      invoice.buyerCountry,
    ]) {
      if (part) doc.text(part, left);
    }

    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(9).fillColor('#666666')
      .text(`Pallet: ${invoice.palletNumber}`, left);
    doc.moveDown(0.6);

    // --- items ----------------------------------------------------------------
    const w = [86, 100, 150, 58, 74, 44, 44, 62, 74, 70];
    const labels = [
      'Pallet',
      'Manufacturer',
      'Model',
      'Size',
      'Variant',
      'Stand',
      'Qty',
      'Grade',
      'Price',
      'Amount',
    ];
    let x = left;
    const cols = labels.map((label, i) => {
      const col = { label, x, w: w[i], right: i >= 6 };
      x += w[i];
      return col;
    });
    const bottom = doc.page.height - doc.page.margins.bottom - 110;

    const header = () => {
      const y = doc.y;
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#111111');
      for (const c of cols) {
        doc.text(c.label, c.x, y, { width: c.w - 4, align: c.right ? 'right' : 'left' });
      }
      doc.moveDown(0.15);
      doc.strokeColor('#999999').lineWidth(0.5).moveTo(left, doc.y).lineTo(right, doc.y).stroke();
      doc.moveDown(0.2);
    };
    header();

    for (const line of invoice.lines ?? []) {
      const vals = [
        invoice.palletNumber,
        line.manufacturer ?? '—',
        line.model ?? '—',
        line.size ?? '—',
        slugLabel(line.variantType) || '—',
        line.stand == null ? '—' : line.stand ? 'Yes' : 'No',
        String(line.quantity),
        slugLabel(line.grade) || '—',
        line.unitPrice != null ? money(line.unitPrice) : '—',
        line.lineTotal != null ? money(line.lineTotal) : '—',
      ];
      doc.font('Helvetica').fontSize(8).fillColor('#222222');
      const h = Math.max(...cols.map((c, i) => doc.heightOfString(vals[i], { width: c.w - 4 })));
      if (doc.y + h > bottom) {
        doc.addPage();
        header();
        // header() leaves the document bold; without this the first row of
        // every continuation page is drawn in the header's font.
        doc.font('Helvetica').fontSize(8).fillColor('#222222');
      }
      const y = doc.y;
      cols.forEach((c, i) => {
        doc.text(vals[i], c.x, y, { width: c.w - 4, align: c.right ? 'right' : 'left' });
      });
      doc.y = y + h + 3;
      doc.strokeColor('#eeeeee').lineWidth(0.5)
        .moveTo(left, doc.y - 1).lineTo(right, doc.y - 1).stroke();
    }

    // --- totals ---------------------------------------------------------------
    if (doc.y + 100 > doc.page.height - doc.page.margins.bottom) doc.addPage();
    doc.moveDown(0.5);

    const labelX = cols[7].x;
    const valueX = cols[9].x;
    const valueW = cols[9].w - 4;
    const row = (label: string, value: string, bold = false) => {
      const y = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9.5)
        .fillColor('#111111');
      doc.text(label, labelX, y, { width: cols[8].x - labelX + cols[8].w - 4, align: 'right' });
      doc.text(value, valueX, y, { width: valueW, align: 'right' });
      doc.y = y + (bold ? 18 : 15);
    };

    doc.strokeColor('#999999').lineWidth(0.5)
      .moveTo(labelX, doc.y).lineTo(right, doc.y).stroke();
    doc.moveDown(0.35);

    row('Subtotal', money(invoice.subtotal));
    if (invoice.vatRegistered) {
      // The rate is printed, not implied: a customer must be able to check the
      // arithmetic without knowing what rate was in force that day.
      const rate = invoice.vatRate ?? 0;
      row(`VAT @ ${rate}%`, money(invoice.vatAmount));
    }
    doc.moveDown(0.15);
    const ty = doc.y;
    doc.strokeColor('#111111').lineWidth(0.8).moveTo(labelX, ty).lineTo(right, ty).stroke();
    doc.moveDown(0.3);
    row('Total', money(invoice.total), true);

    if (!invoice.vatRegistered) {
      doc.moveDown(0.4);
      doc.font('Helvetica').fontSize(8.5).fillColor('#666666')
        .text('No VAT has been charged — this business is not VAT registered.', left, doc.y, {
          width: right - left,
        });
    }

    if (invoice.notes) {
      doc.moveDown(0.6);
      doc.font('Helvetica').fontSize(8.5).fillColor('#444444')
        .text(invoice.notes, left, doc.y, { width: right - left });
    }

    doc.end();
  });
}
