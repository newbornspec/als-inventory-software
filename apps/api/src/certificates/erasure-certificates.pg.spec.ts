import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { HttpException } from '@nestjs/common';
import * as QRCode from 'qrcode';
import PDFDocument from 'pdfkit';
import { DataSource } from 'typeorm';
import {
  openPgTestDatabase,
  pgTestPort,
} from '../database/pg-test-db-for-spec';
import { User, UserRole } from '../users/user.entity';
import { Batch } from '../batches/batch.entity';
import { Asset } from '../assets/asset.entity';
import { AssetAudit, DataWipeStatus } from '../assets/asset-audit.entity';
import { AssetHistory } from '../assets/asset-history.entity';
import { CertificatesService } from '../assets/certificates.service';
import type { IngestAuditDto } from '../devices/dto/ingest-audit.dto';
import { DevicesService } from '../devices/devices.service';
import { CertificateLedger } from './certificate-ledger';
import { CertificateSigner } from './certificate-signing';
import { ErasureCertificate } from './erasure-certificate.entity';
import { VerifyController } from './verify.controller';

// Plan step 29 against REAL Postgres: the insert-only trigger, issue-once
// certificates drawn from their stored snapshot, a re-wipe issuing a new
// certificate, the hash chain catching an edited row, and - with no key -
// nothing stored at all.
//
// Runs only when ALS_PG_TEST_PORT names a Postgres server (skipped in the
// plain `npx jest` run), on its own test database - created and migrated by
// openPgTestDatabase (database/pg-test-db-for-spec.ts), never the app's:
//   ALS_PG_TEST_PORT=55437 npx jest erasure-certificates.pg
//
// It EMPTIES erasure_certificates first (disabling the trigger to do so):
// the chain spans every certificate, so certificates left by an earlier run,
// signed with that run's throwaway key, would fail this run's chain checks.
// That is why it must never run on a database whose certificates matter.

const maybe = pgTestPort ? describe : describe.skip;

// A throwaway key for this run only (owner decision D29: no real key in the
// repo).
const testKey = () =>
  Buffer.from(
    generateKeyPairSync('ed25519')
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString(),
  ).toString('base64');

