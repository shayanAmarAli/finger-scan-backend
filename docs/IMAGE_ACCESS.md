# Fetching uploaded images (owner only)

Added 2026-11-19. The app can show a person the fingerprint photos **they**
uploaded, fetched from the server. Nobody else can.

## Why a per-submission token

The shared `X-App-Key` is built into every APK and can be extracted. If it
could read images, anyone with the APK could download every fingerprint.
So reading needs a second secret that only the uploading phone has:

1. `POST /api/submissions` creates a random **access token** (32 bytes,
   base64url, 43 chars) and returns it once in `accessToken`. The database
   stores only its **SHA-256** (`fingerprint_submissions.access_token_hash`,
   migration `…05`), so a database leak doesn't reveal usable tokens.
2. A replay (same `Idempotency-Key` + same image bytes — only the uploader
   has both) issues a **new** token; the previous one stops working.
3. The app keeps `{submissionId, accessToken}` for its newest 5 uploads in
   app-private storage (excluded from backups). The token is never logged.

## Endpoint

```
GET /api/submissions/:ref/images
X-App-Key: <app key>
X-Submission-Token: <accessToken>
```

`:ref` = full id or the short reference shown in the app (`3F2A-9C1B`).

```json
200 {
  "submissionId": "…",
  "expiresInSeconds": 300,
  "images": [
    { "hand": "left",  "url": "https://…supabase.co/storage/v1/object/sign/…", "mimeType": "image/jpeg",
      "width": 1887, "height": 1512, "sizeBytes": 1278242, "qualityStatus": "passed" },
    { "hand": "right", "url": "…", … }
  ]
}
```

| Case | Response |
|---|---|
| Unknown id, wrong/missing token, unfinished upload, deleted | **the same** `404 not_found` (no probing which submissions exist) |
| Missing / wrong app key | `401` |
| Database or storage down | `503 service_unavailable` (no internals) |
| Too many requests | `429` (general /api limit; fetching does not use the upload limit) |

- The URLs are **signed, 5-minute** links to the private bucket. The bucket
  stays private; an expired link returns an error from storage.
- The app downloads them with a plain GET — the app key and the access
  token are **not** sent to the storage host.
- Tokens and signed URLs never appear in logs (tested).
- Submissions uploaded before this change have no token and can't be
  fetched (they still work for deletion).

## In the app

- Summary after upload → **View uploaded photos**.
- Intro screen → **View my last upload (XXXX-XXXX)** (when this phone uploaded before).
- Photos are held in memory only while the screen is open.
- If the server answers 404 (deleted), the receipt is forgotten.
