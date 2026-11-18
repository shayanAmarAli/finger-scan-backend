/**
 * Admin commands (run on the server / with the service-role key; never
 * exposed over HTTP — the public API is write-only).
 *
 *   npm run cleanup                     # one cleanup pass
 *   npm run submission:delete -- <id | reference>
 *       delete one submission completely; accepts the full id or the
 *       short reference shown in the app (e.g. 3F2A-9C1B)
 */
import { loadConfig } from '../config/env.js';
import { supabaseSubmissionRepository } from '../db/submissionRepository.js';
import { createLogger } from '../lib/logger.js';
import { createSupabaseAdmin } from '../lib/supabase.js';
import { CleanupService, deleteSubmission } from '../services/cleanupService.js';
import { parseSubmissionRef, resolveSubmission } from '../services/reference.js';
import { supabaseObjectStore } from '../storage/objectStore.js';

async function main(): Promise<number> {
  const [command, arg] = process.argv.slice(2);
  if (command === 'delete' && (!arg || !parseSubmissionRef(arg))) {
    process.stderr.write('Usage: npm run submission:delete -- <submission-id | reference like 3F2A-9C1B>\n');
    return 1;
  }
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const supabase = createSupabaseAdmin(config);
  const repo = supabaseSubmissionRepository(supabase);
  const store = supabaseObjectStore(supabase, config.SUPABASE_STORAGE_BUCKET);

  if (command === 'cleanup') {
    const report = await new CleanupService({
      repo,
      store,
      bucket: config.SUPABASE_STORAGE_BUCKET,
      logger,
      staleAfterMs: config.STALE_AFTER_MS,
    }).run();
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.queueFailed > 0 ? 2 : 0;
  }
  if (command === 'delete') {
    const target = await resolveSubmission(repo, arg!);
    if (!target.ok) {
      if (target.reason === 'ambiguous') {
        process.stderr.write(
          `Reference matches ${target.matches!.length} submissions; use the full id:\n  ${target.matches!.join('\n  ')}\n`,
        );
        return 3;
      }
      process.stdout.write(`No submission found for ${arg}\n`);
      return 0;
    }
    const deleted = await deleteSubmission({ repo, store, logger }, target.id);
    process.stdout.write(deleted ? `Deleted ${target.id}\n` : `Nothing to delete for ${target.id}\n`);
    return 0;
  }
  process.stderr.write('Commands: cleanup | delete <submission-id | reference>\n');
  return 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
