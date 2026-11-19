-- Per-submission access token (2026-11-19).
--
-- The app may fetch the images of a submission it uploaded. The shared app
-- key is extractable from the APK, so it is NOT enough to read images:
-- every submission gets its own random access token, returned once to the
-- uploading app. Only its SHA-256 (hex) is stored here, so a database leak
-- does not reveal usable tokens.

alter table public.fingerprint_submissions
  add column access_token_hash text
  check (access_token_hash is null or access_token_hash ~ '^[0-9a-f]{64}$');

comment on column public.fingerprint_submissions.access_token_hash is
  'SHA-256 (hex) of the per-submission token the uploading app uses to fetch its images.';
