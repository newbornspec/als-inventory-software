import { Injectable } from '@nestjs/common';
import * as QRCode from 'qrcode';
import * as bwipjs from 'bwip-js';

export type BarcodeType = 'qr' | 'code128';

@Injectable()
export class BarcodeService {
  // Every asset's tag is what gets encoded — same value the /scan page
  // looks up, so a printed label always round-trips back to the right asset.
  // includeText=false prints bars only. The label already shows the Unit ID in
  // large type, so repeating it under the barcode wastes height that is better
  // spent on taller, more scannable bars.
  async generate(value: string, type: BarcodeType, includeText = true): Promise<Buffer> {
    return type === 'code128'
      ? this.generateCode128(value, includeText)
      : this.generateQr(value);
  }

  private generateQr(value: string): Promise<Buffer> {
    return QRCode.toBuffer(value, {
      type: 'png',
      width: 300,
      margin: 2,
      errorCorrectionLevel: 'M',
    });
  }

  private generateCode128(value: string, includeText = true): Promise<Buffer> {
    // 1D barcode — for sites using generic laser/CCD scanners that only
    // read linear symbologies, alongside the QR option for camera scanners.
    return bwipjs.toBuffer({
      bcid: 'code128',
      text: value,
      scale: 3,
      height: 10,
      includetext: includeText,
      textxalign: 'center',
    });
  }
}
