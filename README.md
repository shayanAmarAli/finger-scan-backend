# Finger Scan — Backend

Node.js / Express (TypeScript) API that validates fingerprint photos from the
[finger-scan-frontend](https://github.com/shayanAmarAli/finger-scan-frontend)
app and stores them in **private** Supabase Storage, with metadata in
Supabase PostgreSQL. Deployed on Railway.

> Status: repository created. Implementation starts in **Milestone 4**
> (see the frontend repo's `docs/MILESTONE_0_ANALYSIS.md`).

## Design decisions

- **No login.** The app opens, the user scans, and after validation the app
  uploads both images.
- **Anonymous submissions.** Each completed scan (left + right) is stored as
  a new submission with a generated ID; no personal data is collected.
- **Write-only API.** The app can only upload. There is no endpoint that
  returns images; they are readable only with the Supabase service role.
- **Protection:** `X-App-Key` header on every `/api/*` request, rate limiting,
  upload size limits, content (magic-byte) validation, private bucket, RLS
  with no public policies.
- **Image fidelity:** stored images are not resized, re-compressed or
  sharpened; location metadata is stripped without re-encoding.

## Planned API

| Method | Path | Body | Result |
|---|---|---|---|
| `GET` | `/health` | — | `{ "status": "ok" }` |
| `POST` | `/api/fingerprints/quality-check` | multipart: `image`, `hand` (`left`/`right`) | Quality diagnostics; **nothing is stored** |
| `POST` | `/api/submissions` | multipart: `left`, `right` | Validates both; stores both or neither; returns `{ "submissionId": "…" }` |

## Planned data model

- `fingerprint_submissions` — `id`, `status`, `app_version`, `created_at`
- `fingerprint_images` — `id`, `submission_id`, `hand` (CHECK left/right),
  `storage_path`, `mime_type`, `width`, `height`, `quality_status`,
  `quality_metrics`, `quality_version`, `created_at`;
  UNIQUE (`submission_id`, `hand`)

## Configuration

Copy `.env.example` to `.env` and fill in the values. Real credentials live
only in `.env` (local) and Railway / GitHub environment secrets.
