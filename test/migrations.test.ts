import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Applies the real migrations to a real PostgreSQL (PGlite, in process) on
 * top of a minimal Supabase emulation, then checks constraints and access
 * control. Reproducible: each test group starts from an empty database
 * (one engine boot per group; tests only assert on rows they created).
 */
const root = join(import.meta.dirname, '..');
const migrationsDir = join(root, 'supabase', 'migrations');
const migrationFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const emulation = readFileSync(join(import.meta.dirname, 'helpers', 'supabase-emulation.sql'), 'utf8');

let db: PGlite;

async function migrate(target: PGlite) {
  await target.exec(emulation);
  for (const f of migrationFiles) {
    await target.exec(readFileSync(join(migrationsDir, f), 'utf8'));
  }
}

async function asRole<T>(role: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
  }
}

async function newSubmission(): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into public.fingerprint_submissions (app_version) values ('1.0.0') returning id`,
  );
  return r.rows[0]!.id;
}

function image(submissionId: string, hand: string, overrides: Record<string, unknown> = {}) {
  const row = {
    submission_id: submissionId,
    hand,
    storage_path: `${submissionId}/${hand}/${Math.random().toString(36).slice(2)}.jpg`,
    mime_type: 'image/jpeg',
    width: 3072,
    height: 4080,
    size_bytes: 1_500_000,
    quality_status: 'passed',
    quality_metrics: JSON.stringify({ ridgeDetail: 2.6 }),
    ...overrides,
  };
  const cols = Object.keys(row);
  return db.query(
    `insert into public.fingerprint_images (${cols.join(',')})
     values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning *`,
    Object.values(row),
  );
}

/** Fresh, migrated database for the enclosing describe block. */
function freshDatabase() {
  beforeAll(async () => {
    db = new PGlite();
    await migrate(db);
  });
  afterAll(async () => {
    await db.close();
  });
}

describe('migrations', () => {
  freshDatabase();
  it('apply cleanly to an empty database, in order', () => {
    expect(migrationFiles).toEqual([
      '20261118000001_fingerprint_tables.sql',
      '20261118000002_fingerprint_bucket.sql',
    ]);
  });

  it('create both tables with the expected columns', async () => {
    const cols = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'fingerprint_images'`,
    );
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(
      [
        'id', 'submission_id', 'hand', 'storage_path', 'mime_type', 'width', 'height',
        'size_bytes', 'quality_status', 'quality_metrics', 'quality_version', 'version',
        'created_at', 'updated_at',
      ].sort(),
    );
  });

  it('bucket migration is re-runnable and re-asserts private', async () => {
    await db.exec(`update storage.buckets set public = true where id = 'fingerprints'`);
    await db.exec(readFileSync(join(migrationsDir, migrationFiles[1]!), 'utf8'));
    const b = await db.query<{ public: boolean; file_size_limit: number; allowed_mime_types: string[] }>(
      `select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'fingerprints'`,
    );
    expect(b.rows).toEqual([
      { public: false, file_size_limit: 15728640, allowed_mime_types: ['image/jpeg', 'image/png'] },
    ]);
  });
});

