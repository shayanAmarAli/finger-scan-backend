import type { SubmissionRepository } from '../db/submissionRepository.js';
import type { Logger } from '../lib/logger.js';
import type { ObjectStore } from '../storage/objectStore.js';

export interface CleanupDeps {
  repo: SubmissionRepository;
  store: ObjectStore;
  bucket: string;
  logger: Logger;
  /** Pending submissions / unreferenced objects older than this are removed. */
  staleAfterMs?: number;
  now?: () => Date;
}

export interface CleanupReport {
  queueRemoved: number;
  queueFailed: number;
  stalePendingRemoved: number;
  orphanFoldersRemoved: number;
}

/**
 * Retryable cleanup of storage objects and submissions left behind by
 * failures. Safe to run repeatedly and concurrently with uploads:
 *
 * 1. Cleanup queue: remove each queued object; on failure retry later with
 *    exponential backoff (1 min → 2 → 4 … capped at 6 h).
 * 2. Stale pending submissions (crash between steps): remove their objects,
 *    then the row.
 * 3. Orphan folders: storage folders whose submission row does not exist,
 *    older than the grace period (so in-flight uploads are never touched).
 */
export class CleanupService {
  private readonly staleAfterMs: number;
  private readonly now: () => Date;

  constructor(private readonly deps: CleanupDeps) {
    this.staleAfterMs = deps.staleAfterMs ?? 15 * 60_000;
    this.now = deps.now ?? (() => new Date());
  }

  async run(batch = 100): Promise<CleanupReport> {
    const report: CleanupReport = { queueRemoved: 0, queueFailed: 0, stalePendingRemoved: 0, orphanFoldersRemoved: 0 };
    await this.processQueue(batch, report);
    await this.removeStalePending(batch, report);
    await this.removeOrphanFolders(batch, report);
    this.deps.logger.info('cleanup finished', { ...report });
    return report;
  }

  private async processQueue(batch: number, report: CleanupReport) {
    const { repo, store } = this.deps;
    const now = this.now();
    for (const item of await repo.dueCleanup(batch, now)) {
      try {
        await store.remove([item.path]);
        await repo.cleanupDone(item.id);
        report.queueRemoved++;
      } catch (e) {
        const delayMs = Math.min(60_000 * 2 ** item.attempts, 6 * 3_600_000);
        await repo.cleanupFailed(item.id, e instanceof Error ? e.message : String(e), new Date(now.getTime() + delayMs));
        report.queueFailed++;
      }
    }
  }

  private async removeStalePending(batch: number, report: CleanupReport) {
    const { repo, store } = this.deps;
    const cutoff = new Date(this.now().getTime() - this.staleAfterMs);
    for (const id of await repo.stalePending(cutoff, batch)) {
      try {
        await store.remove(await store.list(id));
        await repo.deletePending(id);
        report.stalePendingRemoved++;
      } catch (e) {
        this.deps.logger.warn('stale submission not removed yet', {
          submissionId: id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  private async removeOrphanFolders(batch: number, report: CleanupReport) {
    const { repo, store } = this.deps;
    const cutoff = this.now().getTime() - this.staleAfterMs;
    for (const folder of await store.listFolders(batch)) {
      if (!folder.createdAt || folder.createdAt.getTime() > cutoff) continue; // grace period
      if (await repo.exists(folder.name)) continue;
      try {
        await store.remove(await store.list(folder.name));
        report.orphanFoldersRemoved++;
      } catch {
        await repo.enqueueCleanup(this.deps.bucket, await store.list(folder.name).catch(() => []), 'orphan folder');
      }
    }
  }
}

/**
 * Deletes one submission completely: storage objects first, then the
 * database row (image records cascade). Idempotent — safe to repeat after a
 * partial failure. Returns false if there was nothing to delete.
 */
export async function deleteSubmission(
  deps: Pick<CleanupDeps, 'repo' | 'store' | 'logger'>,
  id: string,
): Promise<boolean> {
  const objects = await deps.store.list(id);
  await deps.store.remove(objects); // throws → row kept, retry later
  const deleted = await deps.repo.delete(id);
  deps.logger.info('submission deleted', { submissionId: id, objects: objects.length, row: deleted });
  return deleted || objects.length > 0;
}
