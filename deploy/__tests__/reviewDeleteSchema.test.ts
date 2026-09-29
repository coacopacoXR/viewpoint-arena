// docs/supabase-schema.sql — deleting a design review, and deleting one of its
// sessions.
//
// docs/plan/15-sessions-and-variants.md batch BN. These tests parse the file as text
// and pin the invariants that make the delete safe, the way
// deploy/__tests__/reviewLinesSchema.test.ts does for adopting and dropping a variant:
//
//   * both removals are ONE function each, so the tables cannot disagree about whether
//     the review exists — a curation row gone and its meetings left is a tracker full
//     of cards no review can be opened on
//   * both are `security definer` and executable by the service role ALONE, because
//     EXECUTE goes to PUBLIC by default on a new function and the table-level grants
//     further down the file do not cover functions
//   * the published anon key can no longer delete a review_curations row: the policy is
//     gone AND the table grant is taken back after the block that hands it out
//   * the order of the deletes respects review_lines.parent_session_id, which is a
//     foreign key to tracker_sessions(id)
//   * a session a variant leaves from is refused, session numbers are never renumbered,
//     and stored model FILES are never removed

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SCHEMA = readFileSync(join(REPO_ROOT, 'docs/supabase-schema.sql'), 'utf8');

/** The file with its `--` comments taken out, so an assertion cannot match prose. */
const SQL = SCHEMA.split(/\r?\n/)
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

const DELETE_REVIEW = SQL.slice(
  SQL.indexOf('create or replace function delete_review('),
  SQL.indexOf('create or replace function delete_review_session('),
);
const DELETE_SESSION = SQL.slice(
  SQL.indexOf('create or replace function delete_review_session('),
  SQL.indexOf('revoke all on function public.delete_review(text)'),
);

// ─── The two functions ──────────────────────────────────────────────────────

describe('docs/supabase-schema.sql — deleting a design review', () => {
  it('creates both with `or replace`, so a re-run cannot fail', () => {
    expect(SQL).toContain('create or replace function delete_review(p_review text) returns jsonb');
    expect(SQL).toContain('create or replace function delete_review_session(p_session uuid) returns jsonb');
    expect(SQL).not.toMatch(/create function (?:public\.)?delete_review/);
  });

  it('runs as its owner, with a fixed search path, and cannot be reached by the browser', () => {
    // EXECUTE goes to PUBLIC by default on a new function, so without these revokes the
    // anon key the browser is built with could delete any review on the install.
    for (const signature of ['delete_review(text)', 'delete_review_session(uuid)']) {
      expect(SQL).toContain(`revoke all on function public.${signature} from public, anon, authenticated`);
      expect(SQL).toContain(`grant execute on function public.${signature} to service_role`);
    }
    for (const body of [DELETE_REVIEW, DELETE_SESSION]) {
      expect(body).toContain('security definer');
      // A definer function with no search_path is one that can be hijacked by a schema
      // an attacker created first.
      expect(body).toContain('set search_path = public');
    }
  });

  it('takes the whole review: cards and their history, meetings, lines, roster, revisions and the row', () => {
    expect(DELETE_REVIEW).toContain('delete from tracker_status_history');
    expect(DELETE_REVIEW).toContain('delete from tracker_items where review_id = p_review');
    expect(DELETE_REVIEW).toContain('delete from tracker_sessions where review_id = p_review');
    expect(DELETE_REVIEW).toContain('delete from review_lines where review_id = p_review');
    expect(DELETE_REVIEW).toContain('delete from review_members where review_id = p_review');
    expect(DELETE_REVIEW).toContain('delete from model_revisions where review_id = p_review');
    expect(DELETE_REVIEW).toContain('delete from review_curations where id = p_review');
  });

  it('deletes the status history of the cards it is about to delete, not of every card', () => {
    expect(DELETE_REVIEW).toContain(
      'where item_id in (select id from tracker_items where review_id = p_review)',
    );
  });

  it('deletes the lines BEFORE the meetings, because a line points at one', () => {
    // review_lines.parent_session_id references tracker_sessions(id). The other order
    // is refused by the key, which rolls the whole function back and deletes nothing —
    // so the order is not a style choice, it is whether the delete works at all.
    expect(DELETE_REVIEW.indexOf('delete from review_lines')).toBeLessThan(
      DELETE_REVIEW.indexOf('delete from tracker_sessions'),
    );
  });

  it('says so when the review is not there, rather than answering as though it had removed one', () => {
    expect(DELETE_REVIEW).toContain("select exists (select 1 from review_curations where id = p_review)");
    expect(DELETE_REVIEW).toContain("'error', 'no_such_review'");
  });

  it('never touches a stored model file, which another review may be showing', () => {
    // A file in model storage is content-addressed — model_revisions.hash is its name —
    // so the same bytes can be two reviews' Rev B. The rows go; the files stay.
    expect(DELETE_REVIEW).not.toMatch(/storage|delete from model_files|vault|bucket/i);
    expect(DELETE_REVIEW).toContain('delete from model_revisions where review_id = p_review');
  });

  it('leaves the record of who took part, which belongs to the person and not to the review', () => {
    // review_participants is "the reviews I have been part of", keyed on the person.
    expect(DELETE_REVIEW).not.toContain('review_participants');
  });
});

