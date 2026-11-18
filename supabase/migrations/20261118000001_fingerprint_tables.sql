-- Fingerprint submissions and images.
--
-- Product decisions (2026-11-18):
--   * No user accounts: each completed scan is an anonymous SUBMISSION with
--     exactly one left-hand and one right-hand image.
--   * Write-only API: only the backend (service role) touches these tables.
--     Row Level Security is enabled with NO policies, and table privileges
--     are revoked from the public Supabase roles (anon, authenticated).
--   * Image bytes live in the private Storage bucket "fingerprints"; the
--     database stores metadata and storage paths only.

create table public.fingerprint_submissions (
  id          uuid primary key default gen_random_uuid(),
  status      text not null default 'pending'
              check (status in ('pending', 'complete')),
  app_version text check (app_version is null or char_length(app_version) <= 50),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.fingerprint_submissions is
  'One anonymous scan (left + right hand). No personal data.';

create table public.fingerprint_images (
  id              uuid primary key default gen_random_uuid(),
  submission_id   uuid not null
                  references public.fingerprint_submissions (id) on delete cascade,
  hand            text not null check (hand in ('left', 'right')),
  storage_path    text not null unique
                  check (char_length(storage_path) between 1 and 512),
  mime_type       text not null check (mime_type in ('image/jpeg', 'image/png')),
  width           integer not null check (width > 0),
  height          integer not null check (height > 0),
  size_bytes      integer not null check (size_bytes > 0),
  quality_status  text not null
                  check (quality_status in ('passed', 'failed', 'not_checked')),
  quality_metrics jsonb not null default '{}'::jsonb
                  check (jsonb_typeof(quality_metrics) = 'object'),
  quality_version text check (quality_version is null or char_length(quality_version) <= 50),
  version         integer not null default 1 check (version >= 1),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- exactly one current image per submission and hand
  constraint fingerprint_images_one_per_hand unique (submission_id, hand)
);

comment on table public.fingerprint_images is
  'Metadata of one stored fingerprint photo; bytes are in storage bucket "fingerprints".';

-- updated_at maintenance
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger fingerprint_submissions_updated_at
  before update on public.fingerprint_submissions
  for each row execute function public.set_updated_at();

create trigger fingerprint_images_updated_at
  before update on public.fingerprint_images
  for each row execute function public.set_updated_at();

-- Lock down: RLS on, no policies → no access for anon / authenticated.
-- (The service role bypasses RLS and is used only by the backend.)
alter table public.fingerprint_submissions enable row level security;
alter table public.fingerprint_images enable row level security;

revoke all on table public.fingerprint_submissions from anon, authenticated;
revoke all on table public.fingerprint_images from anon, authenticated;
revoke execute on function public.set_updated_at() from anon, authenticated, public;
