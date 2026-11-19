import type { SupabaseClient } from '@supabase/supabase-js';

/** Private object storage for fingerprint images. */
export interface ObjectStore {
  /** Uploads a new object; fails if the path already exists (no overwrite). */
  upload(path: string, data: Buffer, contentType: string): Promise<void>;
  /** Removes objects; succeeds for paths that don't exist. */
  remove(paths: string[]): Promise<void>;
  /** Object paths under a folder (e.g. a submission id). */
  list(prefix: string): Promise<string[]>;
  /** Time-limited download URL for a private object. */
  signedUrl(path: string, expiresInSeconds: number): Promise<string>;
  /** Top-level folders with the time their oldest object was created. */
  listFolders(limit: number): Promise<{ name: string; createdAt: Date | null }[]>;
}

export class StorageError extends Error {
  override name = 'StorageError';
}

/** Supabase Storage implementation (service role; bucket is private). */
export function supabaseObjectStore(client: Pick<SupabaseClient, 'storage'>, bucket: string): ObjectStore {
  const b = () => client.storage.from(bucket);
  return {
    async upload(path, data, contentType) {
      const { error } = await b().upload(path, data, {
        contentType,
        upsert: false,
        cacheControl: 'no-store',
      });
      if (error) throw new StorageError(`upload failed: ${error.message}`);
    },
    async remove(paths) {
      if (paths.length === 0) return;
      const { error } = await b().remove(paths);
      if (error) throw new StorageError(`remove failed: ${error.message}`);
    },
    async signedUrl(path, expiresInSeconds) {
      const { data, error } = await b().createSignedUrl(path, expiresInSeconds);
      if (error || !data?.signedUrl) throw new StorageError(`sign failed: ${error?.message ?? 'no url'}`);
      return data.signedUrl;
    },
    async list(prefix) {
      const { data, error } = await b().list(prefix, { limit: 100 });
      if (error) throw new StorageError(`list failed: ${error.message}`);
      return (data ?? []).filter((o) => o.id !== null).map((o) => `${prefix}/${o.name}`);
    },
    async listFolders(limit) {
      const { data, error } = await b().list('', { limit, sortBy: { column: 'name', order: 'asc' } });
      if (error) throw new StorageError(`list failed: ${error.message}`);
      // Folders are returned with id === null; their age is taken from the
      // oldest object inside.
      const folders = (data ?? []).filter((o) => o.id === null).map((o) => o.name);
      const out: { name: string; createdAt: Date | null }[] = [];
      for (const name of folders) {
        const { data: files } = await b().list(name, { limit: 10 });
        const times = (files ?? [])
          .map((f) => (f.created_at ? new Date(f.created_at).getTime() : NaN))
          .filter((t) => !Number.isNaN(t));
        out.push({ name, createdAt: times.length ? new Date(Math.min(...times)) : null });
      }
      return out;
    },
  };
}
