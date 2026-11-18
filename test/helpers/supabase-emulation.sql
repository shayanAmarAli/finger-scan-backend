-- Minimal emulation of what a Supabase project provides BEFORE our
-- migrations run, so they can be tested in PGlite (real PostgreSQL, in
-- process). Mirrors the relevant Supabase defaults:
--   * roles anon / authenticated (public API) and service_role (BYPASSRLS)
--   * new tables in "public" are granted to all three roles by default
--     (this is why our migration must REVOKE explicitly)
--   * a "storage" schema with buckets/objects, RLS enabled on objects

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;

create schema storage;
grant usage on schema storage to anon, authenticated, service_role;

create table storage.buckets (
  id                 text primary key,
  name               text not null unique,
  public             boolean default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz default now()
);

create table storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets (id),
  name       text,
  created_at timestamptz default now()
);

alter table storage.objects enable row level security;
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;
