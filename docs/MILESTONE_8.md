# Milestone 8 — Security, testing and deployment (backend)

_Status: implemented and tested locally; CI runs on GitHub. Live deployment needs your Supabase + Railway accounts — see [DEPLOYMENT.md](DEPLOYMENT.md)._

## 1. Security

| Area | Implementation | File |
|---|---|---|
| Security headers | helmet: `default-src 'none'`, `frame-ancestors 'none'`, HSTS 1 year, `nosniff`, `no-referrer`, CORP same-origin, no `X-Powered-By` | `src/middleware/security.ts` |
| Caching | `Cache-Control: no-store` on all `/api` responses | same |
| CORS | **Not enabled** (mobile-only API) → browsers on other sites can't read responses; preflights aren't approved | same |
| Rate limiting | per client IP (real IP via `trust proxy` behind Railway): **30 req/min** on `/api/*`, **6 submissions/min**; applied **before** the app-key check (limits key guessing); 429 `rate_limited` + `Retry-After` | same, `src/app.ts` |
| Request timeouts | whole request 120 s, headers 30 s (slowloris), keep-alive 65 s | `src/lib/httpServer.ts` |
| Upstream timeouts | every Supabase call aborted after 20 s | `src/lib/supabase.ts` |
| Consent | `consent_version` **required** on submissions (400 `consent_required`), stored per submission | `src/routes/submissions.ts`, migration `…04` |
| Deletion requests | `npm run submission:delete -- 3F2A-9C1B` resolves the reference shown in the app (refuses if ambiguous) | `src/services/reference.ts`, `src/jobs/cli.ts` |
| Logs | no IPs, keys, bodies, image data (tested) | `test/security.test.ts` |
| Container | multi-stage Docker image, production deps only, runs as non-root `node` | `Dockerfile` |

All limits are environment variables (`RATE_LIMIT_*`, `SUBMIT_RATE_LIMIT_MAX`, `REQUEST_TIMEOUT_MS`, `SUPABASE_TIMEOUT_MS`).

## 2. Quality gates (CI — `.github/workflows/ci.yml`)

| Job | Steps | Blocks on |
|---|---|---|
| Lint, typecheck, test, build | `oxlint --deny-warnings`, `tsc --noEmit`, Vitest with coverage **thresholds** (statements/lines/functions 90 %, branches 80 %), `tsc` build, `npm audit --omit=dev --audit-level=high` | any failure |
| Secret scan | gitleaks over the full git history | any leaked secret |
| Production image smoke test | `docker build`, start container, `/health` 200, `/api/ping` 401 / 200 with key, `/health/ready` 503 without Supabase, security header present, not running as root | any failure |

Railway's **"Wait for CI"** setting makes deployment wait for these checks.

Linter: oxlint (ESLint-compatible rules). `typescript-eslint` doesn't support TypeScript 7 yet (peer `<6.1`).

## 3. Tests

| File | New tests | Covers |
|---|---:|---|
| `test/security.test.ts` | 14 | headers on success and errors; no CORS / preflight not approved; 429 after the limit with `Retry-After` + error shape; wrong-key requests count; separate budgets per client IP behind the proxy; `/health` never limited; logs contain no IP/key; config defaults; server timeouts; Supabase fetch aborts after the timeout and keeps the caller's signal |
| `test/submissions.api.test.ts` | 3 | missing / malformed consent → 400, nothing stored; accepted version recorded |
| `test/reference.test.ts` | 9 | reference parsing (dash, case, garbage); unique / ambiguous / unknown; **uuid range query on real PostgreSQL** selects exactly the prefix |
| `test/migrations.test.ts` | 1 (+1 updated) | `consent_version` stored and validated by the database |
| `test/adapters.test.ts` | 1 | repository range query |

### Results

| Check | Result |
|---|---|
| `npm run lint` | 0 warnings, 0 errors |
| `npm run typecheck` | no errors |
| `npm run test:coverage` | **189 passed**, 0 failed; statements 93.7 %, branches 85.9 %, functions 96.8 %, lines 95.2 % (thresholds met) |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Production build with **production dependencies only** (`npm ci --omit=dev`, `node dist/server.js`) | `/health` 200; no key → 401; headers present; **request 31 → 429** with `Retry-After: 60`; `/health/ready` 503 (no Supabase) |

## 4. Accepted risk

`npm audit` (all deps) reports 6 **high** in the **dev-only** test runner chain (`vitest` → `vite`/`tinyglobby` → `picomatch` ≤ 4.0.7, ReDoS on crafted glob patterns). No patched `picomatch` is published yet, npm's only "fix" is downgrading vitest 5 → 3, the globs are our own, and none of it is in the production image (CI audits `--omit=dev`). Re-check when `picomatch` 4.0.8+ ships.

## 5. Remaining

- Deployment itself (needs your Supabase project + Railway account): [DEPLOYMENT.md](DEPLOYMENT.md).
- Completed submissions are kept until deleted; automatic expiry after the retention period can be added once you decide it ([DATA_PROTECTION.md](DATA_PROTECTION.md)).
- Rate limits are per instance (in memory): keep one replica, or add a shared store (Redis) before scaling out.
