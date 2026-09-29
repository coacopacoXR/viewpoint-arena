// What the lobby's grid of design reviews is drawn from.
//
// docs/plan/15-sessions-and-variants.md batch BO. The lobby stopped being a form with
// two lists under it and became a page of CARDS, and a card says more than a list row
// did: the newest revision, when the review last met, a miniature of its session map,
// and how many of each kind of card are still open. Every one of those is a different
// table, and asking for them per card is a waterfall of a hundred requests behind a
// page whose whole job is to be a list — so this module reads them in SIX queries for
// the whole grid, whatever the grid holds:
//
//   1. the reviews themselves (review_curations, newest first, capped)
//   2. my roster rows          (review_members — only with an account)
//   3. the reviews I have been in (review_participants, via lib/reviewParticipantsRepo)
//   4. their meetings          (tracker_sessions, `review_id in (…)`)
//   5. their lines             (review_lines, `review_id in (…)`)
//   6. their still-open cards  (tracker_items, `review_id in (…)`)
//   7. their stored revisions  (model_revisions, `review_id in (…)`)
//
// Two through seven run together, and four to seven only after one has answered with
// the ids to ask about. Switching the filter chips then makes NO request at all: the
// chips narrow a set that is already in hand, which is why they feel instant.
//
// WHAT IS DELIBERATELY NOT HERE
//
// * A "LIVE · n IN ROOM" badge. The room's presence lives on its PartyKit socket and
//   there is no HTTP endpoint that reports occupancy for a list of rooms in one call;
//   lib/curationsRepo.trackCurationPresence is a Supabase presence channel that
//   nothing in the app subscribes to, so opening one per card would be a socket per
//   card that sees nobody. The badge is omitted rather than wrong.
// * The preview panel's detail. One selected review wants its revisions and its card
//   TITLES, which the grid never needs; lib/reviews/useSessionMap already reads
//   exactly that for one review, and the preview uses it.
//
// Every read answers empty rather than throwing, following lib/reviews/linesRepo: an
// install whose database has not been re-applied since a column shipped gets a lobby
// with less on its cards, not a lobby that will not load.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, supabaseConfigured } from '../supabase';
import { listMyReviews } from '../reviewParticipantsRepo';
import { listLinesForReviews, listSessionsForReviews, type LineSession } from '../reviews/linesRepo';
import { orderedLines, type ReviewLine } from '../reviews/lines';
import { asMemberRole, type MemberRole } from '../reviews/roles';
import { revisionLabel, shortDate } from '../trackerContinuity';
import type { ReviewDraft } from '../reviewSetupStore';

/** How many reviews the grid will read. Bounded, like every other list in this app. */
const CURATION_LIMIT = 60;
const OPEN_ITEM_LIMIT = 4000;
const REVISION_LIMIT = 600;

/** PostgREST's "column does not exist" — see the long note in lib/curationsRepo.ts. */
const UNDEFINED_COLUMN = '42703';

const COLUMNS =
  'id,title,description,asset,thumbnail,owner_id,archived,listed,created_at,updated_at';
const COLUMNS_NO_THUMBNAIL =
  'id,title,description,asset,owner_id,archived,listed,created_at,updated_at';
const COLUMNS_NO_OWNER = 'id,title,description,asset,listed,created_at,updated_at';
const COLUMNS_LEGACY = 'id,title,description,asset,created_at,updated_at';

interface CurationRow extends Record<string, unknown> {
  id: string;
  title: string;
  description: string | null;
  asset?: Partial<ReviewDraft['asset']> | null;
  thumbnail?: string | null;
  owner_id?: string | null;
  archived?: boolean | null;
  listed?: boolean | null;
  created_at: string;
  updated_at: string;
}

/** How many of each kind of card a review still has open. */
export interface OpenCardCounts {
  RISK: number;
  ACTION: number;
  RATIONALE: number;
}

const NO_OPEN_CARDS: OpenCardCounts = { RISK: 0, ACTION: 0, RATIONALE: 0 };

