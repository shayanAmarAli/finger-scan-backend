-- Private storage bucket for fingerprint photos.
--
--   * public = false: objects have no public URL.
--   * No storage.objects policies are created for this bucket, so the
--     anon/authenticated roles can neither list, read, upload nor delete;
--     only the backend's service role can.
--   * Size and type limits are enforced by Storage as a second line of
--     defence (the API validates first).
--
-- Re-running this migration is safe and re-asserts the private setting.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'fingerprints',
  'fingerprints',
  false,
  15728640, -- 15 MiB
  array['image/jpeg', 'image/png']
)
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
