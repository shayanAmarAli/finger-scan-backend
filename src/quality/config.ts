/**
 * Server-side quality thresholds. Versioned: every response carries
 * `qualityVersion`, so stored results can be compared across versions.
 *
 * Values are PROVISIONAL and app-specific (derived from captures of one
 * person on one device: Samsung Galaxy A06, rear camera, torch on,
 * −1.3 EV) — not fingerprint or biometric standards. They mirror the app's
 * local check (frontend `QualityConfig` local-1.0) so both sides agree.
 */
export const QUALITY_VERSION = 'server-1.0';

export interface QualityConfig {
  /** Content types accepted (checked against the file's magic bytes). */
  supportedFormats: readonly ImageFormat[];
  /** Orientation-independent minimum resolution (displayed size). */
  minShortSidePx: number;
  minLongSidePx: number;
  /** Decoded images larger than this are refused (decompression bombs). */
  maxInputPixels: number;
  /** Pixel statistics are computed on the image resized to this scale. */
  analysisScale: number;
  /** Share of the central area that must look like skin for the finger
   *  candidate region to be used for the statistics. */
  minFingerCandidateShare: number;
  /** Mean luma (0–255) of the analysed region. */
  minBrightness: number;
  maxBrightness: number;
  /** Luma at/above which a pixel is clipped. */
  clipLevel: number;
  /** Max share of clipped (glare) pixels on the finger candidate region. */
  maxClippedShare: number;
  /** Minimum sharpness score (see analyzePixels). */
  minSharpness: number;
}

export type ImageFormat = 'jpeg' | 'png' | 'gif' | 'webp' | 'bmp' | 'heic' | 'tiff' | 'unknown';

export const defaultQualityConfig: QualityConfig = {
  supportedFormats: ['jpeg', 'png'],
  minShortSidePx: 1080,
  minLongSidePx: 1440,
  maxInputPixels: 60_000_000,
  analysisScale: 0.6,
  minFingerCandidateShare: 0.15,
  minBrightness: 60,
  maxBrightness: 220,
  clipLevel: 250,
  maxClippedShare: 0.05,
  minSharpness: 2.0,
};
