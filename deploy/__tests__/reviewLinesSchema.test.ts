// docs/supabase-schema.sql — review_lines, and the backfill that gives every review
// that has met a main line.
//
// docs/plan/15-sessions-and-variants.md batch BK. install.sh re-applies this file on
// EVERY run, so an upgrade is exactly a second run of it: a statement that is not
// idempotent does not fail loudly at install time, it fails on somebody's database
// six weeks later with a duplicate key or a half-renumbered history. These tests parse
// the file as text and pin the invariants that make a re-run safe, the way
// deploy/__tests__/databaseLayer.test.ts and identityLayer.test.ts do for theirs.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SCHEMA = readFileSync(join(REPO_ROOT, 'docs/supabase-schema.sql'), 'utf8');

/** The file with its `--` comments taken out, so an assertion cannot match prose. */
const SQL = SCHEMA.split(/\r?\n/)
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

/** Everything from a marker to the next section rule, with comments stripped. */
function section(marker: string): string {
  const start = SQL.indexOf(marker);
  expect(start, `no "${marker}" in the schema`).toBeGreaterThanOrEqual(0);
  return SQL.slice(start);
}

const LINES_TABLE = SQL.slice(
  SQL.indexOf('create table if not exists review_lines'),
  SQL.indexOf('create index if not exists review_lines_review_idx'),
);

// ─── The table ──────────────────────────────────────────────────────────────

describe('docs/supabase-schema.sql — review_lines', () => {
  it('creates the table only if it is not there, so a re-run cannot fail', () => {
    expect(SQL).toContain('create table if not exists review_lines');
  });

  it('allows exactly two kinds of line and three fates, both as checks', () => {
    expect(LINES_TABLE).toContain("kind text not null check (kind in ('main', 'variant'))");
    expect(LINES_TABLE).toContain("status text not null default 'active' check (status in ('active', 'adopted', 'dropped'))");
  });

  it('keeps a variant\'s letter, its parent session and who started it', () => {
    expect(LINES_TABLE).toContain('letter text');
    expect(LINES_TABLE).toContain('parent_session_id uuid references tracker_sessions(id)');
    expect(LINES_TABLE).toContain('created_by uuid');
    expect(LINES_TABLE).toContain('created_by_name text');
    expect(LINES_TABLE).toContain('closed_at timestamptz');
  });

  it('stops two variants of one review being the same letter', () => {
    expect(LINES_TABLE).toContain('unique (review_id, kind, letter)');
  });

  it('stops a review having two main lines, which the unique key cannot', () => {
    // The main line's letter is NULL and two NULLs are distinct to a unique
    // constraint, so without this partial index nothing would stop a second one.
    expect(SQL).toContain(
      'create unique index if not exists review_lines_one_main_per_review',
    );
    expect(SQL).toMatch(
      /on review_lines \(review_id\) where kind = 'main'/,
    );
  });

  it('has no foreign key on review_id, like every other review_id in this file', () => {
    // A key would refuse the write for a room that has no curation row, which is
    // exactly the write that makes the tracker complete.
    expect(LINES_TABLE).not.toContain('review_id text not null references');
    expect(LINES_TABLE).toContain('review_id text not null');
  });
});

