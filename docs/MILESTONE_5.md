# Milestone 5 — Backend Image Quality Validation API

_Status: complete (85 tests, real-HTTP check with real captures). Not yet deployed (Milestone 8)._

## 1. Endpoint

`POST /api/fingerprints/quality-check` — `multipart/form-data`

| Part | Required | |
|---|---|---|
| `X-App-Key` header | yes | app key (no user logins, by design) |
| `hand` | yes | `left` or `right` |
| `image` | yes | one JPEG or PNG, ≤ `MAX_UPLOAD_BYTES` (15 MiB) |

**The image is never stored.** It is held in memory for the request only
(multer memory storage — no temp files), and the route has no database or
storage dependency.

### 200 — image could be analysed

```json
{
  "passed": false,
  "qualityVersion": "server-1.0",
  "hand": "right",
  "metrics": {
    "format": "jpeg", "width": 1887, "height": 1512, "exifOrientation": 1,
    "sizeBytes": 1204423, "sharpnessScore": 1.525, "brightnessScore": 110,
    "clippedHighlightShare": 0, "fingerCandidateShare": 0.931, "sharpEstimate": 1.942
  },
  "checks": {
    "format": "pass", "resolution": "pass", "exposure": "pass",
    "sharpness": "fail", "fingerRegion": "not_verified"
  },
  "reasons": ["Image appears blurry."],
  "recommendations": ["Hold the camera steady and retake.", "Retake the photograph."]
}
```
(Real response for one of the blurry test captures.)

### Errors (`{ "error": { "code", "message" }, "requestId" }`)

| Status | Code | When |
|---|---|---|
| 400 | `invalid_hand` | `hand` missing or not `left`/`right` |
| 400 | `missing_image` | no file in `image` |
| 400 | `unexpected_file` / `invalid_upload` | wrong field name, several files, malformed multipart |
| 401 | `unauthorized` | missing/invalid app key (upload not processed) |
| 413 | `file_too_large` | file > `MAX_UPLOAD_BYTES` |
| 415 | `unsupported_format` | content is not JPEG/PNG (checked by magic bytes, not extension or declared type) |
| 415 | `mime_mismatch` | declared `Content-Type` differs from the actual content |
| 422 | `corrupt_image` / `image_too_large` | truncated or undecodable file; > 60 MP (decompression-bomb guard) |
| 500 | `quality_check_failed` | unexpected analysis error (logged server-side, generic message) |

## 2. Checks and metrics

| Check | Rule (defaults) | Metric (units) |
|---|---|---|
| `format` | JPEG or PNG by content, complete file (JPEG EOI / PNG IEND), decodable by Sharp/libvips | `format`, `sizeBytes` |
| `resolution` | short side ≥ 1080 and long side ≥ 1440, after EXIF orientation | `width`, `height` (displayed px), `exifOrientation` |
| `exposure` | 60 ≤ brightness ≤ 220 and clipped-glare share ≤ 5 % | `brightnessScore` (mean luma 0–255), `clippedHighlightShare` (0–1) |
| `sharpness` | score ≥ 2.0; `skipped` when too dark | `sharpnessScore`: mean \|box₁−box₄\| of green channel at 60 % scale (8-bit units, higher = sharper) |
| `fingerRegion` | **always `not_verified`** | `fingerCandidateShare` (0–1, skin-colour heuristic, informational) |

`sharpEstimate` (Sharp's built-in Laplacian estimate) is informational only.

### Why `fingerRegion` is always `not_verified`

There is no reliable finger detector. The skin-colour heuristic only
chooses which pixels the statistics are computed on (finger candidates if
≥ 15 % of the central area, otherwise the whole central area). No claim is
made about finger position or ridge visibility, and a photo is never
passed or failed on "fingers found". (The app's live gate and local check
already block photos without a hand before upload.)

**Passing does not mean the ridges are clear enough for biometric
matching** — only that the image is technically usable.

## 3. Calibration (representative images)

Server metrics computed on the same real captures used for the app:

| Photo group | Server `sharpnessScore` | App ridge detail | Server verdict |
|---|---|---|---|
| Good captures (8) | 2.48 – 4.57 | 2.49 – 4.60 | pass |
| Known blurry (2) | 1.31, 1.52 | 1.32, 1.54 | **fail (blurry)** |
| Desk only, dark (2) | — | — | fail (exposure) |
| Desk only (2) | 3.42, 4.48 | — | pass — no finger claim; blocked by the app |

Server and app agree within ±0.05, so one threshold (2.0) serves both
(`server-1.0` ≙ app `local-1.0`). Sharp's own `sharpEstimate` did **not**
separate blurry from sharp (1.94 blurry vs 1.96–2.31 sharp), which is why
it is not used for decisions. Thresholds are provisional (one device, one
person) and configurable (`QualityConfig`).

## 4. Files

| File | |
|---|---|
| `src/quality/config.ts` | thresholds + `QUALITY_VERSION` |
| `src/quality/imageFormat.ts` | magic-byte sniffing, end-marker check |
| `src/quality/analyzePixels.ts` | pixel statistics (port of the app's, same skin test) |
| `src/quality/assessImage.ts` | Sharp decode (pixel limit, `failOn: error`, EXIF rotate), report + typed rejection |
| `src/middleware/upload.ts` | multer memory storage, limits, error mapping |
| `src/routes/fingerprints.ts` | the endpoint |
| `src/app.ts` | mounts `/api/fingerprints` behind the app key |

## 5. Tests

| File | Tests | Covers |
|---|---:|---|
| `test/quality.test.ts` | 13 | magic bytes (JPEG/PNG/GIF/WebP/BMP/TIFF/HEIC/unknown/empty), truncation detection; skin test; sharp vs smooth; glare measured / white background not glare; no-skin fallback; valid photo + `fingerRegion` never claimed; EXIF orientation; PNG; typed rejection; pixel-bomb guard; configurable thresholds |
| `test/quality-check.api.test.ts` | 20 | valid → 200 results; PNG; **blurred**, **dark** (blur skipped), **bright + clipping**, **small**; EXIF; **corrupt** (truncated, garbage) 422; **size limit** 413; **invalid MIME** (GIF, text-as-.jpg, declared≠actual) 415; missing image; missing/invalid hand; wrong field / two files; **invalid/missing app key** 401 (not processed); **service exception** → safe 500 + log; **never persists** (no temp files, no image data in logs); configurable thresholds |

## 6. Results

| Command | Result |
|---|---|
| `npm run typecheck` | no errors |
| `npm test` | **85 passed, 0 failed** (8 files, ~12 s) |
| `npm run test:coverage` | **97.0 % statements, 92.8 % branches** |
| Real server + real captures over HTTP | good → `passed: true`; blurry → `sharpness: fail`; ~0.24 s per 1.3 MB photo |
| `npm audit --omit=dev` | **0 vulnerabilities** (6 high in the dev-only test toolchain: picomatch ReDoS via Vitest — not shipped; review in M8) |

## 7. Remaining limitations

- Thresholds from one device/person; the server accepts any app version's photos, so calibrate on more devices.
- No reliable finger detection → `fingerRegion: not_verified` by design.
- CPU-bound (~0.2 s / photo); rate limiting and request timeouts come in Milestone 8.
- Not deployed yet; Supabase project not connected (not needed for this endpoint).
