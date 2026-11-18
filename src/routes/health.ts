import { Router } from 'express';

import type { ReadinessProbe } from '../lib/supabase.js';

/**
 * - `GET /health`       liveness: the process is up (no dependencies).
 * - `GET /health/ready` readiness: database reachable AND storage bucket
 *   exists and is private. 503 otherwise, with per-check booleans only.
 */
export function healthRouter(readiness: ReadinessProbe, version: string): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ status: 'ok', version, uptimeSeconds: Math.round(process.uptime()) });
  });

  router.get('/ready', async (_req, res) => {
    const result = await readiness.check().catch(() => ({
      ok: false,
      checks: { database: false, storageBucket: false },
    }));
    res
      .status(result.ok ? 200 : 503)
      .json({ status: result.ok ? 'ready' : 'unavailable', checks: result.checks });
  });

  return router;
}