/** One design review, with everything a lobby card says about it. */
export interface LobbyReview {
  id: string;
  title: string;
  description: string;
  /** The JPEG data URL captured in the room, or null when there is no snapshot yet. */
  thumbnail: string | null;
  /** The model's own file name — what the card's placeholder says when there is no snapshot. */
  modelName: string | null;
  updatedAt: string;
  createdAt: string;
  archived: boolean;
  /** False for a link-only review, which the grid does not offer to strangers. */
  listed: boolean;
  /** My row on the review's roster, or null when I am not on it. */
  memberRole: MemberRole | null;
  /** Whether the review is mine: owner_id names me, or my roster row says 'owner'. */
  mine: boolean;
  /** Whether I have ever stood in the room, from review_participants. */
  visited: boolean;
  lastVisitedAt: string | null;
  /** Its meetings, oldest first — the order the mini map draws them in. */
  sessions: LineSession[];
  /** Its lines, main line first — what tells the mini map about variants. */
  lines: ReviewLine[];
  openCards: OpenCardCounts;
  /** "Rev C" — the newest revision this review has stored, or null when it has none. */
  revision: string | null;
}

/** The four chips over the grid, in the order the approved sketch puts them. */
export type LobbyFilter = 'mine' | 'shared' | 'all' | 'archived';

export const LOBBY_FILTERS: readonly { id: LobbyFilter; label: string }[] = [
  { id: 'mine', label: 'Mine' },
  { id: 'shared', label: 'Shared with me' },
  { id: 'all', label: 'All' },
  { id: 'archived', label: 'Archived' },
];

// ─── Reads ──────────────────────────────────────────────────────────────────

/**
 * The reviews this install holds, newest first.
 *
 * Every review rather than only the listed ones: the Archived chip has to show the
 * reviews an admin put away, and `listed` is what keeps a link-only review out of the
 * grid. Filtering is the caller's, per chip, and costs no request.
 *
 * Four column lists, tried in order, for the reason lib/curationsRepo spells out at
 * length: PostgREST rejects the WHOLE request for one unknown column, so a database
 * that has never had `thumbnail` (batch BO) or `owner_id` (batch BC) applied would
 * otherwise answer with an empty lobby rather than with the columns it does have.
 */
async function readCurations(): Promise<CurationRow[]> {
  if (!supabaseConfigured) return [];
  const order = { column: 'updated_at', ascending: false } as const;

  const first = await supabase
    .from('review_curations')
    .select(COLUMNS)
    .order(order.column, { ascending: order.ascending })
    .limit(CURATION_LIMIT);

  const second = first.error?.code === UNDEFINED_COLUMN
    ? await supabase
        .from('review_curations')
        .select(COLUMNS_NO_THUMBNAIL)
        .order(order.column, { ascending: order.ascending })
        .limit(CURATION_LIMIT)
    : first;

  const third = second.error?.code === UNDEFINED_COLUMN
    ? await supabase
        .from('review_curations')
        .select(COLUMNS_NO_OWNER)
        .order(order.column, { ascending: order.ascending })
        .limit(CURATION_LIMIT)
    : second;

  const fourth = third.error?.code === UNDEFINED_COLUMN
    ? await supabase
        .from('review_curations')
        .select(COLUMNS_LEGACY)
        .order(order.column, { ascending: order.ascending })
        .limit(CURATION_LIMIT)
    : third;

  if (fourth.error) {
    console.error('[useLobbyData] could not read the reviews:', fourth.error.message);
    return [];
  }
  return (fourth.data ?? []) as CurationRow[];
}