describe('constraints', () => {
  freshDatabase();
  it('accepts a valid left + right image for one submission', async () => {
    const s = await newSubmission();
    await image(s, 'left');
    await image(s, 'right');
    const n = await db.query<{ n: number }>(
      `select count(*)::int n from public.fingerprint_images where submission_id = $1`,
      [s],
    );
    expect(n.rows[0]!.n).toBe(2);
  });

  it('rejects invalid hand values', async () => {
    const s = await newSubmission();
    for (const hand of ['LEFT', 'both', '', 'thumb']) {
      await expect(image(s, hand), hand).rejects.toThrow(/check constraint/);
    }
  });

  it('only one image per submission and hand', async () => {
    const s = await newSubmission();
    await image(s, 'left');
    await expect(image(s, 'left')).rejects.toThrow(/fingerprint_images_one_per_hand/);
  });

  it('same hand in different submissions is fine', async () => {
    await image(await newSubmission(), 'left');
    await image(await newSubmission(), 'left');
  });

  it('rejects unknown mime types, non-positive sizes, bad quality status', async () => {
    const s = await newSubmission();
    await expect(image(s, 'left', { mime_type: 'image/gif' })).rejects.toThrow(/check/);
    await expect(image(s, 'left', { width: 0 })).rejects.toThrow(/check/);
    await expect(image(s, 'left', { size_bytes: -1 })).rejects.toThrow(/check/);
    await expect(image(s, 'left', { quality_status: 'great' })).rejects.toThrow(/check/);
    await expect(image(s, 'left', { quality_metrics: '[1,2]' })).rejects.toThrow(/check/);
  });

  it('storage paths are unique', async () => {
    const s1 = await newSubmission();
    const s2 = await newSubmission();
    await image(s1, 'left', { storage_path: 'same/path.jpg' });
    await expect(image(s2, 'left', { storage_path: 'same/path.jpg' })).rejects.toThrow(/unique/);
  });

  it('images must belong to an existing submission', async () => {
    await expect(image('00000000-0000-0000-0000-000000000000', 'left')).rejects.toThrow(
      /foreign key/,
    );
  });

  it('deleting a submission deletes its image records', async () => {
    const s = await newSubmission();
    await image(s, 'left');
    await image(s, 'right');
    await db.query(`delete from public.fingerprint_submissions where id = $1`, [s]);
    const n = await db.query<{ n: number }>(
      `select count(*)::int n from public.fingerprint_images where submission_id = $1`,
      [s],
    );
    expect(n.rows[0]!.n).toBe(0);
  });

  it('updated_at is maintained on update; version defaults to 1', async () => {
    const s = await newSubmission();
    const row = (await image(s, 'left')).rows[0] as { id: string; version: number; updated_at: Date };
    expect(row.version).toBe(1);
    await db.exec(`select pg_sleep(0.01)`);
    const updated = await db.query<{ updated_at: Date }>(
      `update public.fingerprint_images set quality_status = 'failed' where id = $1 returning updated_at`,
      [row.id],
    );
    expect(updated.rows[0]!.updated_at.getTime()).toBeGreaterThan(row.updated_at.getTime());
  });
});

describe('access control (write-only API, no public access)', () => {
  freshDatabase();
  for (const role of ['anon', 'authenticated']) {
    it(`${role} cannot read or write fingerprint tables`, async () => {
      const s = await newSubmission();
      await image(s, 'left');
      await asRole(role, async () => {
        await expect(db.query(`select * from public.fingerprint_images`)).rejects.toThrow(
          /permission denied/,
        );
        await expect(db.query(`select * from public.fingerprint_submissions`)).rejects.toThrow(
          /permission denied/,
        );
        await expect(
          db.query(`insert into public.fingerprint_submissions default values`),
        ).rejects.toThrow(/permission denied/);
        await expect(db.query(`delete from public.fingerprint_images`)).rejects.toThrow(
          /permission denied/,
        );
      });
    });

    it(`${role} cannot read or upload objects in the private bucket`, async () => {
      await db.exec(
        `insert into storage.objects (bucket_id, name) values ('fingerprints', '${role}/left/a.jpg')`,
      );
      await asRole(role, async () => {
        const visible = await db.query(
          `select * from storage.objects where bucket_id = 'fingerprints'`,
        );
        expect(visible.rows).toHaveLength(0);
        await expect(
          db.query(
            `insert into storage.objects (bucket_id, name) values ('fingerprints', 'evil.jpg')`,
          ),
        ).rejects.toThrow(/row-level security/);
      });
    });
  }

  it('the migrations create no RLS policies (nothing is opened up)', async () => {
    const p = await db.query(`select * from pg_policies`);
    expect(p.rows).toHaveLength(0);
  });

  it('RLS is enabled on both tables', async () => {
    const r = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
       where relname in ('fingerprint_submissions', 'fingerprint_images') order by relname`,
    );
    expect(r.rows).toEqual([
      { relname: 'fingerprint_images', relrowsecurity: true },
      { relname: 'fingerprint_submissions', relrowsecurity: true },
    ]);
  });

  it('the service role (backend) can read and write', async () => {
    await asRole('service_role', async () => {
      const s = await db.query<{ id: string }>(
        `insert into public.fingerprint_submissions default values returning id`,
      );
      expect(s.rows).toHaveLength(1);
      const r = await db.query(`select * from public.fingerprint_submissions where id = $1`, [
        s.rows[0]!.id,
      ]);
      expect(r.rows).toHaveLength(1);
    });
  });
});
