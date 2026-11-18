# Milestone 4 — Backend and Database Foundation

_Status: complete locally (code, migrations, 52 tests). Applying the migrations to the real Supabase project and deploying are pending credentials._

## 1. Decisions applied (supersede the original spec)

| Spec | Implemented | Why |
|---|---|---|
| Supabase Auth, authenticated user id | **App key** (`X-App-Key`) on every `/api/*` request; no user identity | Product decision: no login |
| `user_id` + one image per user/hand | **`submission_id`** + one image per submission/hand (`UNIQUE (submission_id, hand)`) | Anonymous submissions |
| "User A cannot access User B" | **Nobody but the backend can access anything**: RLS on, no policies, privileges revoked from `anon`/`authenticated` | Write-only API |

## 2. What was built

```
src/
  server.ts               entry: validate config → Supabase client → listen; graceful SIGTERM
  app.ts                  createApp(deps) — injectable for tests
  config/env.ts           zod-validated env; ConfigError lists names, never values
  lib/supabase.ts         service-role client (no session persistence); readiness probe
  lib/errors.ts           AppError (safe to show to clients)
  lib/logger.ts           JSON-line logger (ids, paths, status, timing only)
  middleware/appKey.ts    constant-time X-App-Key check (SHA-256 + timingSafeEqual)
  middleware/requestContext.ts  X-Request-Id + one log line per request
  middleware/errorHandler.ts    {error:{code,message}, requestId}; generic 500
  routes/health.ts        GET /health (liveness), GET /health/ready (DB + private bucket)
supabase/migrations/
  20261118000001_fingerprint_tables.sql
  20261118000002_fingerprint_bucket.sql
```

### Endpoints

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/health` | none | `200 {status:"ok", version, uptimeSeconds}` |
| GET | `/health/ready` | none | `200 {status:"ready", checks:{database:true, storageBucket:true}}` or `503 … false` |
| GET | `/api/ping` | `X-App-Key` | `200 {ok:true}` — lets the app verify its key |

Errors: `{ "error": { "code": "unauthorized", "message": "Missing or invalid app key." }, "requestId": "…" }` — codes `unauthorized` 401, `not_found` 404, `invalid_json` 400, `payload_too_large` 413, `service_unavailable` 503, `internal_error` 500.

### Data model

`fingerprint_submissions`: `id uuid pk`, `status ('pending'|'complete')`, `app_version`, `created_at`, `updated_at`.

`fingerprint_images`: `id`, `submission_id → submissions ON DELETE CASCADE`, `hand ('left'|'right')`, `storage_path UNIQUE`, `mime_type ('image/jpeg'|'image/png')`, `width>0`, `height>0`, `size_bytes>0`, `quality_status ('passed'|'failed'|'not_checked')`, `quality_metrics jsonb object`, `quality_version`, `version ≥1 default 1`, `created_at`, `updated_at` (trigger); **`UNIQUE (submission_id, hand)`**.

Security: RLS enabled on both tables, **no policies**; `REVOKE ALL … FROM anon, authenticated` (Supabase grants new tables to those roles by default). Storage bucket `fingerprints`: `public = false`, 15 MiB limit, JPEG/PNG only, **no storage policies** → only the service role can read/write.

## 3. Tests (Vitest + Supertest, no Supabase needed)

| File | Tests | Covers |
|---|---:|---|
| `test/config.test.ts` | 6 | valid env + defaults, number coercion, **missing config names every variable**, **secret values never echoed**, invalid URL/bucket/port/enum, app key ≥ 32 chars |
| `test/api.test.ts` | 15 | `/health` without key/Supabase; readiness 200; **database failure → controlled 503**; probe exception → 503 with no internals; **valid key 200, missing 401, invalid 401** (wrong/long/empty/case), key not accepted via query/Authorization, unknown `/api` routes 401 before 404; 404 JSON, invalid JSON 400, oversized 413, no `X-Powered-By`; request ids; **logs never contain the key, other headers or query strings** |
| `test/errorHandler.test.ts` | 4 | unexpected error → generic 500 + server log with request id; async rejection; AppError passthrough; non-Error throwables |
| `test/supabase.test.ts` | 6 | readiness: OK, **public bucket = not ready**, DB error, missing bucket, network failures contained; admin client creation |
| `test/migrations.test.ts` | 19 | real PostgreSQL (PGlite) + Supabase role/storage emulation: clean apply in order, columns, bucket migration re-runnable and re-asserts private; valid L+R; **invalid hand rejected**; one image per submission+hand; same hand across submissions OK; mime/size/status/metrics checks; unique storage path; FK; cascade delete; `updated_at` trigger + version default; **anon/authenticated cannot read/write tables**; **anon/authenticated cannot read/upload private-bucket objects**; no RLS policies exist; RLS enabled; service role can read/write |
| `test/server.test.ts` | 2 | real process: **missing config → exit 1** naming variables without values; starts locally, `/health` 200, `/health/ready` 503 without Supabase, key check, no secrets in logs, SIGTERM shutdown |

**Negative control** (run once, not kept as a test): with the `REVOKE` lines removed, `anon` reads 0 rows (RLS only); with RLS also removed, `anon` reads and inserts data — confirming the access-control tests detect a weakened migration.

### Results

| Command | Result |
|---|---|
| `npm run typecheck` | no errors |
| `npm test` | **52 passed, 0 failed** (6 files, ~29 s) |
| `npm run test:coverage` | **96.2 % statements, 90 % branches, 97.0 % lines** (`server.ts` exercised by process tests, excluded from instrumentation) |
| `npm run build` | `dist/` built |

## 4. Manual validation (needs your Supabase project)

1. Apply both migrations (README → Setup).
2. `npm run dev` → `curl localhost:8080/health/ready` → `200 ready`.
3. With the **anon** key: `curl "https://<ref>.supabase.co/rest/v1/fingerprint_images" -H "apikey: <anon>" -H "Authorization: Bearer <anon>"` → error (permission denied), never rows.
4. Dashboard → Storage → `fingerprints` shows **Private**.
5. Dashboard → Authentication → Policies: no policies on the two tables.

## 5. Remaining limitations / next

- Migrations not yet applied to a real Supabase project; Railway deployment is Milestone 8.
- The app key in the APK is extractable; acceptable because the API will be write-only (no endpoint returns images).
- Rate limiting, CORS, helmet and timeouts are Milestone 8.
- Lint (ESLint) is added with CI in Milestone 8; type-checking is in place now.
- Next: Milestone 5 — `POST /api/fingerprints/quality-check` (multipart upload, size/content validation, Sharp metrics, versioned thresholds, nothing persisted).