/** My rows on every review's roster, one query. Empty without an account. */
async function readMyMemberships(accountId: string | null): Promise<Map<string, MemberRole>> {
  if (!accountId || !supabaseConfigured) return new Map();
  try {
    const { data, error } = await supabase
      .from('review_members')
      .select('review_id,role')
      .eq('user_id', accountId);
    if (error || !data) return new Map();
    const roles = new Map<string, MemberRole>();
    for (const row of data as Array<Record<string, unknown>>) {
      const reviewId = typeof row['review_id'] === 'string' ? row['review_id'] : '';
      // An unknown value is dropped rather than read as the least role: an absent
      // entry and a 'participant' entry mean the same thing to the chips below.
      const role = asMemberRole(row['role']);
      if (reviewId === '' || !role) continue;
      roles.set(reviewId, role);
    }
    return roles;
  } catch (err) {
    console.error('[useLobbyData] could not read my memberships:', err);
    return new Map();
  }
}

/** Still-open cards, counted per review and per type. One query for the whole grid. */
async function readOpenCardCounts(reviewIds: readonly string[]): Promise<Map<string, OpenCardCounts>> {
  if (reviewIds.length === 0 || !supabaseConfigured) return new Map();
  try {
    const { data, error } = await supabase
      .from('tracker_items')
      .select('review_id,type')
      .in('review_id', [...reviewIds])
      // The tracker's own definition of still open, which is what
      // lib/reviews/linesRepo.listOpenLineItems filters on and what
      // lib/trackerContinuity.isClosed spells out: Open and In Review. An Approved
      // or Rejected card was dealt with and is not something a lobby card should
      // count as work left to do.
      .in('status', ['Open', 'In Review'])
      .limit(OPEN_ITEM_LIMIT);
    if (error || !data) return new Map();
    const counts = new Map<string, OpenCardCounts>();
    for (const row of data as Array<Record<string, unknown>>) {
      const reviewId = typeof row['review_id'] === 'string' ? row['review_id'] : '';
      const type = row['type'];
      if (reviewId === '') continue;
      if (type !== 'RISK' && type !== 'ACTION' && type !== 'RATIONALE') continue;
      const bucket = counts.get(reviewId) ?? { ...NO_OPEN_CARDS };
      bucket[type] += 1;
      counts.set(reviewId, bucket);
    }
    return counts;
  } catch (err) {
    console.error('[useLobbyData] could not count the open cards:', err);
    return new Map();
  }
}

/** The newest revision letter each review has stored. One query for the whole grid. */
async function readNewestRevisions(reviewIds: readonly string[]): Promise<Map<string, string>> {
  if (reviewIds.length === 0 || !supabaseConfigured) return new Map();
  try {
    const { data, error } = await supabase
      .from('model_revisions')
      .select('review_id,line,revision,created_at')
      .in('review_id', [...reviewIds])
      .order('created_at', { ascending: true })
      .limit(REVISION_LIMIT);
    if (error || !data) return new Map();
    const newest = new Map<string, { line: string; revision: string }>();
    for (const row of data as Array<Record<string, unknown>>) {
      const reviewId = typeof row['review_id'] === 'string' ? row['review_id'] : '';
      const revision = typeof row['revision'] === 'string' ? row['revision'].trim() : '';
      if (reviewId === '' || revision === '') continue;
      const line = typeof row['line'] === 'string' ? row['line'] : '';
      // Rows arrive oldest first, so the last one read for a review is its newest —
      // and a review holding two products side by side says the letter of whichever
      // moved last, which is the honest reading of "Rev C" on a card.
      newest.set(reviewId, { line, revision });
    }
    const labels = new Map<string, string>();
    for (const [reviewId, row] of newest) {
      const label = revisionLabel(row);
      if (label) labels.set(reviewId, label);
    }
    return labels;
  } catch (err) {
    console.error('[useLobbyData] could not read the revisions:', err);
    return new Map();
  }
}

// ─── Derivations, pure so a test can hand them a fixture ────────────────────

/** The name a card's placeholder shows when the review has no snapshot yet. */
function modelNameOf(asset: Partial<ReviewDraft['asset']> | null | undefined): string | null {
  if (!asset) return null;
  const name = asset.importedFileName?.trim();
  if (name) return name;
  // A built-in preset is still a model to name, and 'imported' is not a name — it
  // is the spelling of "a file somebody uploaded", whose own name is missing.
  const type = asset.modelType;
  if (!type || type === 'imported' || type === 'none') return null;
  return type;
}

