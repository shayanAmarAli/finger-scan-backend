import {
  DatabaseError,
  DuplicateKeyError,
  type CleanupItem,
  type ImageRecord,
  type SubmissionRepository,
  type SubmissionRow,
} from '../../src/db/submissionRepository.js';
import { StorageError, type ObjectStore } from '../../src/storage/objectStore.js';

type Failure = Error | ((...args: unknown[]) => Error | undefined);

/** Optional failure injection: `fail.upload = new Error(...)` etc. */
class Faults<K extends string> {
  private readonly map = new Map<K, Failure>();
  set(method: K, failure: Failure, times = Infinity): void {
    let left = times;
    this.map.set(method, (...args: unknown[]) => {
      if (left <= 0) return undefined;
      const e = typeof failure === 'function' ? failure(...args) : failure;
      if (e) left--;
      return e;
    });
  }
  clear(method?: K): void {
    if (method) this.map.delete(method);
    else this.map.clear();
  }
  throwIfSet(method: K, ...args: unknown[]): void {
    const f = this.map.get(method);
    if (!f) return;
    const e = typeof f === 'function' ? f(...args) : f;
    if (e) throw e;
  }
}

/** In-memory database with the same guarantees as the real schema:
 *  unique idempotency key, one image per hand, atomic completion. */
export class InMemoryRepo implements SubmissionRepository {
  readonly submissions = new Map<
    string,
    { id: string; key: string; hash: string; status: 'pending' | 'complete'; appVersion: string | null; consentVersion: string | null; createdAt: Date }
  >();
  readonly images = new Map<string, ImageRecord[]>();
  readonly queue: (CleanupItem & { reason: string; nextAttemptAt: Date; lastError?: string })[] = [];
  readonly faults = new Faults<keyof SubmissionRepository>();
  private nextQueueId = 1;
  now: () => Date = () => new Date();

  async findByIdempotencyKey(key: string): Promise<SubmissionRow | null> {
    this.faults.throwIfSet('findByIdempotencyKey', key);
    for (const s of this.submissions.values()) {
      if (s.key === key) return { id: s.id, status: s.status, requestHash: s.hash, createdAt: s.createdAt };
    }
    return null;
  }

  async createPending(row: {
    id: string;
    idempotencyKey: string;
    requestHash: string;
    appVersion: string | null;
    consentVersion: string | null;
  }) {
    this.faults.throwIfSet('createPending', row);
    // Checked synchronously → atomic like a UNIQUE constraint.
    for (const s of this.submissions.values()) {
      if (s.key === row.idempotencyKey) throw new DuplicateKeyError('duplicate idempotency key');
    }
    this.submissions.set(row.id, {
      id: row.id,
      key: row.idempotencyKey,
      hash: row.requestHash,
      status: 'pending',
      appVersion: row.appVersion,
      consentVersion: row.consentVersion,
      createdAt: this.now(),
    });
  }

  async complete(id: string, images: ImageRecord[]) {
    this.faults.throwIfSet('complete', id, images);
    const s = this.submissions.get(id);
    if (!s || s.status !== 'pending') throw new DatabaseError('submission is not pending');
    const hands = images.map((i) => i.hand).sort();
    if (hands.join() !== 'left,right') throw new DatabaseError('exactly one left and one right image');
    this.images.set(id, images);
    s.status = 'complete';
  }

  async deletePending(id: string) {
    this.faults.throwIfSet('deletePending', id);
    if (this.submissions.get(id)?.status === 'pending') this.submissions.delete(id);
  }

  async delete(id: string) {
    this.faults.throwIfSet('delete', id);
    this.images.delete(id);
    return this.submissions.delete(id);
  }

  async exists(id: string) {
    return this.submissions.has(id);
  }

  async idsWithPrefix(prefix: string, limit: number) {
    return [...this.submissions.keys()]
      .filter((id) => id.startsWith(`${prefix}-`))
      .sort()
      .slice(0, limit);
  }

  async stalePending(olderThan: Date, limit: number) {
    return [...this.submissions.values()]
      .filter((s) => s.status === 'pending' && s.createdAt < olderThan)
      .slice(0, limit)
      .map((s) => s.id);
  }

  async enqueueCleanup(bucket: string, paths: string[], reason: string) {
    this.faults.throwIfSet('enqueueCleanup', paths);
    for (const path of paths) {
      if (this.queue.some((q) => q.bucket === bucket && q.path === path)) continue;
      this.queue.push({ id: this.nextQueueId++, bucket, path, attempts: 0, reason, nextAttemptAt: this.now() });
    }
  }

  async dueCleanup(limit: number, now: Date) {
    return this.queue.filter((q) => q.nextAttemptAt <= now).slice(0, limit).map(({ id, bucket, path, attempts }) => ({ id, bucket, path, attempts }));
  }

  async cleanupDone(id: number) {
    const i = this.queue.findIndex((q) => q.id === id);
    if (i >= 0) this.queue.splice(i, 1);
  }

  async cleanupFailed(id: number, error: string, nextAttemptAt: Date) {
    const q = this.queue.find((x) => x.id === id);
    if (q) Object.assign(q, { attempts: q.attempts + 1, lastError: error, nextAttemptAt });
  }

  /** Rows as the client would see them: complete submissions only. */
  completeIds(): string[] {
    return [...this.submissions.values()].filter((s) => s.status === 'complete').map((s) => s.id);
  }
}

/** In-memory private bucket: no overwrite, failure injection per call. */
export class InMemoryStore implements ObjectStore {
  readonly objects = new Map<string, { data: Buffer; contentType: string; createdAt: Date }>();
  readonly faults = new Faults<keyof ObjectStore>();
  now: () => Date = () => new Date();

  async upload(path: string, data: Buffer, contentType: string) {
    this.faults.throwIfSet('upload', path);
    if (this.objects.has(path)) throw new StorageError('The resource already exists');
    this.objects.set(path, { data: Buffer.from(data), contentType, createdAt: this.now() });
  }

  async remove(paths: string[]) {
    this.faults.throwIfSet('remove', paths);
    for (const p of paths) this.objects.delete(p);
  }

  async list(prefix: string) {
    this.faults.throwIfSet('list', prefix);
    return [...this.objects.keys()].filter((p) => p.startsWith(`${prefix}/`));
  }

  async listFolders(limit: number) {
    const folders = new Map<string, Date>();
    for (const [path, o] of this.objects) {
      const name = path.split('/')[0]!;
      const prev = folders.get(name);
      if (!prev || o.createdAt < prev) folders.set(name, o.createdAt);
    }
    return [...folders].slice(0, limit).map(([name, createdAt]) => ({ name, createdAt }));
  }

  paths(): string[] {
    return [...this.objects.keys()].sort();
  }
}
