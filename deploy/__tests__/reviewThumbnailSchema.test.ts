// docs/supabase-schema.sql — the column the lobby's snapshot lives in.
//
// docs/plan/15-sessions-and-variants.md batch BO. Parsed as text and pinned the way
// deploy/__tests__/reviewDeleteSchema.test.ts and reviewLinesSchema.test.ts pin theirs,
// because install.sh re-applies this whole file on every run: what makes the column safe
// is that applying it twice is a no-op, and that applying it to a database full of
// reviews changes nothing about any of them.
//
//   * `if not exists`, and only once — a second block would be a second opinion
//   * NULLABLE with NO DEFAULT, so every review that already exists keeps its row exactly
//     as it is and reads as "no snapshot yet", which is the state the lobby draws a
//     placeholder for
//   * plain `text`, because what goes in it is a JPEG data URL and Postgres has no type
//     for one; the size bound is lib/reviews/thumbnail.ts's, which refuses to write an
//     over-budget picture rather than asking the database to
//   * still writable by the published anon key, because the room captures the picture
//     with the browser's own key and there is no service-role path for it

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SCHEMA = readFileSync(join(REPO_ROOT, 'docs/supabase-schema.sql'), 'utf8');

/** The file with its `--` comments taken out, so an assertion cannot match prose. */
const SQL = SCHEMA.split(/\r?\n/)
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

/** The one statement that adds the column, whatever way it is laid out. */
const ADD_THUMBNAIL = /alter table review_curations\s+add column if not exists thumbnail text\s*;/g;

function matches(sql: string, pattern: RegExp): number {
  return (sql.match(pattern) ?? []).length;
}

describe('docs/supabase-schema.sql — review_curations.thumbnail', () => {
  it('is added with `if not exists`, so re-applying the file is a no-op', () => {
    expect(matches(SQL, ADD_THUMBNAIL)).toBe(1);
    expect(SQL).not.toMatch(/add column thumbnail/);
  });

  it('is nullable and has no default, so no existing review is rewritten by the upgrade', () => {
    expect(SQL).not.toMatch(/thumbnail text not null/);
    expect(SQL).not.toMatch(/thumbnail text[^;]*default/);
    expect(SQL).not.toMatch(/thumbnail (jsonb|bytea)/);
  });

  it('is part of review_curations and not of a table of its own', () => {
    // A separate table would be a join in every lobby read and a second thing to delete
    // in delete_review(); a column on the review is read by the query that already reads
    // the review, and goes with the row delete_review() already removes.
    expect(SQL).not.toContain('create table if not exists review_thumbnails');
  });

  it('comes after the owner/archived block and before the index on updated_at', () => {
    // Position is not cosmetic: this file is applied top to bottom, and a column has to
    // exist before anything orders or indexes on the table it was added to.
    const archived = SQL.indexOf('add column if not exists archived boolean not null default false');
    const thumbnail = SQL.search(ADD_THUMBNAIL);
    const index = SQL.indexOf('create index if not exists review_curations_updated_at_idx');
    expect(archived).toBeGreaterThanOrEqual(0);
    expect(thumbnail).toBeGreaterThan(archived);
    expect(index).toBeGreaterThan(thumbnail);
  });

  it('leaves the update policy a room needs to write its own snapshot', () => {
    // The capture in components/Scene/ThumbnailCapture.tsx runs in a browser with the
    // published anon key, so "public update curations" is what lets it write. Batch BN
    // removed the DELETE policy and left this one; a snapshot must not become the reason
    // to narrow it.
    expect(SQL).toContain('create policy "public update curations" on review_curations for update using (true)');
    // And the delete is still gone — adding a column is not a reason to bring it back.
    expect(SQL).not.toContain('create policy "public delete curations"');
  });

  it('is mentioned in the file’s own words as the lobby’s snapshot', () => {
    // The comment is checked against the RAW file, not the stripped one: a column nobody
    // can find the reason for is a column the next batch deletes.
    expect(SCHEMA).toMatch(/batch BO/);
    expect(SCHEMA.toLowerCase()).toMatch(/thumbnail/);
  });
});
