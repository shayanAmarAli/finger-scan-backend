# Finger Scan — Backend

Node.js / Express (TypeScript) API that validates fingerprint photos from the
[finger-scan-frontend](https://github.com/shayanAmarAli/finger-scan-frontend)
app and stores them in **private** Supabase Storage, with metadata in
Supabase PostgreSQL. Deployed on Railway.

Progress: [Milestone 4 — foundation](docs/MILESTONE_4.md) ✅ · [Milestone 5 — quality-check API](docs/MILESTONE_5.md) ✅ · [Milestone 6 — submissions & storage](docs/MILESTONE_6.md) ✅ · [Milestone 8 — security, CI, deployment](docs/MILESTONE_8.md) ✅

**Deploy:** [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) · **Data protection & retention:** [docs/DATA_PROTECTION.md](docs/DATA_PROTECTION.md)

## Design decisions

- **No login.** The app opens, the user scans, and after validation the app
  uploads both images.
- **Anonymous submissions.** Each completed scan (left + right) is stored as
  a new submission with a generated ID; no personal data is collected.
- **Write-only API.** The app can only upload. There is no endpoint that
  returns images; they are readable only with the Supabase service role.
- **Protection:** `X-App-Key` on every `/api/*` request, private bucket,
  RLS enabled with no policies and privileges revoked from the public
  Supabase roles; per-IP rate limits, size limits, content validation,
  request timeouts, security headers, no CORS.
- **Consent:** submissions must carry the version of the consent text the
  user accepted in the app; it is stored with the submission.
- **Image fidelity:** stored images are not resized, re-compressed or
  sharpened; location metadata is stripped without re-encoding.

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | — | Liveness |
| `GET` | `/health/ready` | — | Database reachable + bucket exists and is private |
| `GET` | `/api/ping` | `X-App-Key` | Verify the app key |
| `POST` | `/api/fingerprints/quality-check` | `X-App-Key` | Multipart `image` + `hand`; returns quality diagnostics; **never stores the image** ([details](docs/MILESTONE_5.md)) |
| `POST` | `/api/submissions` | `X-App-Key` + `Idempotency-Key` | Multipart `left` + `right` + `consent_version`; quality-checked, metadata stripped, stored privately — both or neither ([details](docs/MILESTONE_6.md)) |

No endpoint returns or deletes images (write-only). Admin: `npm run cleanup`, `npm run submission:delete -- <id | reference>`.

Limits: 30 requests/min per IP on `/api/*`, 6 submissions/min; over the limit → `429 rate_limited` with `Retry-After`.

## Setup

1. **Supabase project** — create one at supabase.com (pick a region close to your users).
2. **Apply the migrations** — Dashboard → SQL Editor → run, in order:
   `supabase/migrations/20261118000001_fingerprint_tables.sql`,
   `supabase/migrations/20261118000002_fingerprint_bucket.sql`,
   `supabase/migrations/20261118000003_submission_upload.sql`, then
   `supabase/migrations/20261118000004_submission_consent.sql`.
   (Or with the Supabase CLI: `supabase link --project-ref <ref>` then `supabase db push`.)
3. **Configure** — `cp .env.example .env`, then fill in:
   - `SUPABASE_URL` — Project Settings → API → Project URL
   - `SUPABASE_SERVICE_ROLE_KEY` — Project Settings → API → `service_role` / secret key (**server only, never in the app or git**)
   - `APP_API_KEY` — generate one:
     `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
4. **Run**
   ```bash
   npm install
   npm run dev                      # http://localhost:8080
   curl localhost:8080/health/ready # → {"status":"ready",...}
   ```

## Scripts

| Script | |
|---|---|
| `npm run dev` | watch mode (reads `.env`) |
| `npm run build` / `npm start` | compile to `dist/` / run compiled |
| `npm run lint` | oxlint (warnings fail) |
| `npm run typecheck` | TypeScript, no emit |
| `npm test` / `npm run test:coverage` | Vitest + Supertest; migrations tested on real PostgreSQL (PGlite) — no Supabase needed; coverage thresholds enforced |
| `npm run check` | everything CI runs (lint, typecheck, tests + coverage, build) |

Real credentials live only in `.env` (local) and Railway / GitHub secrets.
