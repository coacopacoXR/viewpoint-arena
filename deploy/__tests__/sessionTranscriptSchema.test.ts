// docs/supabase-schema.sql — the column that keeps a meeting's transcript.
//
// docs/plan/15-sessions-and-variants.md batch BU. install.sh re-applies this file on
// EVERY run, so an upgrade is exactly a second run of it: a column added
// unconditionally fails on the second run and takes the whole file down with it,
// which is why these tests parse the SQL as text and pin the invariants that make a
// re-run safe — the way sessionRecordSchema.test.ts does for batch BM's two columns.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SCHEMA = readFileSync(join(REPO_ROOT, 'docs/supabase-schema.sql'), 'utf8');

/** The file with its `--` comments taken out, so an assertion cannot match prose. */
const SQL = SCHEMA.split(/\r?\n/)
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

const STATEMENT = 'alter table tracker_sessions\n  add column if not exists transcript jsonb;';

describe('docs/supabase-schema.sql — tracker_sessions.transcript', () => {
  it('adds the column only if it is not there', () => {
    // The exact statement, newline and indentation included: `add column` without
    // `if not exists` is the one that fails on a re-run, and a test that matched a
    // looser form would not notice it being dropped.
    expect(SQL).toContain(STATEMENT);
  });

  it('adds it exactly once, so a re-run cannot add a second column', () => {
    const occurrences = SQL.split('add column if not exists transcript jsonb;').length - 1;
    expect(occurrences).toBe(1);
  });

  it('leaves it nullable and without a default, so a meeting recorded before this batch still reads', () => {
    expect(SQL).not.toContain('add column if not exists transcript jsonb not null');
    expect(SQL).not.toContain('add column if not exists transcript jsonb default');
  });

  it('puts it beside the columns batch BM added, not in a second place', () => {
    // All three are written by the same INSERT in lib/trackerBridge and read by the
    // same session panel. A reader upgrading a database should find them together.
    const attendees = SQL.indexOf('add column if not exists attendee_names text[];');
    const summary = SQL.indexOf('add column if not exists summary text;');
    const transcript = SQL.indexOf('add column if not exists transcript jsonb;');
    const cards = SQL.indexOf('create index if not exists tracker_items_line_idx');
    expect(attendees).toBeGreaterThanOrEqual(0);
    expect(summary).toBeGreaterThan(attendees);
    expect(transcript).toBeGreaterThan(summary);
    expect(transcript).toBeLessThan(cards);
  });

  it('does not backfill it, because there is nothing to backfill from', () => {
    // A meeting recorded before this batch has no transcript anywhere: the audio died
    // with the browser that recorded it. An UPDATE here would be an invention, and a
    // transcript is the one column on this table where an invention would be read
    // aloud as what somebody said.
    expect(SQL).not.toMatch(/update tracker_sessions[\s\S]{0,200}set transcript/);
  });
});

describe('docs/supabase-schema.sql — still safe to apply twice', () => {
  it('adds every column conditionally', () => {
    for (const match of SQL.matchAll(/add column (?!if not exists)/g)) {
      expect.fail(`an unconditional add column: ${SQL.slice(match.index, (match.index ?? 0) + 80)}`);
    }
  });
});
