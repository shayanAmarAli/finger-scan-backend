-- Record which version of the consent text the user accepted before the
-- scan was taken (Milestone 8). The API requires it for new submissions;
-- the column is nullable only so the migration applies to existing rows.
-- The consent is tied to the anonymous submission — no personal data.

alter table public.fingerprint_submissions
  add column consent_version text
  check (consent_version is null or consent_version ~ '^[A-Za-z0-9._-]{1,50}$');

comment on column public.fingerprint_submissions.consent_version is
  'Version of the in-app consent text accepted before capture (e.g. consent-2026-11).';
