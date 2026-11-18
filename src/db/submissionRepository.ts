import type { SupabaseClient } from '@supabase/supabase-js';

export type SubmissionStatus = 'pending' | 'complete';

export interface SubmissionRow {
  id: string;
  status: SubmissionStatus;
  requestHash: string | null;
  createdAt: Date;
}

export interface ImageRecord {
  hand: 'left' | 'right';
  storage_path: string;
  mime_type: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
  size_bytes: number;
  quality_status: 'passed' | 'failed' | 'not_checked';
  quality_metrics: Record<string, unknown>;
  quality_version: string;
}

export interface CleanupItem {
  id: number;
  bucket: string;
  path: string;
  attempts: number;
}

/** Database operations for submissions. */
export interface SubmissionRepository {
  findByIdempotencyKey(key: string): Promise<SubmissionRow | null>;
  /** Inserts a pending submission; throws [DuplicateKeyError] if the
   *  idempotency key is already used. */
  createPending(row: { id: string; idempotencyKey: string; requestHash: string; appVersion: string | null }): Promise<void>;
  /** Inserts both image records and marks the submission complete,
   *  atomically (database function). */
  complete(id: string, images: ImageRecord[]): Promise<void>;
  /** Deletes a submission still pending (rollback). */
  deletePending(id: string): Promise<void>;
  /** Deletes a submission and (cascade) its image records. */
  delete(id: string): Promise<boolean>;
  exists(id: string): Promise<boolean>;
  stalePending(olderThan: Date, limit: number): Promise<string[]>;

  enqueueCleanup(bucket: string, paths: string[], reason: string): Promise<void>;
  dueCleanup(limit: number, now: Date): Promise<CleanupItem[]>;
  cleanupDone(id: number): Promise<void>;
  cleanupFailed(id: number, error: string, nextAttemptAt: Date): Promise<void>;
}

export class DuplicateKeyError extends Error {
  override name = 'DuplicateKeyError';
}

export class DatabaseError extends Error {
  override name = 'DatabaseError';
}

type PgError = { code?: string; message: string } | null;

function check(error: PgError, what: string): void {
  if (!error) return;
  if (error.code === '23505') throw new DuplicateKeyError(`${what}: duplicate key`);
  throw new DatabaseError(`${what}: ${error.message}`);
}

/** Supabase (PostgREST) implementation using the service-role client. */
export function supabaseSubmissionRepository(client: Pick<SupabaseClient, 'from' | 'rpc'>): SubmissionRepository {
  const submissions = () => client.from('fingerprint_submissions');
  const queue = () => client.from('storage_cleanup_queue');
  return {
    async findByIdempotencyKey(key) {
      const { data, error } = await submissions()
        .select('id,status,request_hash,created_at')
        .eq('idempotency_key', key)
        .maybeSingle();
      check(error, 'find submission');
      if (!data) return null;
      return {
        id: data.id,
        status: data.status,
        requestHash: data.request_hash,
        createdAt: new Date(data.created_at),
      };
    },
    async createPending({ id, idempotencyKey, requestHash, appVersion }) {
      const { error } = await submissions().insert({
        id,
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
        app_version: appVersion,
        status: 'pending',
      });
      check(error, 'create submission');
    },
    async complete(id, images) {
      const { error } = await client.rpc('complete_fingerprint_submission', {
        p_submission_id: id,
        p_images: images,
      });
      check(error, 'complete submission');
    },
    async deletePending(id) {
      const { error } = await submissions().delete().eq('id', id).eq('status', 'pending');
      check(error, 'delete pending submission');
    },
    async delete(id) {
      const { data, error } = await submissions().delete().eq('id', id).select('id');
      check(error, 'delete submission');
      return (data ?? []).length > 0;
    },
    async exists(id) {
      const { count, error } = await submissions().select('id', { head: true, count: 'exact' }).eq('id', id);
      check(error, 'check submission');
      return (count ?? 0) > 0;
    },
    async stalePending(olderThan, limit) {
      const { data, error } = await submissions()
        .select('id')
        .eq('status', 'pending')
        .lt('created_at', olderThan.toISOString())
        .limit(limit);
      check(error, 'list stale submissions');
      return (data ?? []).map((r) => r.id as string);
    },
    async enqueueCleanup(bucket, paths, reason) {
      if (paths.length === 0) return;
      const { error } = await queue().upsert(
        paths.map((path) => ({ bucket, path, reason })),
        { onConflict: 'bucket,path', ignoreDuplicates: true },
      );
      check(error, 'enqueue cleanup');
    },
    async dueCleanup(limit, now) {
      const { data, error } = await queue()
        .select('id,bucket,path,attempts')
        .lte('next_attempt_at', now.toISOString())
        .order('next_attempt_at')
        .limit(limit);
      check(error, 'list cleanup queue');
      return (data ?? []) as CleanupItem[];
    },
    async cleanupDone(id) {
      const { error } = await queue().delete().eq('id', id);
      check(error, 'remove cleanup item');
    },
    async cleanupFailed(id, message, nextAttemptAt) {
      const { data, error: readError } = await queue().select('attempts').eq('id', id).maybeSingle();
      check(readError, 'read cleanup item');
      const { error } = await queue()
        .update({
          attempts: ((data?.attempts as number | undefined) ?? 0) + 1,
          last_error: message.slice(0, 500),
          next_attempt_at: nextAttemptAt.toISOString(),
        })
        .eq('id', id);
      check(error, 'update cleanup item');
    },
  };
}