/** The review's newest meeting, which is what "last session 24 Sep" reads. */
export function lastSessionOf(review: Pick<LobbyReview, 'sessions'>): LineSession | null {
  const { sessions } = review;
  return sessions.length > 0 ? sessions[sessions.length - 1] : null;
}

/** How many lines of the review are variants rather than its main line. */
export function variantCountOf(review: Pick<LobbyReview, 'lines'>): number {
  return review.lines.filter((line) => line.kind === 'variant').length;
}

/**
 * Who has been in this review, by name.
 *
 * The names its meetings recorded, deduplicated across all of them — the preview's
 * avatars and its "3 people" both read this. A meeting recorded before
 * attendee_names existed contributes nothing, and then the largest head count any of
 * its meetings reported is the fallback: fewer names, but still a true statement
 * about how many people were in the room.
 */
export function peopleOf(review: Pick<LobbyReview, 'sessions'>): { names: string[]; count: number } {
  const names: string[] = [];
  let count = 0;
  for (const session of review.sessions) {
    for (const name of session.attendeeNames ?? []) {
      if (name !== '' && !names.includes(name)) names.push(name);
    }
    if (session.participantCount > count) count = session.participantCount;
  }
  return { names, count: names.length > 0 ? names.length : count };
}

/**
 * My standing in this review, as one word the card's meta line ends with.
 *
 * 'you own it' / 'editor' / 'participant' / 'you have been in it' / null. Null when
 * this review is nothing to me, which on a deployment with no accounts is every
 * review — and then the meta line simply ends at the date.
 */
export function standingOf(review: Pick<LobbyReview, 'mine' | 'memberRole' | 'visited'>): string | null {
  if (review.mine) return 'you own it';
  if (review.memberRole === 'editor') return 'editor';
  if (review.memberRole === 'participant') return 'participant';
  if (review.visited) return 'you have been in it';
  return null;
}

/**
 * The card's one line of meta: "Rev C · last session 24 Sep · you own it".
 *
 * Every part is dropped when there is nothing true to say, so a review that has never
 * met and has no stored model reads "you own it" and not "no revision · no session".
 */
export function metaLineOf(review: LobbyReview): string {
  const parts: string[] = [];
  if (review.revision) parts.push(review.revision);
  const last = lastSessionOf(review);
  const when = last ? shortDate(last.endedAt) : null;
  parts.push(when ? `last session ${when}` : 'no sessions yet');
  const standing = standingOf(review);
  if (standing) parts.push(standing);
  return parts.join(' · ');
}

/**
 * Which reviews a chip shows.
 *
 * 'all' is the listed ones and not the archived ones, which is what the lobby showed
 * before the chips existed; 'archived' is exactly the complement an admin put away;
 * 'mine' and 'shared with me' both follow the PERSON, and neither shows a review
 * somebody archived — an archived review is out of the way for its owner too, and the
 * chip that finds it is the one that says so.
 */
export function filterReviews(reviews: readonly LobbyReview[], filter: LobbyFilter): LobbyReview[] {
  switch (filter) {
    case 'archived':
      return reviews.filter((review) => review.archived);
    case 'mine':
      return reviews.filter((review) => !review.archived && review.mine);
    case 'shared':
      return reviews.filter(
        (review) =>
          !review.archived &&
          !review.mine &&
          (review.memberRole !== null || review.visited),
      );
    case 'all':
    default:
      return reviews.filter((review) => !review.archived && review.listed);
  }
}

// ─── The hook ───────────────────────────────────────────────────────────────

export interface UseLobbyDataOptions {
  /** The signed-in account's id, or null. Without it there is nothing to be "mine". */
  accountId: string | null;
  /** A guest has no account and no history, so two of the reads are skipped. */
  isGuest: boolean;
}