// Every string the PDF renderer draws, in order.
async function printed(run: () => Promise<unknown>): Promise<string[]> {
  const texts: string[] = [];
  type Text = (...a: unknown[]) => unknown;
  const proto = (PDFDocument as unknown as { prototype: { text: Text } })
    .prototype;
  const real = proto.text;
  const spy = jest.spyOn(proto, 'text').mockImplementation(function (
    this: unknown,
    ...args: unknown[]
  ) {
    if (typeof args[0] === 'string') texts.push(args[0]);
    return real.apply(this, args);
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return texts;
}

maybe('stored, signed erasure certificates (Postgres)', () => {
  let ds: DataSource;
  let userId: string;
  let signer: CertificateSigner;

  const devices = (ledger?: CertificateLedger) =>
    new DevicesService(
      ds.getRepository(User),
      ds.getRepository(Batch),
      ds.getRepository(Asset),
      ds.getRepository(AssetAudit),
      ds.getRepository(AssetHistory),
      { record: () => Promise.resolve() } as never,
      {
        getAuthz: () =>
          Promise.resolve({
            role: UserRole.ADMIN,
            permissions: [],
            disabled: false,
          }),
      } as never,
      ledger,
    );
  const certificates = (ledger?: CertificateLedger) =>
    new CertificatesService(
      ds.getRepository(Asset),
      ds.getRepository(AssetAudit),
      ds.getRepository(Batch),
      ledger,
    );

  // One machine with ONE internal drive, and its wipe record.
  const payload = (host: string, status?: DataWipeStatus) =>
    ({
      auditKind: 'amazon',
      operatorName: 'J Smith',
      profile: {
        identification: {
          manufacturer: 'Dell',
          model: 'Latitude 7490',
          serialNumber: host,
        },
        storage: [
          {
            model: 'Samsung SSD 980',
            serialNumber: `${host}-A`,
            interface: 'NVMe',
            type: 'NVMe',
            capacity: '512GB',
          },
        ],
      },
      ...(status
        ? {
            dataWipeStatus: status,
            dataWipeMethod: 'NVMe crypto erase — verified (reads as random)',
            wipedDrive: { serialNumber: `${host}-A`, model: 'Samsung SSD 980' },
            toolVersion: '2026.09.19',
            sanitisationLevel: 'purge',
            wipedAt: new Date().toISOString(),
          }
        : {}),
    }) as IngestAuditDto;

  // Capture then wipe, as at the station. Returns the asset id.
  async function wipedMachine(
    svc: DevicesService,
    host = `CERT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  ): Promise<string> {
    const { assetId } = await svc.ingest(userId, payload(host));
    await svc.ingest(userId, payload(host, DataWipeStatus.WIPED));
    return assetId;
  }

  const certsOf = (assetId: string) =>
    ds.getRepository(ErasureCertificate).find({
      where: { assetId },
      order: { seq: 'ASC' },
    });

  beforeAll(async () => {
    ds = await openPgTestDatabase();
    await ds.query('ALTER TABLE erasure_certificates DISABLE TRIGGER USER');
    await ds.query('DELETE FROM erasure_certificates');
    await ds.query('ALTER TABLE erasure_certificates ENABLE TRIGGER USER');
    const user = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        name: 'Station',
        email: `station-${Date.now()}@example.invalid`,
        passwordHash: 'x',
        role: UserRole.ADMIN,
        isStation: true,
      }),
    );
    userId = user.id;
    signer = CertificateSigner.fromEnv({ CERT_SIGNING_KEY: testKey() })!;
  }, 60000);

  afterAll(async () => {
    jest.useRealTimers();
    await ds?.destroy();
  });

  it('a machine that becomes certifiable at ingest gets its certificate then', async () => {
    const ledger = new CertificateLedger(ds, signer);
    const assetId = await wipedMachine(devices(ledger));
    const certs = await certsOf(assetId);
    expect(certs).toHaveLength(1);
    expect(certs[0].keyId).toBe(signer.keyId);
    expect(certs[0].payload.summary).toEqual({
      make: 'Dell',
      model: 'Latitude 7490',
      driveCount: 1,
      sanitisationLevel: 'purge',
    });
    expect(await ledger.verify(certs[0].id)).toEqual({ valid: true });
  }, 60000);

  it('UPDATE, DELETE and TRUNCATE fail at the trigger', async () => {
    const ledger = new CertificateLedger(ds, signer);
    const assetId = await wipedMachine(devices(ledger));
    const [c] = await certsOf(assetId);
    await expect(
      ds.query(`UPDATE erasure_certificates SET number = 'X' WHERE id = $1`, [
        c.id,
      ]),
    ).rejects.toThrow(/insert-only: UPDATE/);
    await expect(
      ds.query(
        `UPDATE erasure_certificates SET payload = jsonb_set(payload, '{summary,make}', '"HP"') WHERE id = $1`,
        [c.id],
      ),
    ).rejects.toThrow(/insert-only/);
    await expect(
      ds.query(`DELETE FROM erasure_certificates WHERE id = $1`, [c.id]),
    ).rejects.toThrow(/insert-only: DELETE/);
    await expect(ds.query(`TRUNCATE erasure_certificates`)).rejects.toThrow(
      /insert-only: TRUNCATE/,
    );
    // Through the ORM too.
    await expect(
      ds.getRepository(ErasureCertificate).delete({ id: c.id }),
    ).rejects.toThrow(/insert-only/);
    expect(await certsOf(assetId)).toHaveLength(1);
  }, 60000);

  it('two downloads, days apart, give the same number and issued date', async () => {
    const ledger = new CertificateLedger(ds, signer);
    // Signing switched on AFTER the wipe: no certificate at ingest ...
    const assetId = await wipedMachine(devices());
    expect(await certsOf(assetId)).toHaveLength(0);
    const svc = certificates(ledger);
    // ... so the first download issues it.
    const first = await printed(() => svc.erasureCertificate(assetId));
    const [stored] = await certsOf(assetId);
    expect(stored).toBeDefined();

    // The second download "a year later": the date printed is still the day
    // it was issued, not the day of the download.
    jest.useFakeTimers({
      now: new Date('2031-03-03T12:00:00Z'),
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
        'queueMicrotask',
        'hrtime',
        'performance',
      ],
    });
    let second: string[];
    try {
      second = await printed(() => svc.erasureCertificate(assetId));
    } finally {
      jest.useRealTimers();
    }
    const line = (t: string[], p: string) => t.find((s) => s.startsWith(p));
    expect(line(first, 'Certificate No:')).toBe(
      `Certificate No: ${stored.number}`,
    );
    expect(line(second, 'Certificate No:')).toBe(
      line(first, 'Certificate No:'),
    );
    const issued = new Date(stored.issuedAt).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    });
    expect(line(first, 'Issued:')).toBe(`Issued: ${issued}`);
    expect(line(second, 'Issued:')).toBe(`Issued: ${issued}`);
    expect(line(second, 'Issued:')).not.toContain('2031');
    // Still exactly one certificate.
    expect(await certsOf(assetId)).toHaveLength(1);
    expect(second.join(' ')).toContain(`key ID ${signer.keyId}`);
  }, 60000);

  it('a re-wipe after issue issues a NEW certificate and leaves the old one as it was', async () => {
    const ledger = new CertificateLedger(ds, signer);
    const svc = devices(ledger);
    const host = `CERT-${Date.now()}-rewipe`;
    const assetId = await wipedMachine(svc, host);
    const [before] = await certsOf(assetId);
    await svc.ingest(userId, payload(host, DataWipeStatus.WIPED));
    const after = await certsOf(assetId);
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(before);
    expect(after[1].number).not.toBe(before.number);
    // Same day, so the number the unsigned certificate would print, made
    // unique.
    expect(after[1].number).toBe(`${before.number}-2`);
    expect(after[1].payload.sources).not.toEqual(before.payload.sources);
    expect(await ledger.verify(after[1].id)).toEqual({ valid: true });
    expect(await ledger.verify(before.id)).toEqual({ valid: true });
  }, 60000);

  it('a drive failure after issue: no new certificate, and the download is refused', async () => {
    const ledger = new CertificateLedger(ds, signer);
    const svc = devices(ledger);
    const host = `CERT-${Date.now()}-fail`;
    const assetId = await wipedMachine(svc, host);
    await svc.ingest(userId, payload(host, DataWipeStatus.FAILED));
    expect(await certsOf(assetId)).toHaveLength(1);
    await expect(
      certificates(ledger).erasureCertificate(assetId),
    ).rejects.toThrow();
  }, 60000);

  it('concurrent issues for different machines keep ONE unbroken chain', async () => {
    const ledger = new CertificateLedger(ds, signer);
    const ids = await Promise.all(
      [0, 1, 2, 3, 4].map((i) =>
        wipedMachine(devices(), `CERT-${Date.now()}-par${i}`),
      ),
    );
    const issued = await Promise.all(
      ids.map((id) => new CertificateLedger(ds, signer).ensure(id)),
    );
    expect(issued.every(Boolean)).toBe(true);
    for (const c of issued)
      expect(await ledger.verify(c!.id)).toEqual({ valid: true });
  }, 60000);

  it('changing one byte of a stored payload breaks that certificate and every later one', async () => {
    const svc = devices(new CertificateLedger(ds, signer));
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const [c] = await certsOf(await wipedMachine(svc));
      ids.push(c.id);
    }
    const all = await ds
      .getRepository(ErasureCertificate)
      .find({ order: { seq: 'ASC' } });
    const pos = all.findIndex((c) => c.id === ids[1]);
    const earlier = all.slice(0, pos);
    const later = all.slice(pos + 1);
    expect(later.map((c) => c.id)).toContain(ids[2]);

    // What someone with the table owner's rights could do: switch the
    // trigger off and edit a certificate. 'Latitude 7490' -> 'Latitude 7491'.
    const original: Array<{ payload: unknown }> = await ds.query(
      'SELECT payload FROM erasure_certificates WHERE id = $1',
      [ids[1]],
    );
    const edit = async (sql: string, params: unknown[]) => {
      await ds.query('ALTER TABLE erasure_certificates DISABLE TRIGGER USER');
      try {
        await ds.query(sql, params);
      } finally {
        await ds.query('ALTER TABLE erasure_certificates ENABLE TRIGGER USER');
      }
    };
    await edit(
      `UPDATE erasure_certificates
         SET payload = jsonb_set(payload, '{summary,model}', '"Latitude 7491"')
       WHERE id = $1`,
      [ids[1]],
    );
    try {
      // A fresh ledger: no checkpoints from the checks above.
      const fresh = new CertificateLedger(ds, signer);
      for (const c of earlier)
        expect(await fresh.verify(c.id)).toEqual({ valid: true });
      expect((await fresh.verify(ids[1])).valid).toBe(false);
      for (const c of later)
        expect((await fresh.verify(c.id)).valid).toBe(false);
    } finally {
      // Put it back, so the chain is whole for any later test.
      await edit('UPDATE erasure_certificates SET payload = $2 WHERE id = $1', [
        ids[1],
        JSON.stringify(original[0].payload),
      ]);
    }
    const again = new CertificateLedger(ds, signer);
    expect(await again.verify(ids[2])).toEqual({ valid: true });
  }, 120000);

  it('without CERT_SIGNING_KEY nothing is stored, and the PDF says nothing about signatures', async () => {
    const off = new CertificateLedger(ds, CertificateSigner.fromEnv({}));
    expect(off.enabled).toBe(false);
    const count = () => ds.getRepository(ErasureCertificate).count();
    const before = await count();
    const assetId = await wipedMachine(devices(off));
    const texts = await printed(() =>
      certificates(off).erasureCertificate(assetId),
    );
    // And with no ledger at all (how the older specs build the services).
    await certificates().erasureCertificate(assetId);
    expect(await count()).toBe(before);
    expect(texts.join(' ')).not.toMatch(/sign(ed|ature)|SHA-256|key ID/i);
    expect(texts.find((s) => s.startsWith('Certificate No:'))).toMatch(
      /^Certificate No: ERA-\d{8}-[0-9A-F]{8}$/,
    );
  }, 60000);

  // ---- plan step 30: the public check, the QR code and the offline script --

  const withEnv = async <T>(
    env: Record<string, string | undefined>,
    run: () => Promise<T>,
  ): Promise<T> => {
    const saved = Object.fromEntries(
      Object.keys(env).map((k) => [k, process.env[k]]),
    );
    for (const [k, v] of Object.entries(env))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    try {
      return await run();
    } finally {
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  };
  const statusOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 200;
    } catch (e) {
      return e instanceof HttpException ? e.getStatus() : 500;
    }
  };
  const req = { headers: { accept: 'application/json' }, ip: '127.0.0.1' };
  const res = { type: () => undefined };

  it('the offline script verifies a certificate the API issued, with only /verify/keys', async () => {
    const ledger = new CertificateLedger(ds, signer);
    const assetId = await wipedMachine(devices(ledger));
    const record = await certificates(ledger).signedRecord(assetId);
    const keys = await withEnv({ PUBLIC_VERIFY_ENABLED: '1' }, () =>
      Promise.resolve(new VerifyController(ledger).keys(req as never)),
    );
    const dir = mkdtempSync(path.join(tmpdir(), 'als-cert-'));
    try {
      const k = path.join(dir, 'keys.json');
      const c = path.join(dir, 'certificate.json');
      // Through JSON, exactly as a customer receives both.
      writeFileSync(k, JSON.stringify(keys));
      writeFileSync(c, JSON.stringify(record));
      const script = path.join(
        __dirname,
        '..',
        '..',
        'scripts',
        'verify-certificate.mjs',
      );
      const r = spawnSync(
        process.execPath,
        [script, '--keys', k, '--certificate', c],
        { encoding: 'utf8' },
      );
      expect(r.stdout).toContain(`VALID - certificate ${record.number}`);
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it('/verify/:id on the real chain: valid, minimal; guessed ids 404; disabled 404', async () => {
    const ledger = new CertificateLedger(ds, signer);
    const assetId = await wipedMachine(devices(ledger));
    const [cert] = await certsOf(assetId);
    const ctl = new VerifyController(ledger);
    await withEnv({ PUBLIC_VERIFY_ENABLED: '1' }, async () => {
      const out = await ctl.check(cert.id, req as never, res as never);
      expect(out).toEqual({
        valid: true,
        certificateNumber: cert.number,
        issuedDate: new Date(cert.issuedAt).toISOString().slice(0, 10),
        device: { make: 'Dell', model: 'Latitude 7490' },
        driveCount: 1,
        sanitisationLevel: 'purge',
      });
      expect(JSON.stringify(out)).not.toMatch(/CERT-|J Smith|Station/);
      for (let i = 0; i < 5; i++)
        expect(
          await statusOf(ctl.check(randomUUID(), req as never, res as never)),
        ).toBe(404);
    });
    await withEnv({ PUBLIC_VERIFY_ENABLED: undefined }, async () => {
      expect(
        await statusOf(ctl.check(cert.id, req as never, res as never)),
      ).toBe(404);
      expect(
        await statusOf(Promise.resolve().then(() => ctl.keys(req as never))),
      ).toBe(404);
    });
  }, 60000);

  it('signed AND public check on: the PDF prints the id and a QR code for <base>/verify/<id>', async () => {
    const ledger = new CertificateLedger(ds, signer);
    const assetId = await wipedMachine(devices(ledger));
    const svc = certificates(ledger);
    const images: unknown[] = [];
    type Fn = (...a: unknown[]) => unknown;
    const proto = (PDFDocument as unknown as { prototype: { image: Fn } })
      .prototype;
    const realImage = proto.image;
    const spy = jest.spyOn(proto, 'image').mockImplementation(function (
      this: unknown,
      ...args: unknown[]
    ) {
      images.push(args[0]);
      return realImage.apply(this, args);
    });
    let on: string[];
    try {
      on = await withEnv(
        {
          PUBLIC_VERIFY_ENABLED: '1',
          PUBLIC_VERIFY_BASE_URL: 'https://api.example.test/',
        },
        () => printed(() => svc.erasureCertificate(assetId)),
      );
    } finally {
      spy.mockRestore();
    }
    const [cert] = await certsOf(assetId);
    const url = `https://api.example.test/verify/${cert.id}`;
    expect(on).toContain(`Certificate ID: ${cert.id}`);
    expect(on.join(' ')).toContain(url);
    // The image drawn IS the QR code for that URL.
    expect(images).toHaveLength(1);
    const expected = await QRCode.toBuffer(url, {
      type: 'png',
      margin: 1,
      width: 256,
      errorCorrectionLevel: 'M',
    });
    expect(Buffer.compare(images[0] as Buffer, expected)).toBe(0);

    // Signed but the public check off: no id, no QR.
    const off = await withEnv({ PUBLIC_VERIFY_ENABLED: undefined }, () =>
      printed(() => svc.erasureCertificate(assetId)),
    );
    expect(off.join(' ')).not.toContain('Certificate ID');
    expect(off.join(' ')).toContain(`key ID ${signer.keyId}`);
  }, 60000);

  it('the signed record export is 404 while signing is off', async () => {
    const assetId = await wipedMachine(devices());
    expect(await statusOf(certificates().signedRecord(assetId))).toBe(404);
    expect(
      await statusOf(
        certificates(new CertificateLedger(ds, null)).signedRecord(assetId),
      ),
    ).toBe(404);
  }, 60000);
});
