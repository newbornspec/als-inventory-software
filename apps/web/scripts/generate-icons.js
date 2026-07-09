// One-off script: generates the PWA icon PNGs by hand-encoding raw pixel
// data (no image library needed). Run with: node scripts/generate-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [10, 10, 10]; // neutral-950
const FRAME = [52, 211, 153]; // emerald-400

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function generatePng(size, outPath) {
  const border = Math.round(size * 0.16);
  const frameWidth = Math.round(size * 0.06);

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter byte: none
    for (let x = 0; x < size; x++) {
      const inFrameBand =
        x >= border &&
        x < size - border &&
        y >= border &&
        y < size - border &&
        (x < border + frameWidth ||
          x >= size - border - frameWidth ||
          y < border + frameWidth ||
          y >= size - border - frameWidth);

      const [r, g, b] = inFrameBand ? FRAME : BG;
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, png);
  console.log(`Wrote ${outPath} (${size}x${size})`);
}

const iconsDir = path.join(__dirname, '..', 'public', 'icons');
generatePng(192, path.join(iconsDir, 'icon-192.png'));
generatePng(512, path.join(iconsDir, 'icon-512.png'));
