# Milestone 6 — Secure Upload and Storage of Submissions

_Status: complete locally (159 tests; real-process checks). Real Supabase run pending credentials._

## 1. Spec → implementation (product decisions: no login, anonymous submissions, write-only API)

| Spec | Implemented |
|---|---|
| `POST /api/fingerprints/left`, `/right` | **`POST /api/submissions`** with `left` + `right` in one request — **both stored or neither** |
| Replace previous image per user/hand; keep old if new fails | No users → each scan is a **new** submission; a failed upload leaves **no partial data** and never touches earlier submissions |
| `GET` / `DELETE /api/fingerprints/:hand` | **Not exposed** (write-only API). Deletion = admin command `npm run submission:delete -- <id>` |
| Idempotency & concurrency | Required `Idempotency-Key`; unique per submission in the DB; retries replay; concurrent duplicates collapse to one |
| Orphan cleanup, retryable | `storage_cleanup_queue` + `CleanupService` (queue with exponential backoff, stale pending rows, orphan folders); runs every 10 min in the server and via `npm run cleanup` |
| Preserve pixel detail; strip GPS | Metadata removed **at byte level, no re-encoding**; orientation kept; tests prove identical compressed data and pixels |
| No fingerprint data in logs | Only ids, status codes and timings are logged (tested) |

## 2. `POST /api/submissions`

Headers: `X-App-Key`, **`Idempotency-Key`** (8–128 chars `[A-Za-z0-9_-]`; reuse it when retrying the *same* scan, new key for a new scan).
Body (`multipart/form-data`): `left`, `right` (JPEG/PNG, ≤ 15 MiB each), optional `app_version`.

| Status | Body | When |
|---|---|---|
| **201** | `{ submissionId, status: "complete", replayed: false, images: [{hand,width,height,sizeBytes,qualityStatus}] }` | stored |
| **200** | `{ submissionId, status: "complete", replayed: true }` | retry of an earlier identical request |
| 400 | `missing_idempotency_key`, `invalid_idempotency_key`, `missing_image`, `unexpected_file`, `invalid_upload` | bad request |
| 401 | `unauthorized` | app key |
| 409 | `submission_in_progress` | identical request still being saved — retry shortly |
| 413 | `file_too_large` | |
| 415 | `unsupported_format`, `mime_mismatch` | content not JPEG/PNG / declared type wrong |
| 422 | `quality_failed` (+ `error.details.quality.left/right` = full quality reports), `corrupt_image`, `idempotency_key_reused` | |
| 503 | `storage_unavailable`, `database_unavailable` | rolled back; safe to retry with the same key |

### Flow

1. Quality-check **both** images (server-1.0) → any failure: 422, nothing stored.
2. Strip metadata (no re-encode).
3. Claim the Idempotency-Key: insert a `pending` submission (unique key ⇒ concurrent duplicates collide → replay or 409).
4. Upload `<submissionId>/left.jpg` and `…/right.jpg` to the private bucket (no overwrite, `no-store`).
5. `complete_fingerprint_submission()` — inserts both image records and marks the submission complete **in one transaction**.

Failure after step 3 → rollback: uploaded objects removed, pending row deleted. If an object can't be removed, it is queued in `storage_cleanup_queue`; if even that fails, the orphan sweep finds it.

## 3. Database (migration `20261118000003_submission_upload.sql`)

- `fingerprint_submissions.idempotency_key` (unique, format check), `request_hash` (sha-256, detects key reuse with different images), partial index on pending rows.
- `storage_cleanup_queue` (bucket, path unique, attempts, last_error, next_attempt_at) — RLS on, no policies, revoked from `anon`/`authenticated`.
- `complete_fingerprint_submission(uuid, jsonb)` — `security invoker`, fixed `search_path`, requires exactly one left + one right, only from `pending`; EXECUTE revoked from `public/anon/authenticated`, granted to `service_role`.

## 4. Metadata stripping (`src/images/stripMetadata.ts`)

