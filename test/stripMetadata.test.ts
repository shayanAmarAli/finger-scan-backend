import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { MetadataStripError, stripMetadata } from '../src/images/stripMetadata.js';
import { fingerPixels } from './helpers/images.js';

const gps = {
  IFD0: { Make: 'TestPhone', Model: 'X1', Software: 'cam 1.0' },
  IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '24/1 51/1 3000/100', GPSLongitudeRef: 'E', GPSLongitude: '67/1 0/1 0/1' },
};

async function photoWithGps(orientation?: number) {
  const p = fingerPixels({ width: 320, height: 240 });
  let s = sharp(p.data, { raw: { width: p.width, height: p.height, channels: 3 } }).withExif(gps);
  if (orientation) s = s.withMetadata({ orientation });
  return s.jpeg({ quality: 92 }).toBuffer();
}

const rawPixels = (b: Buffer) => sharp(b).raw().toBuffer();

/** Bytes from the start-of-scan marker to the end (compressed image data). */
function scanData(b: Buffer): Buffer {
  for (let i = 2; i < b.length - 1; i++) {
    if (b[i] === 0xff && b[i + 1] === 0xda) return b.subarray(i);
  }
  throw new Error('no SOS');
}

describe('stripMetadata — JPEG', () => {
  it('removes GPS, camera make/model and software', async () => {
    const input = await photoWithGps();
    const before = await sharp(input).metadata();
    expect(before.exif).toBeDefined();
    expect(input.includes(Buffer.from('TestPhone'))).toBe(true);

    const out = stripMetadata(input, 'jpeg');
    const after = await sharp(out).metadata();
    expect(after.exif).toBeUndefined();
    expect(out.includes(Buffer.from('TestPhone'))).toBe(false);
    expect(out.includes(Buffer.from('GPS'))).toBe(false);
  });

  it('does not re-encode: compressed image data and decoded pixels are identical', async () => {
    const input = await photoWithGps();
    const out = stripMetadata(input, 'jpeg');
    expect(scanData(out).equals(scanData(input))).toBe(true);
    expect((await rawPixels(out)).equals(await rawPixels(input))).toBe(true);
    expect(out.length).toBeLessThan(input.length);
  });

  it('keeps the orientation (and only the orientation)', async () => {
    const input = await photoWithGps(6);
    const out = stripMetadata(input, 'jpeg');
    const after = await sharp(out).metadata();
    expect(after.orientation).toBe(6);
    expect(out.includes(Buffer.from('TestPhone'))).toBe(false);
    // Displayed size after rotation is unchanged.
    const a = await sharp(input).rotate().raw().toBuffer({ resolveWithObject: true });
    const b = await sharp(out).rotate().raw().toBuffer({ resolveWithObject: true });
    expect([b.info.width, b.info.height]).toEqual([a.info.width, a.info.height]);
    expect(b.data.equals(a.data)).toBe(true);
  });

  it('removes comments and XMP', async () => {
    const p = fingerPixels({ width: 64, height: 48 });
    const base = await sharp(p.data, { raw: { width: 64, height: 48, channels: 3 } }).jpeg().toBuffer();
    const com = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x0e]), Buffer.from('secret-note!')]);
    const xmpPayload = Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>location</x:xmpmeta>');
    const xmp = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(xmpPayload.length + 2) >> 8, (xmpPayload.length + 2) & 255]), xmpPayload]);
    const input = Buffer.concat([base.subarray(0, 2), com, xmp, base.subarray(2)]);
    const out = stripMetadata(input, 'jpeg');
    expect(out.includes(Buffer.from('secret-note'))).toBe(false);
    expect(out.includes(Buffer.from('xmpmeta'))).toBe(false);
    expect((await rawPixels(out)).equals(await rawPixels(input))).toBe(true);
  });

  it('keeps the ICC colour profile', async () => {
    const p = fingerPixels({ width: 64, height: 48 });
    const input = await sharp(p.data, { raw: { width: 64, height: 48, channels: 3 } })
      .withIccProfile('p3')
      .withExif(gps)
      .jpeg()
      .toBuffer();
    const out = stripMetadata(input, 'jpeg');
    expect((await sharp(out).metadata()).icc).toBeDefined();
    expect((await sharp(out).metadata()).exif).toBeUndefined();
  });

  it('rejects non-JPEG and corrupt input', async () => {
    expect(() => stripMetadata(Buffer.from('hello'), 'jpeg')).toThrow(MetadataStripError);
    const good = await photoWithGps();
    expect(() => stripMetadata(good.subarray(0, 30), 'jpeg')).toThrow(MetadataStripError);
  });
});

describe('stripMetadata — PNG', () => {
  it('removes text/EXIF chunks, keeps pixels identical', async () => {
    const p = fingerPixels({ width: 64, height: 48 });
    const input = await sharp(p.data, { raw: { width: 64, height: 48, channels: 3 } })
      .withExif(gps)
      .png()
      .toBuffer();
    expect(input.includes(Buffer.from('eXIf')) || input.includes(Buffer.from('TestPhone'))).toBe(true);
    const out = stripMetadata(input, 'png');
    expect(out.includes(Buffer.from('eXIf'))).toBe(false);
    expect(out.includes(Buffer.from('TestPhone'))).toBe(false);
    expect((await rawPixels(out)).equals(await rawPixels(input))).toBe(true);
  });

  it('rejects non-PNG and truncated input', async () => {
    expect(() => stripMetadata(Buffer.from('nope'), 'png')).toThrow(MetadataStripError);
    const p = fingerPixels({ width: 16, height: 16 });
    const png = await sharp(p.data, { raw: { width: 16, height: 16, channels: 3 } }).png().toBuffer();
    expect(() => stripMetadata(png.subarray(0, png.length - 12), 'png')).toThrow(MetadataStripError);
  });
});