describe('docs/supabase-schema.sql — review_lines row level security', () => {
  it('is enabled, and reads are open', () => {
    expect(SQL).toContain('alter table review_lines enable row level security');
    expect(SQL).toContain('create policy "public read review lines"       on review_lines for select using (true)');
  });

  // Batch BL tightened what the published anon key may write. Starting a variant,
  // adopting one and dropping one all move other people's rows, so they go through
  // api/reviews/lines.ts and the two functions below; the browser keeps exactly the
  // one insert it needs, which is lib/reviews/linesRepo.ensureMainLine on room open.
  it('lets the browser insert a main line and nothing else', () => {
    expect(SQL).toContain(
      'create policy "public insert main review line" on review_lines for insert with check (kind = \'main\')',
    );
  });

  it('no longer lets the browser insert any line it likes', () => {
    // The policy batch BK copied from model_revisions. Dropped, and not re-created:
    // re-applying this file on an upgrade is what takes it away.
    expect(SQL).toContain('drop policy if exists "public insert review lines" on review_lines');
    expect(SQL).not.toContain('create policy "public insert review lines"');
  });

  it('lets the browser update no line at all', () => {
    expect(SQL).toContain('drop policy if exists "public update review lines" on review_lines');
    expect(SQL).not.toContain('create policy "public update review lines"');
    expect(SQL).not.toContain('on review_lines for update');
  });

  it('has no delete policy: a line is the review\'s history', () => {
    expect(SQL).not.toContain('on review_lines for delete');
  });

  it('takes the table grants back after the block that hands them out', () => {
    // `grant … on all tables in schema public` runs later in the file and is
    // evaluated when it runs, so the revoke has to come after it — and a table grant
    // is checked before row level security, which is why one mechanism is not enough.
    const grants = SQL.indexOf('grant select, insert, update, delete on all tables in schema public');
    const revoke = SQL.indexOf('revoke update, delete on public.review_lines from anon, authenticated');
    expect(grants).toBeGreaterThanOrEqual(0);
    expect(revoke).toBeGreaterThan(grants);
    // Insert and select stay: the map reads lines and ensureMainLine writes one.
    expect(SQL).not.toContain('revoke all on public.review_lines');
  });

  it('drops each policy before creating it, so a re-run cannot fail on a duplicate', () => {
    for (const name of ['public read review lines', 'public insert main review line']) {
      const drop = SQL.indexOf(`drop policy if exists "${name}" on review_lines`);
      const create = SQL.indexOf(`create policy "${name}"`);
      expect(drop, `no drop for "${name}"`).toBeGreaterThanOrEqual(0);
      expect(create, `no create for "${name}"`).toBeGreaterThan(drop);
    }
  });
});

// ─── The two functions the api calls ────────────────────────────────────────