JPEG: keep JFIF, ICC profile, Adobe APP14 and all decoding segments; drop EXIF/XMP (APP1), APP3–13, APP15, comments; write back an EXIF block containing **only the Orientation**. Everything from the start-of-scan marker on is copied unchanged.
PNG: keep critical + colour/geometry chunks; drop text, eXIf, tIME, unknown chunks.

## 5. Tests

| File | Tests | Covers |
|---|---:|---|
| `test/stripMetadata.test.ts` | 8 | GPS/make/model removed; **compressed data and pixels identical**; orientation kept (and display identical); comments + XMP removed; ICC kept; PNG text/eXIf removed with identical pixels; corrupt input |
| `test/submissionService.test.ts` | 18 | first upload stores both hands + records; left ≠ right; **a new scan never touches earlier ones**; GPS stripped, pixels identical; **low quality → nothing stored**; earlier data unaffected; MIME mismatch; key validation; **storage failure → DB not updated, partial upload removed**; **DB failure → objects removed, no rows**; DB down before upload; retry after failure succeeds; **rollback removal failure → queued → cleanup removes**; replay; key reuse 422; **3 concurrent identical uploads → one submission**; concurrent different scans; **no fingerprint data in logs** |
| `test/cleanup.test.ts` | 9 | queue removal; **retries with exponential backoff**; idempotent removal; stale pending removed (fresh kept); orphan folders removed (real + recent kept); repeated runs safe; **deletion removes record and objects**; deleted data inaccessible + repeat safe; storage failure keeps record for retry |
| `test/migrations.test.ts` | +9 | completion function: both hands, not twice, missing/duplicated hand rejected with nothing stored, **atomic rollback**, key unique/format, queue uniqueness, **anon/authenticated cannot execute or read queue**, service role can |
| `test/submissions.api.test.ts` | 12 | 201 + both stored; replay 200; key reuse 422; quality 422 with per-hand feedback; storage outage 503 with nothing half-saved; 401; missing/invalid key 400; missing hand 400; GIF 415; size 413; **no GET/DELETE routes (write-only)**; logs |
| `test/adapters.test.ts` | 13 | Supabase adapters: duplicate → DuplicateKeyError, other → DatabaseError, RPC call, filters for stale/cleanup queries, backoff update, exists/delete, private no-overwrite upload, StorageError, listing |
| `test/cli.test.ts` | 3 | admin CLI: no config → exit 1 without secrets; invalid id; unknown command |

### Results

| Command | Result |
|---|---|
| `npm run typecheck` | no errors |
| `npm test` | **159 passed, 0 failed** (14 files) |
| `npm run test:coverage` | **93.3 % statements, 85.3 % branches, 94.8 % lines** |
| Real server, real Supabase client, Supabase unreachable | `POST /api/submissions` → **503 `database_unavailable`**, generic message + request id; blurry right hand → **422** before any storage call |

## 6. Manual validation (needs the Supabase project)

1. Apply migration 3 (SQL Editor) after 1 and 2.
2. `npm run dev`; upload with curl:
   ```bash
   curl -X POST localhost:8080/api/submissions \
     -H "X-App-Key: $APP_API_KEY" -H "Idempotency-Key: test-scan-0001" \
     -F left=@left.jpg;type=image/jpeg -F right=@right.jpg;type=image/jpeg
   ```
   → 201; repeat → 200 `replayed: true`.
3. Dashboard → Storage → `fingerprints/<id>/left.jpg` exists; download it and confirm no GPS (`exiftool`) and same resolution.
4. Table editor: one submission `complete`, two image rows.
5. `npm run submission:delete -- <id>` → objects and rows gone.
6. Anon key cannot read rows or download objects.

## 7. Remaining limitations

- Not yet run against a real Supabase project / deployed (Milestone 8).
- Stored metadata includes the server quality report (no personal data).
- Retention policy (how long submissions are kept) is a product/legal decision — to document in Milestone 8; deletion tooling exists.
- Orphan sweep checks up to 100 folders per run.
