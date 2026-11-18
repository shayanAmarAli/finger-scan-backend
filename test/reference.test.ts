import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseSubmissionRef, referenceRange, resolveSubmission } from '../src/services/reference.js';
import { InMemoryRepo } from './helpers/fakes.js';

describe('parseSubmissionRef', () => {
  it('accepts the short reference shown in the app, with or without dash, any case', () => {
    expect(parseSubmissionRef('3F2A-9C1B')).toEqual({ kind: 'reference', prefix: '3f2a9c1b' });
    expect(parseSubmissionRef(' 3f2a9c1b ')).toEqual({ kind: 'reference', prefix: '3f2a9c1b' });
  });

  it('accepts a full id', () => {
    expect(parseSubmissionRef('3F2A9C1B-0000-4000-8000-000000000001')).toEqual({
      kind: 'id',
      id: '3f2a9c1b-0000-4000-8000-000000000001',
    });
  });

  it.each(['', '3F2A', '3F2A-9C1', 'ZZZZ-ZZZZ', "3f2a9c1b'; drop table x"])('rejects %j', (v) => {
    expect(parseSubmissionRef(v)).toBeNull();
  });
});

describe('resolveSubmission', () => {
  let repo: InMemoryRepo;
  const add = (id: string) =>
    repo.createPending({ id, idempotencyKey: `k-${id}`, requestHash: 'h', appVersion: null, consentVersion: 'c1' });

  beforeEach(() => {
    repo = new InMemoryRepo();
  });

  it('unique reference → that submission', async () => {
    await add('3f2a9c1b-0000-4000-8000-000000000001');
    await add('aaaaaaaa-0000-4000-8000-000000000002');
    expect(await resolveSubmission(repo, '3F2A-9C1B')).toEqual({
      ok: true,
      id: '3f2a9c1b-0000-4000-8000-000000000001',
    });
  });

  it('two submissions share the reference → ambiguous, lists them (never deletes both)', async () => {
    await add('3f2a9c1b-0000-4000-8000-000000000001');
    await add('3f2a9c1b-1111-4000-8000-000000000002');
    const r = await resolveSubmission(repo, '3F2A-9C1B');
    expect(r).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(r.ok ? [] : r.matches).toHaveLength(2);
  });

  it('unknown reference / id → not_found; garbage → invalid', async () => {
    expect(await resolveSubmission(repo, '0000-0000')).toEqual({ ok: false, reason: 'not_found' });
    expect(await resolveSubmission(repo, '3f2a9c1b-0000-4000-8000-000000000001')).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await resolveSubmission(repo, 'nope')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('referenceRange on real PostgreSQL uuid ordering', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    const dir = join(import.meta.dirname, '..', 'supabase', 'migrations');
    await db.exec(readFileSync(join(import.meta.dirname, 'helpers', 'supabase-emulation.sql'), 'utf8'));
    for (const f of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
      await db.exec(readFileSync(join(dir, f), 'utf8'));
    }
  });
  afterAll(async () => {
    await db.close();
  });

  it('selects exactly the ids starting with the prefix', async () => {
    const ids = [
      '3f2a9c1a-ffff-4fff-bfff-ffffffffffff',
      '3f2a9c1b-0000-4000-8000-000000000000',
      '3f2a9c1b-ffff-4fff-bfff-ffffffffffff',
      '3f2a9c1c-0000-4000-8000-000000000000',
    ];
    for (const id of ids) await db.query('insert into public.fingerprint_submissions (id) values ($1)', [id]);
    const [from, to] = referenceRange('3f2a9c1b');
    const r = await db.query<{ id: string }>(
      'select id from public.fingerprint_submissions where id >= $1 and id <= $2 order by id',
      [from, to],
    );
    expect(r.rows.map((x) => x.id)).toEqual([ids[1], ids[2]]);
  });
});