describe('docs/supabase-schema.sql — adopting and dropping a variant', () => {
  // BOUNDED slices, to the next statement rather than to the end of the file: batch BN
  // added `delete_review` below these two, and it legitimately deletes review_lines —
  // so an open-ended slice made "never deletes the variant" match a different
  // function's work and say something untrue about this one. Batch BX split the merge
  // into a three-argument function and a two-argument wrapper that keeps the old
  // signature alive, and those are sliced apart for the same reason: an assertion about
  // what the merge WRITES must not be satisfied by what the wrapper merely forwards.
  const ADOPT_START = SQL.indexOf('create or replace function adopt_review_line');
  const WRAPPER_START = SQL.indexOf('create or replace function adopt_review_line', ADOPT_START + 1);
  const DROP_START = SQL.indexOf('create or replace function drop_review_line');
  expect(ADOPT_START).toBeGreaterThanOrEqual(0);
  expect(WRAPPER_START).toBeGreaterThan(ADOPT_START);
  expect(DROP_START).toBeGreaterThan(WRAPPER_START);
  const ADOPT = SQL.slice(ADOPT_START, WRAPPER_START);
  const WRAPPER = SQL.slice(WRAPPER_START, DROP_START);
  const DROP = SQL.slice(
    DROP_START,
    SQL.indexOf('revoke all on function public.adopt_review_line'),
  );

  it('creates both with `or replace`, so a re-run cannot fail', () => {
    expect(SQL).toContain('create or replace function adopt_review_line');
    expect(SQL).toContain('create or replace function drop_review_line');
    expect(SQL).not.toMatch(/create function (?:public\.)?(?:adopt|drop)_review_line/);
  });

  it('adopts in one transaction: the cards move AND the variant is marked', () => {
    // Half an adoption is the failure these functions exist to make impossible — a
    // variant whose cards have moved but whose status is still 'active' can be
    // adopted a second time and move them again.
    expect(ADOPT).toContain('update tracker_items');
    expect(ADOPT).toContain('set line_id = v_target.id');
    expect(ADOPT).toContain('adopted_at = now()');
    expect(ADOPT).toContain("set status = 'adopted'");
    expect(ADOPT).toContain('closed_at = now()');
    expect(ADOPT).toContain('adopted_revision_ids = p_revision_ids');
    expect(ADOPT).toContain('merged_into_line_id = v_target.id');
  });

  it('keeps where an adopted card was raised, which is the whole point of two columns', () => {
    expect(ADOPT).toContain('origin_line_id = coalesce(origin_line_id, v_variant.id)');
  });

  it('refuses to adopt a variant that is already finished with, rather than doing it twice', () => {
    expect(ADOPT).toContain("if v_variant.status <> 'active' then");
    expect(ADOPT).toContain("'error', 'already_closed'");
    expect(ADOPT).toContain("if not found or v_variant.kind <> 'variant' then");
  });

  // ─── Batch BX: a merge has a destination, and the destination is checked ────

  it('takes the line to merge into as an argument, and locks it', () => {
    // Locked for the same reason the variant is: the target is about to own every card
    // the variant raised and every position it left a model at, and a target being
    // dropped in another transaction at the same moment would leave those cards on a
    // line nobody will ever meet on again.
    expect(ADOPT).toContain('p_target uuid');
    expect(ADOPT).toContain('select * into v_target from review_lines where id = p_target for update');
  });

  it('refuses a destination that is not somewhere the cards can go', () => {
    // Each is a fact about the pair rather than a preference: another review's line is
    // not a destination anybody in this meeting can open; a closed one is a record; the
    // variant itself would move nothing and close the line; and one of its own
    // descendants would make that descendant its own ancestor.
    expect(ADOPT).toContain("'error', 'no_target_line'");
    expect(ADOPT).toContain("'error', 'other_review'");
    expect(ADOPT).toContain("'error', 'same_line'");
    expect(ADOPT).toContain("'error', 'target_closed'");
    expect(ADOPT).toContain("'error', 'own_descendant'");
    expect(ADOPT).toContain('if v_target.review_id <> v_variant.review_id then');
    expect(ADOPT).toContain("if v_target.status <> 'active' then");
  });

  it('walks the target’s own chain looking for the variant, and cannot walk for ever', () => {
    // A recursive CTE cannot `return` out of a query, and an unbounded loop over a
    // chain somebody wrote a cycle into would hang the transaction that found it.
    expect(ADOPT).toContain('while v_walk.parent_line_id is not null and v_depth < 64 loop');
    expect(ADOPT).toContain('if v_walk.parent_line_id = v_variant.id then');
  });

  it('puts the merged variant’s positions into the TARGET’s slot, not always the main line’s', () => {
    // A review keeps where its models stand in its own row: `asset.placements` is the
    // main line's and `asset.linePlacements[<id>]` is one slot per variant. A merge is
    // the moment two lines become one answer, so the positions go with the cards — and
    // into whichever slot belongs to the line that is left standing.
    expect(ADOPT).toContain("if v_target.kind = 'main' then");
    expect(ADOPT).toMatch(/jsonb_set\(\s*asset,\s*'\{placements\}',/);
    expect(ADOPT).toContain("array['linePlacements', v_target.id::text]");
    // Only where the variant has a slot of its own: one that never diverged has nothing
    // to hand over, and a write would still bump updated_at and move the review up the
    // lobby's list.
    expect(ADOPT).toContain("and asset -> 'linePlacements' ? v_variant.id::text");
  });

  it('re-parents the merged variant’s own live variants onto the target, in the same call', () => {
    // The fourth thing in the transaction. Without it, merging Variant A while Variant C
    // is being explored from it leaves C hanging off a line that has just been closed:
    // a parent the map cannot draw and the chip cannot offer a way back from. Closed
    // children are deliberately left alone — where a dropped variant came from is part
    // of its record, and rewriting it would change what its own cards say.
    expect(ADOPT).toContain('set parent_line_id = v_target.id');
    expect(ADOPT).toContain('where parent_line_id = v_variant.id');
    expect(ADOPT).toContain("and status = 'active'");
    expect(ADOPT).toContain('v_reparented');
  });

  it('keeps the two-argument signature alive, forwarding to the main line', () => {
    // An install whose api bundle is older than its schema would otherwise call a
    // function that no longer exists. It is a wrapper and not a second copy: one body
    // decides what a merge writes, and a second copy is a second way for the two to
    // disagree about it.
    expect(WRAPPER).toContain('p_variant uuid');
    expect(WRAPPER).toContain('p_revision_ids uuid[]');
    expect(WRAPPER).not.toContain('p_target');
    expect(WRAPPER).toContain('return adopt_review_line(p_variant, v_main.id, p_revision_ids)');
    expect(WRAPPER).toContain("where review_id = v_variant.review_id and kind = 'main'");
    expect(WRAPPER).toContain("'error', 'no_main_line'");
    // It writes nothing of its own.
    expect(WRAPPER).not.toContain('update tracker_items');
    expect(WRAPPER).not.toContain('update review_curations');
  });

  it('refuses to drop a variant that one of its own is still being explored from', () => {
    // The simplest rule that is also the correct one: the child was started from this
    // line's answer, and dropping the line leaves it starting from an answer the review
    // has just rejected. Re-parenting is what the MERGE does and is right there, because
    // a merge says the answer was taken; a drop says it was not, and there is then no
    // line that is the honest parent. Checked in the transaction and not only in the
    // api, so dropping and exploring at the same moment cannot both be told they worked.
    expect(DROP).toContain("where parent_line_id = v_variant.id");
    expect(DROP).toContain("and status = 'active'");
    expect(DROP).toContain("'error', 'has_active_children'");
    expect(DROP).toContain("'childId', v_child.id");
  });

  it('stores the reason on the line as well as on the cards it closes', () => {
    // A room that opens on a dropped variant has to say why in a banner, and a banner
    // that had to read the review's cards first would show the line's name for a moment
    // and the reason afterwards.
    expect(DROP).toContain('drop_reason = p_closed_reason');
  });

  it('drops in one transaction: the variant is marked AND its open cards close with the reason', () => {
    expect(DROP).toContain("set status = 'dropped'");
    expect(DROP).toContain('closed_at = now()');
    expect(DROP).toContain("set status = 'Rejected'");
    expect(DROP).toContain('closed_reason = p_closed_reason');
  });

  it('closes only the cards that were still open, and leaves a decision alone', () => {
    expect(DROP).toContain("and status in ('Open', 'In Review')");
  });

  it('writes the same status history the tracker writes, so a card can still say when it closed', () => {
    expect(DROP).toContain('insert into tracker_status_history (item_id, status, changed_by, note)');
  });

  it('never deletes the variant: it stays on the map, greyed, for the record', () => {
    expect(ADOPT).not.toContain('delete from review_lines');
    expect(DROP).not.toContain('delete from review_lines');
  });

  it('runs as its owner and cannot be reached by the browser', () => {
    // EXECUTE goes to PUBLIC by default on a new function, and the table-level grants
    // further down the file do not cover functions — so without these revokes the
    // anon key the browser is built with could adopt or drop any variant of any review.
    for (const name of ['adopt_review_line', 'drop_review_line']) {
      expect(SQL).toContain(`revoke all on function public.${name}`);
      expect(SQL).toMatch(new RegExp(`revoke all on function public\\.${name}[^;]*from public, anon, authenticated`));
      expect(SQL).toContain(`grant execute on function public.${name}`);
    }
    // BOTH signatures of the merge, because a grant is per function and the
    // two-argument wrapper is a function of its own that does the same write.
    // Covering only the three-argument one would leave the old signature callable by
    // anybody holding the published anon key.
    expect(SQL).toContain('revoke all on function public.adopt_review_line(uuid, uuid, uuid[]) from public, anon, authenticated');
    expect(SQL).toContain('revoke all on function public.adopt_review_line(uuid, uuid[]) from public, anon, authenticated');
    expect(SQL).toContain('grant execute on function public.adopt_review_line(uuid, uuid, uuid[]) to service_role');
    expect(SQL).toContain('grant execute on function public.adopt_review_line(uuid, uuid[]) to service_role');
    expect(ADOPT).toContain('security definer');
    expect(WRAPPER).toContain('security definer');
    expect(DROP).toContain('security definer');
    // A definer function with no search_path is one that can be hijacked by a schema
    // an attacker created first.
    expect(ADOPT).toContain('set search_path = public');
    expect(WRAPPER).toContain('set search_path = public');
    expect(DROP).toContain('set search_path = public');
  });

  it('adds the column the adoption records, only where it is missing', () => {
    expect(SQL).toContain('alter table review_lines\n  add column if not exists adopted_revision_ids uuid[];');
    expect(LINES_TABLE).toContain('adopted_revision_ids uuid[]');
  });

  it('adds the three columns batch BX records, only where they are missing', () => {
    // install.sh re-applies this file on EVERY run, so an upgrade is a second run of it:
    // an unconditional add column fails on the second run, and it fails on somebody's
    // database rather than at install time.
    expect(SQL).toContain('alter table review_lines\n  add column if not exists parent_line_id uuid references review_lines(id);');
    expect(SQL).toContain('alter table review_lines\n  add column if not exists merged_into_line_id uuid references review_lines(id);');
    expect(SQL).toContain('alter table review_lines\n  add column if not exists drop_reason text;');
    // And in the create, so a fresh install has them without the alters having to run.
    expect(LINES_TABLE).toContain('parent_line_id uuid references review_lines(id)');
    expect(LINES_TABLE).toContain('merged_into_line_id uuid references review_lines(id)');
    expect(LINES_TABLE).toContain('drop_reason text');
    // The lookup the drop guard and the merge's descendant walk both make.
    expect(SQL).toContain('create index if not exists review_lines_parent_idx');
  });

  it('fills in where every variant that already exists was started from', () => {
    // Every variant written before this column existed was started from a meeting of the
    // review's MAIN line, because that was the only line a variant could leave from — so
    // the backfill is a fact about the old code and not a guess. Keyed on `is null` so a
    // second run adds nothing and never overwrites a parent batch BX has since written.
    const backfill = section('update review_lines v\nset parent_line_id = coalesce(');
    expect(backfill).toContain('(select s.line_id from tracker_sessions s where s.id = v.parent_session_id)');
    expect(backfill).toContain("where m.review_id = v.review_id and m.kind = 'main'");
    expect(backfill).toContain("where v.kind = 'variant'");
    expect(backfill).toContain('and v.parent_line_id is null');
  });

  it('records where every variant that was already merged went', () => {
    const backfill = section('update review_lines v\nset merged_into_line_id = m.id');
    expect(backfill).toContain("and v.status = 'adopted'");
    expect(backfill).toContain('and v.merged_into_line_id is null');
    expect(backfill).toContain("and m.kind = 'main'");
  });
});

// ─── The columns this batch adds ────────────────────────────────────────────

describe('docs/supabase-schema.sql — the new columns', () => {
  const added = [
    ['tracker_sessions', 'line_id uuid'],
    ['tracker_sessions', 'seq int'],
    ['tracker_items', 'line_id uuid'],
    ['tracker_items', 'origin_line_id uuid'],
    ['tracker_items', 'adopted_at timestamptz'],
    ['tracker_items', 'closed_reason text'],
  ] as const;

  it.each(added)('adds %s.%s only if it is not there', (table, column) => {
    const statement = `alter table ${table}\n  add column if not exists ${column};`;
    expect(SQL).toContain(statement);
  });

  it('leaves all of them nullable, so a row written before this batch still reads', () => {
    for (const [, column] of added) {
      expect(SQL).toContain(`add column if not exists ${column};`);
      expect(SQL).not.toContain(`add column if not exists ${column} not null`);
    }
  });

  it('indexes the two lookups the app makes: a line\'s sessions, and a line\'s cards', () => {
    expect(SQL).toContain('create index if not exists tracker_sessions_line_idx');
    expect(SQL).toContain('create index if not exists tracker_items_line_idx');
  });
});

// ─── The backfill ───────────────────────────────────────────────────────────

describe('docs/supabase-schema.sql — the backfill, run twice', () => {
  const BACKFILL = section('insert into review_lines (review_id, kind, name, letter, status, created_at)');

  it('gives every review that has met a main line', () => {
    expect(BACKFILL).toContain("select s.review_id, 'main', 'Main line', null, 'active'");
    expect(BACKFILL).toContain('from tracker_sessions s');
    expect(BACKFILL).toContain('where s.review_id is not null');
  });

  it('adds no second main line on a re-run, twice over', () => {
    // NOT EXISTS so a second run does not even try, and ON CONFLICT so two installs
    // of the file running at once — or a partial earlier run — cannot both win.
    expect(BACKFILL).toMatch(/not exists \(\s*select 1 from review_lines l where l\.review_id = s\.review_id and l\.kind = 'main'\s*\)/);
    expect(BACKFILL).toContain('on conflict do nothing');
  });

  it('gives a review with no sessions no line at all', () => {
    // A review that has never met has nothing to number, and a main line invented for
    // it would appear on a map with no stops on it.
    expect(BACKFILL).toContain('where s.review_id is not null');
    expect(BACKFILL).toContain('group by s.review_id');
  });

  it('puts a session on its review\'s main line only while it is on none', () => {
    const sessions = section('update tracker_sessions s\nset line_id = l.id');
    expect(sessions).toContain('and s.line_id is null');
    expect(sessions).toContain("where l.kind = 'main'");
  });

  it('numbers the sessions by the order they ended in, and numbers each one once', () => {
    const numbered = section('with numbered as (');
    expect(numbered).toContain('row_number() over (partition by s.line_id order by s.ended_at, s.id)');
    // Without `s.seq is null` a re-run would renumber every session, and a session
    // added between the two runs would shift the numbers of all the ones after it —
    // silently changing what every card raised in them says it was raised in.
    expect(numbered).toContain('and s.seq is null');
    // Ties broken by id, because two meetings of one review can end inside the same
    // second and a map whose stops swap places between two runs looks broken.
    expect(numbered).toContain('order by s.ended_at, s.id');
  });

  it('puts a card on its meeting\'s line without overwriting a line batch BL moved', () => {
    const items = section('update tracker_items i');
    // coalesce, not assignment: adopting a variant into the main line moves line_id
    // and leaves origin_line_id alone, and a re-run of the backfill must not undo
    // either half of that.
    expect(items).toContain('set line_id = coalesce(i.line_id, s.line_id)');
    expect(items).toContain('origin_line_id = coalesce(i.origin_line_id, s.line_id)');
    expect(items).toContain('and (i.line_id is null or i.origin_line_id is null)');
  });

  it('leaves a card whose meeting has no line alone', () => {
    const items = section('update tracker_items i');
    expect(items).toContain('and s.line_id is not null');
  });
});

// ─── The whole file, re-run ─────────────────────────────────────────────────

describe('docs/supabase-schema.sql — the file is safe to apply twice', () => {
  it('creates every table and every index conditionally', () => {
    for (const match of SQL.matchAll(/create (?:unique )?(?:table|index) (?!if not exists)/g)) {
      expect.fail(`an unconditional create: ${SQL.slice(match.index, (match.index ?? 0) + 80)}`);
    }
  });

  it('adds every column conditionally', () => {
    for (const match of SQL.matchAll(/add column (?!if not exists)/g)) {
      expect.fail(`an unconditional add column: ${SQL.slice(match.index, (match.index ?? 0) + 80)}`);
    }
  });

  it('drops every policy before it creates it', () => {
    for (const match of SQL.matchAll(/create policy "([^"]+)"/g)) {
      const name = match[1] ?? '';
      const created = match.index ?? 0;
      const dropped = SQL.indexOf(`drop policy if exists "${name}"`);
      // app_settings' policies are dropped by a DO block over pg_policy instead, which
      // is the one place a per-name drop is not the mechanism.
      if (SQL.slice(created, created + 200).includes('on app_settings')) continue;
      expect(dropped, `no drop before the create of "${name}"`).toBeGreaterThanOrEqual(0);
      expect(dropped).toBeLessThan(created);
    }
  });

  it('creates review_lines before the block that grants on every table', () => {
    // `grant … on all tables in schema public` is evaluated when it runs, so a table
    // created after it is not covered — and a table the anon role cannot select is a
    // map that renders empty on a self-hosted install.
    const table = SQL.indexOf('create table if not exists review_lines');
    const grants = SQL.indexOf('grant select, insert, update, delete on all tables in schema public');
    expect(table).toBeGreaterThanOrEqual(0);
    expect(grants).toBeGreaterThan(table);
  });

  it('still revokes app_settings last, after the grants have run', () => {
    const grants = SQL.indexOf('grant select, insert, update, delete on all tables in schema public');
    const revoke = SQL.indexOf('revoke all on public.app_settings from anon, authenticated');
    expect(revoke).toBeGreaterThan(grants);
  });
});
