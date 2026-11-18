/**
 * Removes privacy-sensitive metadata (GPS location, camera serials, dates,
 * comments, XMP/IPTC) WITHOUT re-encoding: the compressed image data is
 * copied byte-for-byte, so no pixel detail is lost.
 *
 * - JPEG: keeps JFIF (APP0), ICC colour profile (APP2 "ICC_PROFILE"),
 *   Adobe (APP14, affects colour decoding) and all decoding segments; drops
 *   EXIF/XMP (APP1), APP3–APP13, APP15 and comments. If the photo had a
 *   non-default EXIF orientation, a minimal EXIF block containing ONLY the
 *   orientation is written back so it still displays upright.
 * - PNG: keeps critical chunks and colour/geometry chunks (iCCP, sRGB,
 *   gAMA, cHRM, pHYs, sBIT); drops text, eXIf, time and unknown chunks.
 */
export function stripMetadata(input: Buffer, format: 'jpeg' | 'png'): Buffer {
  return format === 'jpeg' ? stripJpeg(input) : stripPng(input);
}

export class MetadataStripError extends Error {
  override name = 'MetadataStripError';
}

// ------------------------------------------------------------------ JPEG

function stripJpeg(b: Buffer): Buffer {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) {
    throw new MetadataStripError('Not a JPEG file');
  }
  const kept: Buffer[] = [b.subarray(0, 2)]; // SOI
  let orientation = 1;
  let insertedExif = false;
  let i = 2;

  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new MetadataStripError(`Corrupt JPEG at offset ${i}`);
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xda) {
      // Start of scan: everything from here (entropy-coded data, EOI) is
      // image data — copy unchanged.
      if (!insertedExif) kept.push(minimalExif(orientation));
      kept.push(b.subarray(i));
      return Buffer.concat(kept.filter((x) => x.length > 0));
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const length = b.readUInt16BE(i + 2);
    const end = i + 2 + length;
    if (length < 2 || end > b.length) {
      throw new MetadataStripError(`Corrupt JPEG segment at offset ${i}`);
    }
    const segment = b.subarray(i, end);
    const payload = b.subarray(i + 4, end);

    if (marker === 0xe1) {
      orientation = readExifOrientation(payload) ?? orientation; // then drop
    } else if (isKeptJpegSegment(marker, payload)) {
      // Insert the orientation-only EXIF right after JFIF (APP0) or before
      // the first non-APP0 segment, where readers expect it.
      if (!insertedExif && marker !== 0xe0) {
        kept.push(minimalExif(orientation));
        insertedExif = true;
      }
      kept.push(segment);
    }
    i = end;
  }
  throw new MetadataStripError('JPEG has no image data (SOS not found)');
}

function isKeptJpegSegment(marker: number, payload: Buffer): boolean {
  if (marker === 0xe0) return true; // APP0 JFIF/JFXX
  if (marker === 0xe2) return payload.subarray(0, 12).toString('latin1') === 'ICC_PROFILE\0';
  if (marker === 0xee) return true; // APP14 Adobe (colour transform)
  if (marker >= 0xe0 && marker <= 0xef) return false; // other APPn: metadata
  if (marker === 0xfe) return false; // COM
  return true; // DQT, DHT, SOFn, DRI, DNL, … — needed to decode
}

/** Reads tag 0x0112 from an APP1 "Exif\0\0" payload. */
function readExifOrientation(p: Buffer): number | undefined {
  if (p.length < 14 || p.subarray(0, 6).toString('latin1') !== 'Exif\0\0') return undefined;
  const tiff = p.subarray(6);
  const little = tiff.subarray(0, 2).toString('latin1') === 'II';
  const u16 = (o: number) => (little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  try {
    const ifd0 = u32(4);
    const count = u16(ifd0);
    for (let k = 0; k < count; k++) {
      const e = ifd0 + 2 + k * 12;
      if (u16(e) === 0x0112) {
        const v = u16(e + 8);
        return v >= 1 && v <= 8 ? v : undefined;
      }
    }
  } catch {
    return undefined; // malformed EXIF: treat as no orientation
  }
  return undefined;
}

/** APP1 EXIF segment containing only the Orientation tag (or nothing). */
function minimalExif(orientation: number): Buffer {
  if (orientation === 1) return Buffer.alloc(0);
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 offset
  tiff.writeUInt16LE(1, 8); // one entry
  tiff.writeUInt16LE(0x0112, 10); // Orientation
  tiff.writeUInt16LE(3, 12); // SHORT
  tiff.writeUInt32LE(1, 14); // count
  tiff.writeUInt16LE(orientation, 18); // value (left-justified)
  tiff.writeUInt32LE(0, 22); // no next IFD
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

// ------------------------------------------------------------------- PNG

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', // critical + transparency
  'iCCP', 'sRGB', 'gAMA', 'cHRM', 'sBIT', 'pHYs', // colour / geometry
]);

function stripPng(b: Buffer): Buffer {
  if (b.length < 8 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new MetadataStripError('Not a PNG file');
  }
  const kept: Buffer[] = [PNG_SIGNATURE];
  let i = 8;
  while (i + 12 <= b.length) {
    const length = b.readUInt32BE(i);
    const type = b.subarray(i + 4, i + 8).toString('latin1');
    const end = i + 12 + length;
    if (end > b.length) throw new MetadataStripError(`Corrupt PNG chunk ${type}`);
    if (PNG_KEEP.has(type)) kept.push(b.subarray(i, end)); // CRC copied as-is
    i = end;
    if (type === 'IEND') return Buffer.concat(kept);
  }
  throw new MetadataStripError('PNG has no IEND chunk');
}
