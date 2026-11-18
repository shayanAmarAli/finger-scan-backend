import type { ImageFormat } from './config.js';

/** Identifies the image format from its content (magic bytes), never from a
 *  file name, extension or client-declared MIME type. */
export function sniffImageFormat(b: Buffer): ImageFormat {
  const at = (offset: number, sig: readonly number[] | string) => {
    const bytes = typeof sig === 'string' ? [...sig].map((c) => c.charCodeAt(0)) : sig;
    if (b.length < offset + bytes.length) return false;
    return bytes.every((v, i) => b[offset + i] === v);
  };
  if (at(0, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (at(0, 'GIF8')) return 'gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'webp';
  if (at(0, 'BM')) return 'bmp';
  if (at(0, [0x49, 0x49, 0x2a, 0x00]) || at(0, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff';
  if (at(4, 'ftyp') && ['heic', 'heix', 'hevc', 'heif', 'mif1'].some((brand) => at(8, brand))) {
    return 'heic';
  }
  return 'unknown';
}

export const mimeTypeOf: Partial<Record<ImageFormat, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
};

/** True if the file ends properly (JPEG EOI / PNG IEND) — catches truncated
 *  uploads that would otherwise decode as partially grey images. */
export function hasCompleteTrailer(b: Buffer, format: ImageFormat): boolean {
  if (format === 'jpeg') {
    for (let i = b.length - 2; i >= 0 && i >= b.length - 64; i--) {
      if (b[i] === 0xff && b[i + 1] === 0xd9) return true;
    }
    return false;
  }
  if (format === 'png') {
    return b.length >= 12 && b.subarray(b.length - 8, b.length - 4).toString('latin1') === 'IEND';
  }
  return true;
}