export interface LobbyData {
  /** Every review read, before the chips narrow it. */
  reviews: LobbyReview[];
  /** The ones the current chip shows. */
  visible: LobbyReview[];
  filter: LobbyFilter;
  setFilter: (filter: LobbyFilter) => void;
  /** True until the first read has settled. */
  loading: boolean;
  /** Read again. Called after a review is created or deleted. */
  refresh: () => void;
  /** Drop one review from the set, after deleting it — no re-read for a removal. */
  forget: (reviewId: string) => void;
}

export function useLobbyData(options: UseLobbyDataOptions): LobbyData {
  const { accountId, isGuest } = options;
  const [reviews, setReviews] = useState<LobbyReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<LobbyFilter>(accountId ? 'mine' : 'all');
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const forget = useCallback((reviewId: string) => {
    setReviews((current) => current.filter((review) => review.id !== reviewId));
  }, []);

  useEffect(() => {
    if (!supabaseConfigured) {
      // The default self-hosted install: no database, so no reviews to list. Not an
      // error and not a spinner that never stops — the grid renders its empty state
      // and the "New design review" button still works, exactly as it did before.
      setReviews([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    void (async () => {
      const rows = await readCurations();
      if (cancelled) return;

      const ids = rows.map((row) => row.id);
      const me = !isGuest ? accountId : null;
      // Everything that needs the ids, asked for together rather than one after
      // another: four round trips in parallel instead of four in sequence.
      const [memberships, visited, sessionsByReview, linesByReview, openCards, revisions] =
        await Promise.all([
          readMyMemberships(me),
          me ? listMyReviews(CURATION_LIMIT) : Promise.resolve([]),
          listSessionsForReviews(ids),
          listLinesForReviews(ids),
          readOpenCardCounts(ids),
          readNewestRevisions(ids),
        ]);
      if (cancelled) return;

      const visits = new Map(visited.map((row) => [row.reviewId, row.lastJoinedAt]));

      setReviews(
        rows.map((row) => {
          const memberRole = memberships.get(row.id) ?? null;
          const ownerId = typeof row.owner_id === 'string' && row.owner_id !== '' ? row.owner_id : null;
          const asset = (row.asset ?? null) as Partial<ReviewDraft['asset']> | null;
          const thumbnail = typeof row.thumbnail === 'string' && row.thumbnail !== '' ? row.thumbnail : null;
          return {
            id: row.id,
            title: row.title ?? '',
            description: row.description ?? '',
            thumbnail,
            modelName: modelNameOf(asset),
            updatedAt: row.updated_at,
            createdAt: row.created_at,
            archived: row.archived === true,
            // A database with no `listed` column lists everything, which is what
            // lib/curationsRepo's own fallback decides for the same absence.
            listed: row.listed !== false,
            memberRole,
            mine: memberRole === 'owner' || (me !== null && ownerId === me),
            visited: visits.has(row.id),
            lastVisitedAt: visits.get(row.id) ?? null,
            sessions: sessionsByReview[row.id] ?? [],
            lines: orderedLines(linesByReview[row.id] ?? []),
            openCards: openCards.get(row.id) ?? { ...NO_OPEN_CARDS },
            revision: revisions.get(row.id) ?? null,
          };
        }),
      );
      setLoading(false);
    })().catch((err: unknown) => {
      // Every read above answers empty rather than throwing, so nothing here rejects
      // today. This is for the day one does, and it is the same reasoning
      // lib/reviews/useReviewRole gives for its own catch: a `void`-ed promise that
      // rejects is an unhandled rejection, and a `.then` that never runs leaves
      // `loading` true forever — so the grid would show skeletons on a page that has an
      // answer, and never stop.
      console.error('[useLobbyData] could not read the reviews:', err);
      if (cancelled) return;
      setReviews([]);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [accountId, isGuest, nonce]);

  const visible = useMemo(() => filterReviews(reviews, filter), [reviews, filter]);

  return { reviews, visible, filter, setFilter, loading, refresh, forget };
}
