// What a tracker card can honestly say about the revisions it has lived through.
//
// docs/plan/14-rooms-models-admin-ai.md batch BC. A card used to belong to a
// meeting and to nothing else, so the tracker could say when it was raised and
// could not say whether the thing it was raised about had been redesigned twice
// since. A card now records the revision it was raised on, and its design review
// records every revision it has ever shown — which between them are enough for
// the sentence the plan asks for, "raised on Rev A · still open on Rev C".
//
// Everything here is pure: rows in, strings out. No reads, no React, no clock —
// the one place a timestamp is needed, the caller passes it. That is deliberate,
// because the interesting cases are all about what the data does NOT support: a
// card recorded before this batch, a review whose history nobody stored, a
// revision id that has been deleted, a close whose timestamp falls between two
// uploads. Every one of those has to answer "say nothing" rather than guess,
// because a guess on a card reads as a fact about an engineering decision to the
// person who is relying on the tracker to close it.

import { latestRevision } from './scene/roomScene';
import type { ModelRevision } from './reviews/revisionsRepo';

// The separator the repo already uses between two labels — sceneModelLabel
// answers "Bracket · Rev B", and a continuity line is the same kind of thing:
// two short facts that belong together and are read in one breath.
const SEPARATOR = ' · ';

// What the tracker has always meant by closed, in one place: computeStats in
// pages/TrackerPage.tsx calls this rather than repeating the test, so the stats
// bar and the continuity line cannot drift apart and count a card one way while
// describing it the other. 'Open' and 'In Review' are both still open, and a card
// under review is the one most worth seeing "still open on Rev C" against.
const CLOSED_STATUSES: readonly string[] = ['Approved', 'Rejected'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Whether a card with this status counts as closed. */
export function isClosed(status: string): boolean {
  return CLOSED_STATUSES.includes(status);
}

/**
 * The revision a card was raised on, or null.
 *
 * Null is the common answer and not an error: every card recorded before this
 * batch has no `raised_on_revision`, every card from an ad-hoc room has none,
 * and a card raised on a built-in preset (headphones, bicycle, synth) has none
 * either, because a preset is not a revision of anything. A revision row can
 * also have been deleted from a review that still holds the card, which leaves
 * the id pointing at nothing — the card keeps its title, its status and its
 * meeting, and simply has no revision to be named after.
 */
export function revisionRaisedOn(
  raisedOnRevisionId: string | null | undefined,
  revisions: readonly ModelRevision[],
): ModelRevision | null {
  if (!raisedOnRevisionId) return null;
  return revisions.find((revision) => revision.id === raisedOnRevisionId) ?? null;
}

/**
 * "Rev A" — the label a revision is known by everywhere else in the app.
 *
 * Null when the row carries no letter, so a caller can never build the string
 * "Raised on Rev " out of a revision that was stored without one.
 */
export function revisionLabel(revision: Pick<ModelRevision, 'revision'> | null): string | null {
  const letter = revision?.revision.trim().toUpperCase();
  return letter ? `Rev ${letter}` : null;
}

/**
 * Whether `candidate` is a later revision of the same line than `raised`.
 *
 * Ordered by LETTER rather than by created_at, using the same rule
 * `latestRevision` applies to a scene: a longer run of letters is later, and
 * within one length it is alphabetical. The letter is what the user reads and
 * what the unique key of model_revisions is built from, so it is the ordering
 * that has to be right; `created_at` is only a recording of when somebody
 * uploaded, and two rows written in one import share a second.
 *
 * Same line only, and that is the whole point: a review can hold the product
 * under review, a mating part and a competitor's unit side by side, and a new
 * revision of the mating part says nothing about whether a risk on the product
 * is still open. Claiming "still open on Rev C" because some other model moved
 * would be worse than saying nothing.
 */
export function isLaterRevision(
  raised: Pick<ModelRevision, 'line' | 'revision'>,
  candidate: Pick<ModelRevision, 'line' | 'revision'>,
): boolean {
  if (candidate.line !== raised.line) return false;
  const from = raised.revision.trim().toUpperCase();
  const to = candidate.revision.trim().toUpperCase();
  if (from === '' || to === '') return false;
  if (to.length !== from.length) return to.length > from.length;
  return to > from;
}

/**
 * The newest revision on `raised`'s line that came after it, or null when that
 * line has not moved since — which is the answer for a review that met once, and
 * for a card raised on the revision currently on screen.
 */
export function laterRevisionOnLine(
  raised: ModelRevision | null,
  revisions: readonly ModelRevision[],
): ModelRevision | null {
  if (!raised) return null;
  const newest = latestRevision(revisions, raised.line);
  if (newest === null || !isLaterRevision(raised, { line: raised.line, revision: newest })) return null;
  return (
    revisions.find(
      (revision) =>
        revision.line === raised.line && revision.revision.trim().toUpperCase() === newest,
    ) ?? null
  );
}

/**
 * The newest revision of `line` that already existed at `atIso`, or null.
 *
 * This is how "in which revision was it closed" is answered, and it is the only
 * way available: tracker_status_history records WHEN a status changed and has no
 * revision column, and this batch's schema is fixed, so the two histories have
 * to be lined up by time. The newest revision already uploaded when the card was
 * closed is the revision the review was showing, because a revision is added at
 * the moment a model is imported and never backdated.
 *
 * Null when nothing on that line predates the timestamp — a clock skew between
 * the two writes, a revision list this install never stored — and the caller
 * then falls back to the date alone rather than naming a revision it cannot
 * support.
 */
export function revisionOfLineAt(
  line: string,
  atIso: string,
  revisions: readonly ModelRevision[],
): ModelRevision | null {
  const at = Date.parse(atIso);
  if (Number.isNaN(at)) return null;
  let newest: ModelRevision | null = null;
  let newestAt = Number.NaN;
  for (const revision of revisions) {
    if (revision.line !== line) continue;
    const uploaded = Date.parse(revision.createdAt);
    if (Number.isNaN(uploaded) || uploaded > at) continue;
    if (newest === null || uploaded > newestAt) {
      newest = revision;
      newestAt = uploaded;
    }
  }
  return newest;
}

/**
 * "12 Mar" — the short date the tracker shows everywhere else.
 *
 * Read in UTC on purpose. pages/TrackerPage.tsx formats in the browser's own
 * zone, which is right for a meeting somebody attended and wrong here: this
 * string is derived from a database timestamp and compared against another one,
 * and a card closed at 23:40 in Lisbon must not read as the next day for a
 * colleague in Auckland looking at the same row.
 */
export function shortDate(iso: string): string | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const date = new Date(at);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** The three fields of a card a continuity line is built from. */
export interface ContinuityCard {
  status: string;
  /** tracker_items.raised_on_revision — a model_revisions id, or nothing. */
  raisedOnRevision: string | null | undefined;
  /**
   * When the card was closed, from the newest tracker_status_history entry that
   * closed it. Null when there is no such entry, which is every card closed by a
   * route that did not write history and every card still open.
   */
  closedAt?: string | null;
}

/**
 * The continuity line for one card, or null when the card has nothing to say.
 *
 * The rules, in the order they are decided:
 *
 *   * No revision it was raised on — no line at all. Never "Raised on Rev
 *     undefined", never a revision inferred from the meeting it came from.
 *   * Closed, and history says when: "Raised on Rev A · Closed on Rev B · 12
 *     Mar", where Rev B is the newest revision of that line that already existed
 *     when it was closed. The revision is dropped from the sentence when it is
 *     the one the card was raised on, because "Raised on Rev A · Closed on Rev A"
 *     says one thing twice.
 *   * Closed, and when is not knowable: "Raised on Rev A", which is all the data
 *     supports.
 *   * Still open with a later revision on its line: "Raised on Rev A · still
 *     open on Rev C" — the sentence the plan asks for, and the one that tells a
 *     reviewer a risk has outlived two redesigns.
 *   * Still open on the newest revision: "Raised on Rev A".
 */
export function cardContinuity(
  card: ContinuityCard,
  revisions: readonly ModelRevision[],
): string | null {
  const raised = revisionRaisedOn(card.raisedOnRevision, revisions);
  const raisedLabel = revisionLabel(raised);
  if (!raised || !raisedLabel) return null;

  const parts = [`Raised on ${raisedLabel}`];

  if (isClosed(card.status)) {
    const closedAt = card.closedAt ?? null;
    const when = closedAt ? shortDate(closedAt) : null;
    const closedIn = closedAt ? revisionOfLineAt(raised.line, closedAt, revisions) : null;
    const closedLabel = closedIn && closedIn.id !== raised.id ? revisionLabel(closedIn) : null;
    if (closedLabel && when) parts.push(`Closed on ${closedLabel}${SEPARATOR}${when}`);
    else if (when) parts.push(`Closed ${when}`);
    return parts.join(SEPARATOR);
  }

  const laterLabel = revisionLabel(laterRevisionOnLine(raised, revisions));
  if (laterLabel) parts.push(`still open on ${laterLabel}`);
  return parts.join(SEPARATOR);
}
