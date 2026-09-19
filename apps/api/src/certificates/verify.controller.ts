import {
  Controller,
  Get,
  Header,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CertificateLedger } from './certificate-ledger';
import { SIGNATURE_ALGORITHM } from './certificate-signing';
import {
  publicResult,
  publicResultHtml,
  publicVerifyEnabled,
  type PublicResult,
} from './public-verify';
import { clientAddress, RateLimiter } from './rate-limit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The PUBLIC certificate check (plan step 30, owner decision D30) - the one
// controller anyone can call without signing in, listed in
// PUBLIC_CONTROLLERS in auth/endpoint-authz.spec.ts for that reason.
//
//   GET /verify/keys             the public keys certificates are signed
//                                with, by key_id - for checking a
//                                certificate independently
//                                (apps/api/scripts/verify-certificate.mjs).
//   GET /verify/:certificateId   re-hashes the stored certificate, checks its
//                                signature and walks the chain; answers ONLY
//                                valid/invalid, number, issued date, device
//                                make/model, drive count and level. An HTML
//                                page when a browser asks (the QR code on
//                                the PDF points here), JSON otherwise.
//
// OFF unless PUBLIC_VERIFY_ENABLED=1: both routes 404 exactly like a route
// that does not exist. Certificate ids are random v4 UUIDs, so a guessed id
// is a 404; each caller is rate limited (in memory, per API process).
@Controller('verify')
export class VerifyController {
  // Per caller: 30 requests a minute across both routes.
  private perCaller = new RateLimiter(30, 60_000);
  // All callers together: bounds the chain walks the route can be made to do
  // (counted only for certificates that exist - see check()).
  private overall = new RateLimiter(600, 60_000);

  constructor(private readonly ledger: CertificateLedger) {}

  @Get('keys')
  @Header('Cache-Control', 'public, max-age=300')
  keys(@Req() req: Request) {
    this.admit(req);
    return {
      algorithm: SIGNATURE_ALGORITHM,
      keys: this.ledger.signer?.publishedKeys() ?? [],
    };
  }

  @Get(':certificateId')
  @Header('Cache-Control', 'no-store')
  async check(
    @Param('certificateId') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicResult | string> {
    this.admit(req);
    if (!UUID.test(id)) throw new NotFoundException('Certificate not found');
    const cert = await this.ledger.find(id.toLowerCase());
    if (!cert) throw new NotFoundException('Certificate not found');
    // The global budget is spent only here, on a certificate that exists -
    // the chain walk is the expensive part. Taken before the id check (as it
    // first was), 20 addresses spraying guessed ids at their own 30 a minute
    // used up all 600 and every genuine QR-code scan got 429 for the rest of
    // the minute. A guessed id costs one primary-key lookup and its caller's
    // own budget; ids are random v4 UUIDs, so a caller cannot find real ones
    // to spend the global budget with.
    if (!this.overall.take('*'))
      throw new HttpException(
        'Too many certificate checks - try again in a minute.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    const result = publicResult(cert, await this.ledger.verify(cert));
    if (wantsHtml(req)) {
      res.type('html');
      return publicResultHtml(result);
    }
    return result;
  }

  private admit(req: Request): void {
    // Switched off: the same 404 body Nest gives a route that does not
    // exist, so the response does not even say the feature is there.
    if (!publicVerifyEnabled())
      throw new NotFoundException(
        `Cannot ${req.method ?? 'GET'} ${req.originalUrl ?? req.url ?? ''}`,
      );
    if (!this.perCaller.take(clientAddress(req)))
      throw new HttpException(
        'Too many certificate checks - try again in a minute.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
  }
}

// A phone's browser after scanning the QR code sends Accept: text/html; a
// script or curl does not.
function wantsHtml(req: Request): boolean {
  const accept = String(req.headers?.accept ?? '');
  return accept.includes('text/html');
}
