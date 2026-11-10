// @ts-check
// A small ZIP writer: STORE (no compression), CRC-32, UTF-8 file names. Pure (TextEncoder and
// Uint8Array only), so the page builds the Obsidian download with it and Node tests read it back.
// Every entry gets the same fixed time (1980-01-01 00:00), so the same files make the same bytes.

/** @type {Uint32Array|null} */
let TABLE = null;

/** CRC-32 (IEEE 802.3, the one ZIP uses). @param {Uint8Array} bytes @returns {number} */
export function crc32(bytes) {
  if (!TABLE) {
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const UTF8_FLAG = 0x0800;
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01

/**
 * One .zip of these files, in this order. A name is a relative path with '/' between folders; a
 * name that is empty, absolute, or has a '.' / '..' segment or a backslash is refused.
 * @param {{ name: string, data: string|Uint8Array }[]} files
 * @returns {Uint8Array}
 */
export function zipFiles(files) {
  const enc = new TextEncoder();
  if (files.length > 0xfffe) throw new Error('Too many files for one zip.');
  /** @type {Uint8Array[]} */
  const parts = [];
  /** @type {Uint8Array[]} */
  const central = [];
  let offset = 0;
  const seen = new Set();
  for (const f of files) {
    const name = String(f.name);
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some((s) => s === '' || s === '.' || s === '..')) {
      throw new Error(`Bad file name in zip: ${JSON.stringify(name)}`);
    }
    if (seen.has(name)) throw new Error(`Duplicate file name in zip: ${JSON.stringify(name)}`);
    seen.add(name);
    const nameBytes = enc.encode(name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    if (data.length > 0xfffffffe || offset > 0xfffffffe) throw new Error('The zip would be too big.');
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, UTF8_FLAG, true);
    lv.setUint16(8, 0, true); // STORE
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, UTF8_FLAG, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    // extra, comment, disk, internal attributes, external attributes: 0
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);

    parts.push(local, data);
    central.push(cd);
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + end.length);
  let at = 0;
  for (const p of [...parts, ...central, end]) { out.set(p, at); at += p.length; }
  return out;
}
