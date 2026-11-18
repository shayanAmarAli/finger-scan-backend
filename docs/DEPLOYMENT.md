# Deployment runbook — Supabase + Railway

Everything below that involves a real credential is done **by you** in the
Supabase / Railway / GitHub dashboards. No secret is ever written in the
repository, in chat or in the app's source code.

## 0. What you need

| Item | Where it ends up |
|---|---|
| Supabase project URL | Railway variable `SUPABASE_URL` |
| Supabase **service-role** (secret) key | Railway variable `SUPABASE_SERVICE_ROLE_KEY` — **server only** |
| `APP_API_KEY` (you generate it) | Railway variable **and** the app build (`--dart-define` or GitHub secret) |

Generate the app key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## 1. Supabase

1. supabase.com → **New project** (region close to your users; strong DB password, store it in a password manager).
2. **SQL Editor** → run each file in `supabase/migrations/` **in order** (`…01`, `…02`, `…03`, `…04`).
   Or with the CLI: `supabase link --project-ref <ref>` → `supabase db push`.
3. Check: **Storage** → bucket `fingerprints` exists and is **Private**.
4. **Project Settings → API**: copy the Project URL and the `service_role` key (keep the tab open for step 2).

## 2. Railway (backend)

1. railway.com → **New project → Deploy from GitHub repo** → `finger-scan-backend`
   (authorise the Railway GitHub app for this private repo).
2. Railway reads `railway.json`: builds the **Dockerfile**, health-checks
   `GET /health`, restarts on failure.
3. Service → **Variables** → add:
   ```
   SUPABASE_URL=<project URL>
   SUPABASE_SERVICE_ROLE_KEY=<service role key>
   APP_API_KEY=<generated key>
   NODE_ENV=production
   ```
   Optional (defaults are fine): `RATE_LIMIT_MAX`, `SUBMIT_RATE_LIMIT_MAX`,
   `REQUEST_TIMEOUT_MS`, `SUPABASE_TIMEOUT_MS`, `MAX_UPLOAD_BYTES`, `LOG_LEVEL`.
   `PORT` is set by Railway.
4. **Settings → Networking → Generate domain** → `https://<name>.up.railway.app`.
5. **Settings → Source → "Wait for CI"**: ON. Railway then deploys a commit
   only after the GitHub Actions checks pass — a failing test blocks deployment.
6. Keep **one replica** (`numReplicas: 1`): rate-limit counters are kept in
   memory per instance.

### Verify

```bash
curl https://<name>.up.railway.app/health         # {"status":"ok",...}
curl https://<name>.up.railway.app/health/ready   # {"status":"ready","checks":{"database":true,"storageBucket":true}}
curl -i https://<name>.up.railway.app/api/ping    # 401 (no key)
```

`/health/ready` = 503 means a Supabase variable is wrong or a migration is missing;
the response only says which check failed, never why (see the Railway logs).

## 3. App build

Either locally:

```bash
flutter build apk --release --split-per-abi \
  --dart-define=API_BASE_URL=https://<name>.up.railway.app \
  --dart-define=APP_API_KEY=<generated key> \
  --dart-define=CONSENT_ORG_NAME="..." --dart-define=CONSENT_PURPOSE="..." \
  --dart-define=CONSENT_RETENTION="..." --dart-define=CONSENT_CONTACT="..." \
  --dart-define=CONSENT_VERSION=consent-2026-11
```

or in GitHub (**finger-scan-frontend → Settings → Secrets and variables → Actions**):
secrets `API_BASE_URL`, `APP_API_KEY`; variables `CONSENT_*`. Every push to
`main` then builds the APKs (Actions → run → *finger-scan-apks* artifact).

Release builds accept only `https://` backends.

## 4. Rotating the app key

1. Generate a new key → set it in Railway (redeploys) → build and distribute
   a new APK with it.
2. Old installs then get "This version of the app is not allowed to upload.
   Please update the app." — their photos stay on the device.

Rotate the Supabase service-role key from Supabase → Project Settings → API
(→ update the Railway variable).

## 5. Operations

| Task | Command (Railway shell or locally with the production `.env`) |
|---|---|
| Delete one person's submission (they quote the reference shown in the app) | `npm run submission:delete -- 3F2A-9C1B` (or the full id) |
| One cleanup pass of failed-upload leftovers | `npm run cleanup` (also runs automatically every 10 min) |
| Logs | Railway → Deployments → Logs (JSON lines; no images, no keys) |
