import sharp from 'sharp';

/**
 * Synthetic test images — generated, never real biometrics. "Skin" uses
 * colours measured on the app's own captures; "ridges" are fine stripes
 * (~10-px period); glare is square white shine patches.
 */
export function skinRgb(luma: number): [number, number, number] {
  const cb = 122;
  const cr = 146;
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return [
    c(luma + 1.402 * (cr - 128)),
    c(luma - 0.344136 * (cb - 128) - 0.714136 * (cr - 128)),
    c(luma + 1.772 * (cb - 128)),
  ];
}

export interface FingerImageOptions {
  width?: number;
  height?: number;
  luma?: number;
  ridges?: number;
  clippedShare?: number;
  skin?: boolean;
}

export function fingerPixels({
  width = 1600,
  height = 1200,
  luma = 115,
  ridges = 22,
  clippedShare = 0,
  skin = true,
}: FingerImageOptions = {}): { data: Buffer; width: number; height: number } {
  const data = Buffer.alloc(width * height * 3);
  const patch = 12;
  const period = clippedShare > 0 ? Math.round(patch / Math.sqrt(clippedShare)) : 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const ridge = ridges * Math.sin((x * 2 * Math.PI) / 10);
      const clipped = clippedShare > 0 && x % period < patch && y % period < patch;
      let rgb: [number, number, number];
      if (!skin) {
        const v = Math.max(0, Math.min(255, Math.round(luma + ridge)));
        rgb = [Math.min(255, v + 8), Math.min(255, v + 6), Math.max(0, v - 2)]; // beige desk
      } else if (clipped) {
        rgb = [255, 255, 255];
      } else {
        rgb = skinRgb(luma + ridge);
      }
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
    }
  }
  return { data, width, height };
}

function raw(opts: FingerImageOptions) {
  const p = fingerPixels(opts);
  return sharp(p.data, { raw: { width: p.width, height: p.height, channels: 3 } });
}

export const jpeg = (opts: FingerImageOptions = {}, orientation?: number) => {
  let s = raw(opts);
  if (orientation) s = s.withMetadata({ orientation });
  return s.jpeg({ quality: 95 }).toBuffer();
};
export const png = (opts: FingerImageOptions = {}) => raw(opts).png().toBuffer();
export const gif = (opts: FingerImageOptions = {}) => raw(opts).gif().toBuffer();
export const blurredJpeg = (opts: FingerImageOptions = {}) =>
  raw(opts).blur(5).jpeg({ quality: 95 }).toBuffer();
