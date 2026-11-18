import type { SubmissionRepository } from '../db/submissionRepository.js';

/**
 * The app shows people a short reference for their submission: the first
 * 8 hex digits of its id, e.g. `3F2A-9C1B`. Deletion requests may quote
 * either that or the full id.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT = /^([0-9a-f]{4})-?([0-9a-f]{4})$/i;

export type ParsedRef = { kind: 'id'; id: string } | { kind: 'reference'; prefix: string };

export function parseSubmissionRef(input: string): ParsedRef | null {
  const value = input.trim();
  if (UUID.test(value)) return { kind: 'id', id: value.toLowerCase() };
  const m = SHORT.exec(value);
  if (m) return { kind: 'reference', prefix: `${m[1]}${m[2]}`.toLowerCase() };
  return null;
}

/** All UUIDs starting with [prefix] (8 hex digits) lie in this range. */
export function referenceRange(prefix: string): [string, string] {
  return [`${prefix}-0000-0000-0000-000000000000`, `${prefix}-ffff-ffff-ffff-ffffffffffff`];
}

export type Resolved =
  | { ok: true; id: string }
  | { ok: false; reason: 'invalid' | 'not_found' | 'ambiguous'; matches?: string[] };

/** Turns a reference or id into exactly one existing submission id. */
export async function resolveSubmission(
  repo: Pick<SubmissionRepository, 'exists' | 'idsWithPrefix'>,
  input: string,
): Promise<Resolved> {
  const ref = parseSubmissionRef(input);
  if (!ref) return { ok: false, reason: 'invalid' };
  if (ref.kind === 'id') {
    return (await repo.exists(ref.id)) ? { ok: true, id: ref.id } : { ok: false, reason: 'not_found' };
  }
  const matches = await repo.idsWithPrefix(ref.prefix, 10);
  if (matches.length === 0) return { ok: false, reason: 'not_found' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous', matches };
  return { ok: true, id: matches[0]! };
}
