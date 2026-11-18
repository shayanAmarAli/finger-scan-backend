-- Milestone 6: upload of complete submissions (left + right).
--
--   * Idempotency: each upload request carries an Idempotency-Key; the key
--     is unique per submission, so retries and concurrent duplicates map to
--     ONE submission. request_hash detects a key reused for different data.
--   * Atomic completion: both image rows are inserted and the submission is
--     marked complete in a single function call (one transaction).
--   * storage_cleanup_queue: storage objects whose removal failed during a
--     rollback are recorded here and retried by the cleanup job.

alter table public.fingerprint_submissions
  add column idempotency_key text,
  add column request_hash text;

alter table public.fingerprint_submissions
  add constraint fingerprint_submissions_idempotency_key_format
    check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  add constraint fingerprint_submissions_request_hash_format
    check (request_hash is null or request_hash ~ '^[0-9a-f]{64}$'),
  add constraint fingerprint_submissions_idempotency_key_unique unique (idempotency_key);

create index fingerprint_submissions_pending_created_idx
  on public.fingerprint_submissions (created_at)
  where status = 'pending';

-- Retry queue for storage objects that must be deleted.
create table public.storage_cleanup_queue (
  id              bigint generated always as identity primary key,
  bucket          text not null,
  path            text not null check (char_length(path) between 1 and 512),
  reason          text not null check (char_length(reason) <= 200),
  attempts        integer not null default 0 check (attempts >= 0),
  last_error      text check (last_error is null or char_length(last_error) <= 500),
  next_attempt_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  constraint storage_cleanup_queue_unique_object unique (bucket, path)
);

alter table public.storage_cleanup_queue enable row level security;
revoke all on table public.storage_cleanup_queue from anon, authenticated;

-- Insert both images and mark the submission complete — all or nothing.
create or replace function public.complete_fingerprint_submission(
  p_submission_id uuid,
  p_images jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
  v_hands text[];
begin
  if jsonb_typeof(p_images) is distinct from 'array' then
    raise exception 'p_images must be a JSON array' using errcode = '22023';
  end if;

  select count(*), array_agg(i ->> 'hand' order by i ->> 'hand')
    into v_count, v_hands
    from jsonb_array_elements(p_images) as i;

  if v_count <> 2 or v_hands is distinct from array['left', 'right'] then
    raise exception 'exactly one left and one right image are required'
      using errcode = '22023';
  end if;

  update public.fingerprint_submissions
     set status = 'complete'
   where id = p_submission_id
     and status = 'pending';
  if not found then
    raise exception 'submission % is not pending', p_submission_id
      using errcode = 'P0002';
  end if;

  insert into public.fingerprint_images (
    submission_id, hand, storage_path, mime_type, width, height, size_bytes,
    quality_status, quality_metrics, quality_version
  )
  select p_submission_id,
         i ->> 'hand',
         i ->> 'storage_path',
         i ->> 'mime_type',
         (i ->> 'width')::integer,
         (i ->> 'height')::integer,
         (i ->> 'size_bytes')::integer,
         i ->> 'quality_status',
         coalesce(i -> 'quality_metrics', '{}'::jsonb),
         i ->> 'quality_version'
    from jsonb_array_elements(p_images) as i;
end;
$$;

revoke execute on function public.complete_fingerprint_submission(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_fingerprint_submission(uuid, jsonb)
  to service_role;
