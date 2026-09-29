// docs/supabase-schema.sql — the two columns that make a meeting one record:
// who attended it, and its minutes.
//
// docs/plan/15-sessions-and-variants.md batch BM. install.sh re-applies this file
// on EVERY run, so an upgrade is exactly a second run of it: a column added
// unconditionally fails on the second run and takes the whole file down with it,
// which is why these tests parse the SQL as text and pin the invariants that make a
// re-run safe — the way reviewLinesSchema.test.ts does for batch BK's columns.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SCHEMA = readFileSync(join(REPO_ROOT, 'docs/supabase-schema.sql'), 'utf8');

/** The file with its `--` comments taken out, so an assertion cannot match prose. */
const SQL = SCHEMA.split(/\r?\n/)
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

const ADDED = [
  ['tracker_sessions', 'attendee_names text[]'],
  ['tracker_sessions', 'summary text'],
] as const;

describe('docs/supabase-schema.sql — who attended and the minutes', () => {
  it.each(ADDED)('adds %s.%s only if it is not there', (table, column) => {
    // The exact statement, newline and indentation included: `add column` without
    // `if not exists` is the one that fails on a re-run, and a test that matched a
    // looser form would not notice it being dropped.
    expect(SQL).toContain(`alter table ${table}\n  add column if not exists ${column};`);
  });

  it('adds each of them exactly once, so a re-run cannot add a second column', () => {
    for (const [, column] of ADDED) {
      const occurrences = SQL.split(`add column if not exists ${column};`).length - 1;
      expect(occurrences, `${column} added ${occurrences} times`).toBe(1);
    }
  });

  it('leaves both nullable, so a meeting recorded before this batch still reads', () => {
    for (const [, column] of ADDED) {
      expect(SQL).not.toContain(`add column if not exists ${column} not null`);
      expect(SQL).not.toContain(`add column if not exists ${column} default`);
    }
  });

  it('puts them beside the line columns batch BK added, not in a second place', () => {
    // Both batches write the same row: lib/trackerBridge inserts line_id, seq and
    // attendee_names in one statement, and the minutes land on the same row later.
    // A reader upgrading a database should find them together.
    const seq = SQL.indexOf('add column if not exists seq int;');
    const attendees = SQL.indexOf('add column if not exists attendee_names text[];');
    const summary = SQL.indexOf('add column if not exists summary text;');
    const cards = SQL.indexOf('create index if not exists tracker_items_line_idx');
    expect(seq).toBeGreaterThanOrEqual(0);
    expect(attendees).toBeGreaterThan(seq);
    expect(summary).toBeGreaterThan(attendees);
    expect(summary).toBeLessThan(cards);
  });

  it('does not backfill either column, because there is nothing to backfill from', () => {
    // A meeting recorded before this batch has no names stored anywhere and no
    // minutes that were ever written: participant_count is the fallback the session
    // panel already uses, and "No summary was stored for this session" is the truth
    // about it. An UPDATE here would be an invention.
    expect(SQL).not.toMatch(/update tracker_sessions[\s\S]{0,200}set attendee_names/);
    expect(SQL).not.toMatch(/update tracker_sessions[\s\S]{0,200}set summary/);
  });
});

describe('docs/supabase-schema.sql — still safe to apply twice', () => {
  it('adds every column conditionally', () => {
    for (const match of SQL.matchAll(/add column (?!if not exists)/g)) {
      expect.fail(`an unconditional add column: ${SQL.slice(match.index, (match.index ?? 0) + 80)}`);
    }
  });
});
