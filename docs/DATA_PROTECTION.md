# Data protection: what is stored, where, for how long

Fingerprints are **biometric data**. In many jurisdictions (e.g. GDPR art. 9,
Pakistan's draft Personal Data Protection Bill, BIPA in Illinois) collecting
them needs explicit consent, a stated purpose and a retention limit. This
document describes what the system does; **the legal assessment for your
organisation and country is yours to make** (ideally with a lawyer).

## What is collected

| Data | Stored where | Personal? |
|---|---|---|
| Left + right fingertip photos (original quality, location metadata stripped) | Supabase Storage, private bucket `fingerprints` | Biometric |
| Image metadata: size, MIME type, quality metrics & version | Postgres `fingerprint_images` | No |
| Submission: random id, status, app version, **consent version**, timestamps, idempotency key + request hash, **SHA-256 of the access token** | Postgres `fingerprint_submissions` | No (anonymous) |
| Upload receipts (id + access token, newest 5) | Phone, app-private storage (no backup) | No |

Not collected: name, phone number, account, device id, location. Client IP
addresses are used in memory for rate limiting only; the application never
stores or logs them (tested). Note that Railway's own platform/edge logs
may record IPs — see Railway's data policies.

The system does **not** match, compare or identify fingerprints, and it
produces no fingerprint "scores": quality checks only measure photo
properties (format, resolution, exposure, sharpness).

## Consent

- Shown in the app **before the camera opens**, each time the scanner is
  opened from the start screen.
  Nothing is captured unless the person ticks the box and taps *Agree and
  continue*; *Not now* captures nothing.
- The text (purpose, organisation, retention, contact) is set at build time;
  a build without these values shows a visible *Draft text* notice.
- The server **refuses** submissions without a `consent_version` and stores
  the version with each submission, so you can show which text each person
  accepted.

## Protection

| Layer | Measure |
|---|---|
| Transport | HTTPS only (release app refuses `http://`; HSTS header) |
| API | Images can only be read by the app that uploaded them (per-submission access token + app key; 5-minute signed URLs; no list endpoint; unknown/wrong/unfinished all → the same 404); per-IP rate limits (30/min, 6 submissions/min); size and content validation; request timeouts |
| Storage | Private bucket; RLS on with no policies; table privileges revoked from `anon` / `authenticated`; only the server's service role can read |
| Logs | No image data, file names, keys or request bodies (tested) |
| Phone | App-private storage (not the gallery); **excluded from Android cloud backup and device transfer**; deleted after the server confirms the upload; at most 5 un-uploaded scans kept |
| Browsers | No CORS → other websites can't call the API |

## Retention

| Where | Rule |
|---|---|
| Phone | Deleted immediately after confirmed upload. Un-uploaded scans: newest 5 kept for retry, older ones deleted at the next scan; all removed on uninstall. |
| Server, failed uploads | Leftover files and pending rows removed automatically after 15 min (cleanup job). |
| Server, completed submissions | **Kept until deleted.** Set your retention period in the consent text and delete expired submissions (see below). Automatic expiry can be added once the period is decided. |

## Deletion requests

The person quotes the reference shown in the app (e.g. `3F2A-9C1B`):

```bash
npm run submission:delete -- 3F2A-9C1B
```

This deletes both images from Storage and the database rows. If two
submissions share the 8-digit reference (very unlikely), the command lists
both full ids and deletes nothing; ask for the date or use the full id.

## Breach basics

Rotate the service-role key (Supabase) and the app key (Railway + new APK),
review Supabase logs, and follow your notification obligations.
