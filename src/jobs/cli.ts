/**
 * Admin commands (run on the server / with the service-role key; never
 * exposed over HTTP — the public API is write-only).
 *
 *   npm run cleanup                     # one cleanup pass
 *   npm run submission:delete -- <id>   # delete one submission completely
 */
import { loadConfig } from '../config/env.js';
import { supabaseSubmissionRepository } from '../db/submissionRepository.js';
import { createLogger } from '../lib/logger.js';
import { createSupabaseAdmin } from '../lib/supabase.js';
import { CleanupService, deleteSubmission } from '../services/cleanupService.js';
import { supabaseObjectStore } from '../storage/objectStore.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<number> {
  const [command, arg] = process.argv.slice(2);
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
    if (!arg || !UUID.test(arg)) {
      process.stderr.write('Usage: npm run submission:delete -- <submission-uuid>\n');
      return 1;
    }
    const deleted = await deleteSubmission({ repo, store, logger }, arg);
    process.stdout.write(deleted ? `Deleted ${arg}\n` : `Nothing to delete for ${arg}\n`);
    return 0;
  }
  process.stderr.write('Commands: cleanup | delete <submission-id>\n');
  return 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
