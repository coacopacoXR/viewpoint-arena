// An adoption carries the variant's positions into the main line — batch BV.
//
// `adopt_review_line` already moved the variant's cards and marked it adopted in one
// transaction, because half of either is worse than neither. The positions are the third
// half and the reason is the same: an adoption that moved the cards and left the main
// line's models standing where they were would open on the model the meeting had just
// taken, arranged the way the meeting had just decided against.
//
// This is a test of the SQL text, the way deploy/__tests__/reviewLinesSchema.test.ts
// tests the rest of the schema: there is no database in a test run, and what is worth
// pinning is that the statement is INSIDE the function — one transaction, one call from
// api/reviews/lines.ts — and that the drop has no counterpart of it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');

/** The schema with its `--` comments taken out, so an assertion cannot match prose. */
const SQL = readFileSync(join(REPO_ROOT, 'docs/supabase-schema.sql'), 'utf8')
  .split(/\r?\n/)
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

function between(from: string, to: string): string {
  const start = SQL.indexOf(from);
  expect(start, `no "${from}" in the schema`).toBeGreaterThanOrEqual(0);
  const end = SQL.indexOf(to, start + from.length);
  expect(end, `no "${to}" after "${from}"`).toBeGreaterThan(start);
  return SQL.slice(start, end);
}

const ADOPT = between(
  'create or replace function adopt_review_line',
  'create or replace function drop_review_line',
);
const DROP = between('create or replace function drop_review_line', 'do $$');

/** The SQL with runs of whitespace collapsed, so an assertion is not about indentation. */
function flat(sql: string): string {
  return sql.replace(/\s+/g, ' ');
}

describe('adopt_review_line — the positions travel with the cards', () => {
  it('copies the variant’s own slot into the main line’s, inside the same function', () => {
    // Inside `adopt_review_line` and not in a second request from api/reviews/lines.ts:
    // one function call is one transaction, and two requests would have a window between
    // them in which the review's cards say one thing and its scene says another.
    const body = flat(ADOPT);
    expect(body).toContain('update review_curations');
    expect(body).toContain("jsonb_set(");
    expect(body).toContain("'{placements}'");
    expect(body).toContain("asset -> 'linePlacements' -> v_variant.id::text");
  });

  it('writes the review the variant belongs to, and only that one', () => {
    expect(flat(ADOPT)).toContain('where id = v_variant.review_id');
  });

  it('writes only where the variant HAS a slot of its own', () => {
    // A variant that never diverged stands where the main line stands, so `placements`
    // already says it. Writing anyway would be a no-op that still bumped `updated_at`
    // and moved the review up the lobby's list.
    expect(flat(ADOPT)).toContain("and asset -> 'linePlacements' ? v_variant.id::text");
  });

  it('leaves the variant’s slot in place, as the record', () => {
    // The copy is a `jsonb_set` of one key, not a replacement of the asset and not a
    // removal of the slot: where the answer the review took had got to is still a fact
    // about the review, and a dropped variant keeps its own for the same reason.
    expect(flat(ADOPT)).not.toContain("'lineplacements'");
    expect(ADOPT).not.toMatch(/-\s*'?\{?linePlacements/);
  });

  it('is one transaction with the cards and the status', () => {
    const body = flat(ADOPT);
    expect(body).toContain('update tracker_items');
    expect(body).toContain("set status = 'adopted'");
    expect(body).toContain('update review_curations');
    // And all three come before the function answers, so there is no path through it
    // that writes two of the three.
    expect(body.indexOf('update tracker_items')).toBeLessThan(body.indexOf('update review_curations'));
    expect(body.indexOf('update review_curations')).toBeLessThan(body.indexOf("'ok', true"));
  });
});

describe('drop_review_line — a drop leaves the positions alone', () => {
  it('touches no review row at all', () => {
    // Dropping a variant is a decision about its cards and its status. Where its models
    // stood is the record of the answer the review did not take, and rewriting the main
    // line's positions from it would be adopting it.
    expect(DROP).not.toContain('review_curations');
    expect(DROP).not.toContain('linePlacements');
  });
});