describe('docs/supabase-schema.sql — deleting one session', () => {
  it('takes the meeting and the cards raised in it, with their history', () => {
    expect(DELETE_SESSION).toContain('delete from tracker_status_history');
    expect(DELETE_SESSION).toContain('delete from tracker_items where session_id = p_session');
    expect(DELETE_SESSION).toContain('delete from tracker_sessions where id = p_session');
  });

  it('refuses a session a variant leaves from, which is what the map draws it from', () => {
    expect(DELETE_SESSION).toContain('from review_lines');
    expect(DELETE_SESSION).toContain('where parent_session_id = p_session');
    expect(DELETE_SESSION).toContain("'error', 'variant_starts_here'");
    // The refusal has to be checked BEFORE anything is removed, or the delete has
    // already happened by the time the answer says it did not.
    expect(DELETE_SESSION.indexOf("'error', 'variant_starts_here'")).toBeLessThan(
      DELETE_SESSION.indexOf('delete from tracker_items'),
    );
  });

  it('says so when the session is not there', () => {
    expect(DELETE_SESSION).toContain("select exists (select 1 from tracker_sessions where id = p_session)");
    expect(DELETE_SESSION).toContain("'error', 'no_such_session'");
  });

  it('never renumbers the sessions after it, so a card keeps saying where it was raised', () => {
    // tracker_sessions.seq is the number in the label the map and the tracker show.
    // Renumbering would silently change what every card raised after the deleted
    // meeting claims about itself.
    expect(DELETE_SESSION).not.toContain('seq');
    expect(DELETE_SESSION).not.toContain('row_number()');
    expect(DELETE_SESSION).not.toContain('update tracker_sessions');
  });

  it('never deletes a line: a variant is dropped or adopted, not removed', () => {
    expect(DELETE_SESSION).not.toContain('delete from review_lines');
  });
});

// ─── The old path, locked ───────────────────────────────────────────────────

describe('docs/supabase-schema.sql — the browser can no longer delete a review', () => {
  it('drops the public delete policy on review_curations and never re-creates it', () => {
    // install.sh re-applies this whole file on every run, so the drop is what takes the
    // policy away from an install being upgraded.
    expect(SQL).toContain('drop policy if exists "public delete curations" on review_curations');
    expect(SQL).not.toContain('create policy "public delete curations"');
    expect(SQL).not.toContain('on review_curations for delete');
  });

  it('keeps the read, insert and update policies a room needs', () => {
    // A 'none' install writes its curation rows with the anon key, and every room reads
    // its own. Only the delete is gone.
    for (const name of ['public read curations', 'public insert curations', 'public update curations']) {
      expect(SQL).toContain(`create policy "${name}"`);
    }
  });

  it('revokes DELETE on the table after the block that grants on every table', () => {
    // `grant … on all tables in schema public` is evaluated when it runs, and a table
    // grant is checked BEFORE row level security — so without this revoke the missing
    // policy would be the only thing between the published anon key and every design
    // review on the install. Same position and same reasoning as review_lines'.
    const grants = SQL.indexOf('grant select, insert, update, delete on all tables in schema public');
    const revoke = SQL.indexOf('revoke delete on public.review_curations from anon, authenticated');
    expect(grants).toBeGreaterThanOrEqual(0);
    expect(revoke).toBeGreaterThan(grants);
    // Select, insert and update stay, so this is a `revoke delete` and not a `revoke all`.
    expect(SQL).not.toContain('revoke all on public.review_curations');
  });

  it('still revokes app_settings last, after both of the new revokes', () => {
    const grants = SQL.indexOf('grant select, insert, update, delete on all tables in schema public');
    const curations = SQL.indexOf('revoke delete on public.review_curations from anon, authenticated');
    const settings = SQL.indexOf('revoke all on public.app_settings from anon, authenticated');
    expect(curations).toBeGreaterThan(grants);
    expect(settings).toBeGreaterThan(curations);
  });

  it('creates both functions before the block that grants on every table', () => {
    // Not because the grant covers functions — it does not — but because this file is
    // applied top to bottom and a function that references a table has to come after it.
    const grants = SQL.indexOf('grant select, insert, update, delete on all tables in schema public');
    expect(SQL.indexOf('create or replace function delete_review(')).toBeLessThan(grants);
    expect(SQL.indexOf('create or replace function delete_review_session(')).toBeLessThan(grants);
  });
});
