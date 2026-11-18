import type { QualityConfig } from './config.js';

/**
 * Pixel statistics of the central 60 % × 60 % area of an RGB image
 * (port of the Flutter app's `analyzePixels`, so both sides agree).
 *
 * The "finger candidate" region is a COLOUR HEURISTIC (YCbCr skin test),
 * not a verified finger detector; it only decides which pixels the
 * statistics are computed on.
 */
export interface PixelStats {
  /** 0–1: share of the central area that passes the skin-colour test. */
  fingerCandidateShare: number;
  /** True if the candidate region was large enough to be used. */
  usedFingerCandidates: boolean;
  /** Mean luma 0–255 of the analysed pixels. */
  brightness: number;
  /** 0–1: clipped pixels whose neighbourhood is mostly candidate (shine on
   *  the fingers, not a white background), relative to the candidate area. */
  clippedShare: number;
  /** Mean |box₁ − box₄| of the green channel (8-bit units) over the analysed
   *  pixels — band-pass detail at ridge scale. Higher = sharper. */
  sharpness: number;
}

/** YCbCr skin test calibrated on the app's captures (same as the app). */
export function isSkin(y: number, cb: number, cr: number): boolean {
  return y > 30 && cr >= 135 && cr <= 185 && cb >= 70 && cb <= 130 && cr - cb >= 10;
}

export function analyzePixels(
  rgb: Uint8Array,
  fullW: number,
  fullH: number,
  config: Pick<QualityConfig, 'clipLevel' | 'minFingerCandidateShare'>,
  channels = 3,
): PixelStats {
  const x0 = Math.floor(fullW / 5);
  const y0 = Math.floor(fullH / 5);
  const w = Math.max(1, Math.floor((fullW * 3) / 5));
  const h = Math.max(1, Math.floor((fullH * 3) / 5));
  const n = w * h;
  const green = new Float32Array(n);
  const luma = new Uint8Array(n);
  const skin = new Float32Array(n);
  let skinCount = 0;
  let skinLuma = 0;
  let allLuma = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y + y0) * fullW + (x + x0)) * channels;
      const r = rgb[i]!;
      const g = rgb[i + 1]!;
      const b = rgb[i + 2]!;
      const yy = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      const cb = Math.round(128 - 0.168736 * r - 0.331264 * g + 0.5 * b);
      const cr = Math.round(128 + 0.5 * r - 0.418688 * g - 0.081312 * b);
      const k = y * w + x;
      green[k] = g;
      luma[k] = yy;
      allLuma += yy;
      if (isSkin(yy, cb, cr)) {
        skin[k] = 1;
        skinCount++;
        skinLuma += yy;
      }
    }
  }

  const fingerCandidateShare = skinCount / n;
  const usedFingerCandidates = fingerCandidateShare >= config.minFingerCandidateShare;
  const brightness = usedFingerCandidates ? skinLuma / skinCount : allLuma / n;

  let glare = 0;
  if (skinCount > 0) {
    const radius = Math.max(6, Math.round(Math.min(w, h) * 0.06));
    const density = boxMean(skin, w, h, radius);
    for (let k = 0; k < n; k++) {
      if (skin[k] === 0 && luma[k]! >= config.clipLevel && density[k]! > 0.5) glare++;
    }
  }
  const clippedShare = skinCount === 0 ? 0 : glare / (skinCount + glare);

  const fine = boxMean(green, w, h, 1);
  const coarse = boxMean(green, w, h, 4);
  let sum = 0;
  let count = 0;
  for (let k = 0; k < n; k++) {
    if (!usedFingerCandidates || skin[k] === 1) {
      sum += Math.abs(fine[k]! - coarse[k]!);
      count++;
    }
  }
  return {
    fingerCandidateShare,
    usedFingerCandidates,
    brightness,
    clippedShare,
    sharpness: count === 0 ? 0 : sum / count,
  };
}

/** Box mean with edge clamping, via a summed-area table. */
function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const stride = w + 1;
  const sat = new Float64Array(stride * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x]!;
      sat[(y + 1) * stride + x + 1] = sat[y * stride + x + 1]! + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - r);
    const yb = Math.min(h - 1, y + r) + 1;
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - r);
      const xb = Math.min(w - 1, x + r) + 1;
      out[y * w + x] =
        (sat[yb * stride + xb]! - sat[ya * stride + xb]! - sat[yb * stride + xa]! + sat[ya * stride + xa]!) /
        ((xb - xa) * (yb - ya));
    }
  }
  return out;
}
