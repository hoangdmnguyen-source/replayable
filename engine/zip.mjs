/**
 * Minimal ZIP read/write built on the platform's own DEFLATE.
 *
 * No JSZip, no CDN: CompressionStream/DecompressionStream ship in every browser
 * that can run a Cocos playable, and in Node 18+. That keeps the tool page a
 * single file that works with the network unplugged.
 *
 * Only what a Google Ads playable needs: stored + deflate entries, no
 * encryption, no ZIP64, no directories.
 */

const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, EOCD = 0x06054b50;

let CRC_TABLE = null;
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * MS-DOS packed date/time. Writing zeros here yields month 0 / day 0, which is
 * not a real date: readers either clamp it to 1980-01-01 or complain. Vendor
 * ZIPs carry a genuine timestamp, so ours should too.
 */
function dosDateTime(d = new Date()) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

async function runStream(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}
const inflateRaw = (b) => runStream(b, new DecompressionStream('deflate-raw'));
const deflateRaw = (b) => runStream(b, new CompressionStream('deflate-raw'));

/** Read a ZIP into [{ name, bytes }]. Walks the central directory, not the stream. */
export async function readZip(buffer) {
  const buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = [];

  for (let p = 0; p < buf.length - 4; p++) {
    if (dv.getUint32(p, true) !== CENTRAL) continue;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));

    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataAt = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataAt, dataAt + compSize);

    if (!name.endsWith('/')) {
      const bytes = method === 8 ? await inflateRaw(raw) : raw.slice();
      // `stored` is what tells the audit a recompress is available.
      out.push({ name, bytes, stored: method === 0, size: bytes.length });
    }
    p += 46 + nameLen + extraLen + commentLen - 1;
  }
  return out;
}

/**
 * Write [{ name, bytes }] to a ZIP, always DEFLATE.
 * Vendor playables often arrive STORED, so recompressing is usually the single
 * biggest size win available and costs nothing.
 */
export async function writeZip(files) {
  const locals = [], central = [];
  let offset = 0, count = 0;
  const { time, date } = dosDateTime();

  for (const f of files) {
    const nameBytes = new TextEncoder().encode(f.name);
    // Bit 11 tells the reader the name is UTF-8. Without it a non-ASCII name is
    // decoded as CP437 — real risk here, since vendor files arrive with
    // Vietnamese names.
    const flags = [...f.name].every((c) => c.charCodeAt(0) < 128) ? 0 : 0x800;
    const data = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes);
    const comp = await deflateRaw(data);
    const crc = crc32(data);

    const lh = new Uint8Array(30);
    const ldv = new DataView(lh.buffer);
    ldv.setUint32(0, LOCAL, true); ldv.setUint16(4, 20, true); ldv.setUint16(6, flags, true);
    ldv.setUint16(8, 8, true); ldv.setUint16(10, time, true); ldv.setUint16(12, date, true);
    ldv.setUint32(14, crc, true); ldv.setUint32(18, comp.length, true);
    ldv.setUint32(22, data.length, true); ldv.setUint16(26, nameBytes.length, true);
    locals.push(lh, nameBytes, comp);

    const ch = new Uint8Array(46);
    const cdv = new DataView(ch.buffer);
    cdv.setUint32(0, CENTRAL, true); cdv.setUint16(4, 20, true); cdv.setUint16(6, 20, true);
    cdv.setUint16(8, flags, true); cdv.setUint16(10, 8, true);
    cdv.setUint16(12, time, true); cdv.setUint16(14, date, true); cdv.setUint32(16, crc, true);
    cdv.setUint32(20, comp.length, true); cdv.setUint32(24, data.length, true);
    cdv.setUint16(28, nameBytes.length, true); cdv.setUint32(42, offset, true);
    central.push(ch, nameBytes);

    offset += 30 + nameBytes.length + comp.length;
    count++;
  }

  const centralBytes = concat(central);
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, EOCD, true);
  edv.setUint16(8, count, true); edv.setUint16(10, count, true);
  edv.setUint32(12, centralBytes.length, true); edv.setUint32(16, offset, true);

  return concat([...locals, centralBytes, eocd]);
}

function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
