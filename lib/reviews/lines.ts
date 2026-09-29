// The lines of a design review, in words and in ids.
//
// docs/plan/15-sessions-and-variants.md batch BK. A design review is the lasting
// thing; inside it a LINE is one continuous run of meetings, and every session
// belongs to exactly one. The main line is the review's own story; a variant is a
// named side line somebody started from one of its sessions to try a different
// answer without losing the one the main line is holding.
//
// Everything here is pure: rows in, strings and ids out. No reads, no React, no
// clock. The database half is lib/reviews/linesRepo.ts, and the split is the same
// one lib/trackerContinuity.ts and lib/scene/roomScene.ts already make — the
// interesting cases are all about data that is missing (a session recorded before
// lines existed, a variant whose letter was never assigned, a review on an install
// with no database), and each of them has to answer "say nothing" rather than
// invent a label, because a label on a card reads as a fact about the review.
//
// THE WORDS ARE THE SPEC. On screen this is a "Design review" with a "Main line"
// and "Variant A"; a session is a "Session". Never branch, fork or commit: the
// people using this are hardware engineers and the plan is explicit that the
// programming metaphor must not show through. Nothing in this file may print one.
//
// "Merge" is the exception, and the user is why (2026-09-26, batch BX): asked for a
// variant that could be taken into another variant, they described it as "merged", so
// that is the word on the button ("Merge into…") and in the sentence a card carries
// afterwards ("Raised in Variant B · merged into Variant A 26 Sep"). The database
// column and the line's STATUS keep saying 'adopted', because that is what every row
// written since batch BL says and a status is not a sentence anybody reads.

import { shortDate } from '../trackerContinuity';

/** What kind of line this is. The main line is the review's own run of meetings. */
export type LineKind = 'main' | 'variant';

/**
 * A variant's fate. 'active' while it is being explored, 'adopted' when its model
 * and cards have been taken into the main line, 'dropped' when they were not.
 * Batch BK only ever produces 'active'; the other two are batch BL's, and the map
// renders all three from data it is given.
 */
export type LineStatus = 'active' | 'adopted' | 'dropped';

/** One row of review_lines, in the app's own naming. */
export interface ReviewLine {
  id: string;
  reviewId: string;
  kind: LineKind;
  /** What the variant is called by the people exploring it. '' for the main line. */
  name: string;
  /** 'A', 'B'… for a variant; null for the main line, which needs no letter. */
  letter: string | null;
  /** The main line's session this variant left from, or null for the main line. */
  parentSessionId: string | null;
  /**
   * The LINE this variant was started from, or null for the main line.
   *
   * Batch BX. `parentSessionId` says which MEETING it left, and until now that was
   * the only record of where a variant came from — which is why a variant could only
   * be started from a meeting of the main line, and why the session map could only
   * ever draw a branch leaving the top row. This is the line, and it is what makes
   * "a variant of a variant" a thing the data can hold: the two columns come apart
   * the moment a variant that has never met is explored, because then there is no
   * meeting to name and the parent line is the whole answer.
   *
   * Null for a variant written before this column existed too, and the readers treat
   * that as "from the main line", which is true of every variant batch BL could make.
   */
  parentLineId: string | null;
  /**
   * The line this variant was merged INTO, or null.
   *
   * Batch BX, and only ever set on a line whose status is 'adopted'. Kept as its own
   * column rather than derived, because "adopted" used to mean one thing — taken into
   * the main line — and now means "taken into the line named here", which is not
   * always the main one. The session map draws the green return along this, and the
   * tracker says "merged into Variant A" from it.
   */
  mergedIntoLineId: string | null;
  /**
   * Why a dropped variant was dropped, word for word, or null.
   *
   * The same sentence the cards it closed carry — lib/reviews/lines.droppedCardReason
   * built it and drop_review_line wrote it in one transaction — stored on the line as
   * well because the room that opens on a dropped variant has to say it in a banner,
   * and a banner that had to read the review's cards first would be a banner that shows
   * a dropped line's name for a moment and then the reason.
   */
  dropReason: string | null;
  status: LineStatus;
  createdBy: string | null;
  createdByName: string;
  createdAt: string;
  closedAt: string | null;
}

/** What the main line is called everywhere it is named on screen. */
export const MAIN_LINE_NAME = 'Main line';

/**
 * The separator the rest of the app uses between two labels that belong together
 * ("Bracket · Rev B", "Raised on Rev A · still open on Rev C"). A line label is
 * the same kind of thing.
 */
const SEPARATOR = ' · ';

/** The letters a variant may be given, in the order they are handed out. */
const VARIANT_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Read a database value that may be a string, null, or missing entirely. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function lineKind(value: unknown): LineKind | null {
  return value === 'main' || value === 'variant' ? value : null;
}

function lineStatus(value: unknown): LineStatus | null {
  return value === 'active' || value === 'adopted' || value === 'dropped' ? value : null;
}

/**
 * A review_lines row into the app's own shape, or null when it is not one.
 *
 * Null rather than a guess for a row this code has never heard of: a `kind` or a
 * `status` from a later batch is not something to render as though it were one of
 * ours, and dropping the row leaves the map one line short instead of mislabelled.
 */
export function toReviewLine(row: Record<string, unknown> | null | undefined): ReviewLine | null {
  if (!row) return null;
  const id = text(row['id']);
  const reviewId = text(row['review_id']);
  const kind = lineKind(row['kind']);
  if (!id || !reviewId || !kind) return null;
  const rawLetter = text(row['letter']).trim().toUpperCase();
  return {
    id,
    reviewId,
    kind,
    name: text(row['name']),
    // A main line has no letter and never gets one; a variant with an unusable
    // letter keeps null and is rendered by its name alone.
    letter: kind === 'main' || rawLetter === '' ? null : rawLetter,
    parentSessionId: text(row['parent_session_id']) || null,
    // Both null on a row written before batch BX, and both null for the main line
    // whatever the database holds: a main line came from nothing and went nowhere.
    parentLineId: kind === 'main' ? null : text(row['parent_line_id']) || null,
    mergedIntoLineId: kind === 'main' ? null : text(row['merged_into_line_id']) || null,
    dropReason: kind === 'main' ? null : text(row['drop_reason']) || null,
    status: lineStatus(row['status']) ?? 'active',
    createdBy: text(row['created_by']) || null,
    createdByName: text(row['created_by_name']),
    createdAt: text(row['created_at']),
    closedAt: text(row['closed_at']) || null,
  };
}

/** Whether this line is the review's own run of meetings. */
export function isMainLine(line: Pick<ReviewLine, 'kind'> | null | undefined): boolean {
  return line?.kind === 'main';
}

/**
 * The letter a variant is known by, or null for the main line.
 *
 * Falls back to the first letter of the variant's name when it was stored without
 * one — a row written by hand, or by an install that assigned letters later — so a
 * variant called "Weld fix" still reads as "Variant W" rather than as a line with
 * no label at all. The main line never gets a letter: its sessions are S1, S2, S3,
 * and giving it an "A" would make it look like one more variant.
 */
export function variantLetter(line: Pick<ReviewLine, 'kind' | 'letter' | 'name'> | null): string | null {
  if (!line || line.kind !== 'variant') return null;
  if (line.letter) return line.letter;
  const first = line.name.trim().charAt(0).toUpperCase();
  return VARIANT_LETTERS.includes(first) ? first : null;
}

/**
 * "S3" on the main line, "A2" on Variant A.
 *
 * Null when the session has no number, which is a session recorded before `seq`
 * existed and which the backfill in docs/supabase-schema.sql has not reached. A
 * null is the honest answer and the caller renders the card or the stop without a
 * label; "S0" or "S?" would be a number this review never had.
 */
export function sessionLabel(
  line: Pick<ReviewLine, 'kind' | 'letter' | 'name'> | null | undefined,
  seq: number | null | undefined,
): string | null {
  if (!Number.isInteger(seq) || (seq as number) < 1) return null;
  const prefix = isMainLine(line) ? 'S' : (variantLetter(line ?? null) ?? 'S');
  return `${prefix}${seq}`;
}

/**
 * "Main line", or "Variant A" — the short form, for a chip on a card where the
 * variant's own name would not fit and adds nothing the card's reader needs.
 */
export function shortLineLabel(line: Pick<ReviewLine, 'kind' | 'letter' | 'name'> | null | undefined): string | null {
  if (!line) return null;
  if (isMainLine(line)) return MAIN_LINE_NAME;
  const letter = variantLetter(line);
  return letter ? `Variant ${letter}` : 'Variant';
}

/**
 * "Main line", or "Variant A · Weld fix" — the full form, for a heading where
 * there is room for the name the people exploring it gave it.
 *
 * A variant with no usable letter is named on its own ("Weld fix") rather than as
 * "Variant · Weld fix", which would read as a label with a hole in it.
 */
export function lineLabel(line: Pick<ReviewLine, 'kind' | 'letter' | 'name'> | null | undefined): string | null {
  if (!line) return null;
  if (isMainLine(line)) return MAIN_LINE_NAME;
  const letter = variantLetter(line);
  const name = line.name.trim();
  if (!letter) return name || 'Variant';
  return name ? `Variant ${letter}${SEPARATOR}${name}` : `Variant ${letter}`;
}

/**
 * "Main line · S3" / "Variant A · A2" — what a card says about where it came from.
 *
 * Null unless BOTH halves are there. A card whose session has no number still
 * knows its line, and a card whose line row could not be read still has a number,
 * and neither half on its own is the sentence the plan asks for.
 */
export function cardLineLabel(
  line: Pick<ReviewLine, 'kind' | 'letter' | 'name'> | null | undefined,
  seq: number | null | undefined,
): string | null {
  const where = shortLineLabel(line);
  const which = sessionLabel(line, seq);
  if (!where || !which) return null;
  return `${where}${SEPARATOR}${which}`;
}

/**
 * The PartyKit room a line's meetings are held in.
 *
 * The main line keeps the review's own id, so every link already in circulation —
 * a shared URL, an email, a lobby tile, a bookmark from before lines existed —
 * opens exactly the room it always did. A variant gets `<reviewId>~<letter>`,
 * which is a DIFFERENT room: its own live presence, its own audio, and its own
 * scene on the room server, so a meeting exploring the variant cannot put a model
 * on the main line's screen by moving it.
 *
 * `~` because it is legal in a PartyKit room name and cannot appear in a
 * review id, which is a uuid or a lobby-generated slug. A variant with no letter
 * falls back to the main line's room rather than to a room named after nothing:
 * two people in the same meeting is a smaller problem than two people in two
 * rooms who cannot hear each other.
 */
export function partyRoomName(reviewId: string, line: Pick<ReviewLine, 'kind' | 'letter' | 'name'> | null | undefined): string {
  if (!reviewId) return reviewId;
  const letter = variantLetter(line ?? null);
  return letter ? `${reviewId}~${letter}` : reviewId;
}

/** The query parameter a room link carries to say which line it is on. */
export const LINE_QUERY_PARAM = 'line';

/**
 * The room address for a line: `/room/<reviewId>` for the main line, with
 * `?line=<lineId>` for a variant.
 *
 * The main line deliberately carries no parameter, so the address of every review
 * that exists today is unchanged — and so a room link is still a thing a person
 * can read out loud to another person.
 */
export function roomPath(reviewId: string, lineId?: string | null): string {
  if (!reviewId) return '/';
  return lineId ? `/room/${reviewId}?${LINE_QUERY_PARAM}=${lineId}` : `/room/${reviewId}`;
}

/** The line id a room address asks for, or null when it asks for none. */
export function lineIdFromSearch(search: string | null | undefined): string | null {
  if (!search) return null;
  try {
    const value = new URLSearchParams(search).get(LINE_QUERY_PARAM);
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  } catch {
    // An address somebody typed. It cannot name a line, and the room is the main
    // one — which is the answer every link that predates lines gives.
    return null;
  }
}

/**
 * The next letter for a new variant: the first of A…Z no line of this review has
 * taken, then AA, AB… once a review has run out of single letters.
 *
 * Taken from every line including the dropped ones, because a letter is an
 * identity and not a slot: reusing "Variant A" for a new exploration after the
// first one was dropped would leave two different sets of cards both saying they
// came from Variant A, and the whole point of keeping a dropped variant for the
// record is that its cards still say where they came from.
 */
export function nextVariantLetter(lines: readonly Pick<ReviewLine, 'kind' | 'letter' | 'name'>[]): string {
  const taken = new Set<string>();
  for (const line of lines) {
    const letter = variantLetter(line);
    if (letter) taken.add(letter);
  }
  for (const letter of VARIANT_LETTERS) {
    if (!taken.has(letter)) return letter;
  }
  for (const first of VARIANT_LETTERS) {
    for (const second of VARIANT_LETTERS) {
      const pair = `${first}${second}`;
      if (!taken.has(pair)) return pair;
    }
  }
  // 702 variants into one design review. Unreachable, and a label has to be
  // something, so it counts rather than throwing.
  return `V${taken.size + 1}`;
}

/** The review's main line, or null when it has none (and no sessions either). */
export function mainLineOf(lines: readonly ReviewLine[]): ReviewLine | null {
  return lines.find((line) => line.kind === 'main') ?? null;
}

/** One line by id, or null. */
export function lineById(lines: readonly ReviewLine[], id: string | null | undefined): ReviewLine | null {
  if (!id) return null;
  return lines.find((line) => line.id === id) ?? null;
}

/**
 * Lines in the order the map draws them: the main line first, then its variants
 * in the order they were started.
 *
 * Sorted here rather than left to whatever order the database answered in, because
 * the map's rows are positional — a variant that moved between two renders would
 * look like a different variant.
 */
export function orderedLines(lines: readonly ReviewLine[]): ReviewLine[] {
  const byCreated = [...lines].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return [...byCreated.filter((line) => line.kind === 'main'), ...byCreated.filter((line) => line.kind === 'variant')];
}

// ─── Where a line came from, and where it went ───────────────────────────────
// docs/plan/15-sessions-and-variants.md batch BX. A variant used to leave from one
// of the MAIN line's meetings and could only ever be taken back into the main line,
// so "where did this come from" had one answer and "where did it go" had one answer.
// Both are now a line of their own: a variant can be explored from another variant,
// and merged into any line still being explored. Everything below is pure and total —
// it answers for a list with holes in it, for a parent row that was never written,
// and for a chain that somehow loops, because a label worked out from a broken chain
// is a sentence about the review that is not true.

/** Whether a line is still being explored, and therefore still somewhere to go. */
export function isLineActive(line: Pick<ReviewLine, 'status'> | null | undefined): boolean {
  return line?.status === 'active';
}

/**
 * The lines of a review that are still being explored, main line first.
 *
 * This is the list every CHOICE is offered from — the room's "Go to…", the merge
 * chooser, the Lines list, the chip's menu, the tracker's filter — and dropped lines
// are not in it. A line nobody is meeting on any more is a record, and offering it as
// somewhere to go is an offer the room cannot honour.
 */
export function activeLines(lines: readonly ReviewLine[]): ReviewLine[] {
  return orderedLines(lines).filter(isLineActive);
}

/**
 * The lines this one was started from, nearest first: its parent, then that line's
 * parent, and so on up to the main line.
 *
 * Bounded by the size of the list and by a seen-set, so a row whose `parent_line_id`
// points at itself or at one of its own descendants answers with the chain it has
// rather than looping forever in a render. The main line is never IN the chain — it
// has no parent — and a variant written before this column existed has an empty one,
// which every reader answers as "from the main line" because that is the only place
// a variant could come from before batch BX.
 */
export function parentChain(lines: readonly ReviewLine[], lineId: string | null | undefined): ReviewLine[] {
  if (!lineId) return [];
  const chain: ReviewLine[] = [];
  const seen = new Set<string>([lineId]);
  let current = lineById(lines, lineId);
  while (current && current.parentLineId && chain.length < lines.length) {
    if (seen.has(current.parentLineId)) break;
    const parent = lineById(lines, current.parentLineId);
    if (!parent) break;
    seen.add(parent.id);
    chain.push(parent);
    current = parent;
  }
  return chain;
}

/**
 * Whether `lineId` was started, directly or through other variants, from `ancestorId`.
 *
 * The rule the merge chooser and the merge write both need: taking a variant into one
 * of its own descendants would make the descendant its own ancestor, and every card on
 * both lines would end up on a line whose history runs in a circle.
 */
export function isDescendantOf(
  lines: readonly ReviewLine[],
  lineId: string | null | undefined,
  ancestorId: string | null | undefined,
): boolean {
  if (!lineId || !ancestorId || lineId === ancestorId) return false;
  return parentChain(lines, lineId).some((line) => line.id === ancestorId);
}

/** Every line started from this one, at any depth, in the order the map draws them. */
export function descendantsOf(lines: readonly ReviewLine[], lineId: string | null | undefined): ReviewLine[] {
  if (!lineId) return [];
  return orderedLines(lines).filter((line) => isDescendantOf(lines, line.id, lineId));
}

/**
 * The lines a variant may be merged INTO: every line still being explored except
 * itself and its own descendants, main line first.
 *
 * The default the chooser selects is `defaultMergeTarget`, and the two are separate
 * functions because the write in api/reviews/lines.ts has to check the answer against
 * this list and must not simply trust a client that sent one.
 */
export function mergeTargets(lines: readonly ReviewLine[], variant: ReviewLine | null | undefined): ReviewLine[] {
  if (!variant) return [];
  return activeLines(lines).filter(
    (line) => line.id !== variant.id && !isDescendantOf(lines, line.id, variant.id),
  );
}

/**
 * Where a merge should go unless the person says otherwise: the line the variant was
 * started from, when that line is still being explored, and the main line when it is
 * not — a variant whose parent was itself merged continues on the line its parent went
 * to, which is what the merge did to the parent's own active children.
 */
export function defaultMergeTarget(
  lines: readonly ReviewLine[],
  variant: ReviewLine | null | undefined,
): ReviewLine | null {
  const targets = mergeTargets(lines, variant);
  if (targets.length === 0) return null;
  const parent = variant?.parentLineId ? lineById(lines, variant.parentLineId) : null;
  if (parent && targets.some((line) => line.id === parent.id)) return parent;
  return mainLineOf(targets) ?? targets[0];
}

/**
 * The line a variant's own children hang off once it is merged: its merge target.
 *
 * Batch BX. Merging a variant that still has variants of its own is allowed, and this
 * is what makes it safe — its active children are re-parented in the same transaction,
// so a variant started from Variant A keeps a parent that exists and is still being
// explored instead of one that has just been closed.
 */
export function activeChildrenOf(lines: readonly ReviewLine[], lineId: string | null | undefined): ReviewLine[] {
  if (!lineId) return [];
  return orderedLines(lines).filter(
    (line) => line.parentLineId === lineId && line.status === 'active',
  );
}

/**
 * The line whose saved positions a line opens on, as the order to look in.
 *
 * Batch BX, and the reading half of "a variant starts from its parent line's current
 * state". `asset.linePlacements` is one slot per line and a brand new variant has none,
// so the question "where do its models stand" is answered by walking up `parent_line_id`
 * to the first line that HAS a slot — a variant of a variant nobody has moved shows what
// its parent shows, and a variant of the main line shows what the main line shows.
 *
 * The main line is deliberately NOT in the list: its positions live in `asset.placements`
 * and not in a slot of their own, so the list ends at the last variant and
 * lib/scene/placement.placementsForLine falls back to `placements` itself. Empty for the
 * main line, for an ad-hoc room and for an install with no lines, and all three mean the
 * same thing — read `placements`.
 */
export function placementSlotOrder(
  lines: readonly ReviewLine[],
  lineId: string | null | undefined,
): string[] {
  const id = typeof lineId === 'string' ? lineId.trim() : '';
  if (id === '') return [];
  const line = lineById(lines, id);
  // The main line's positions are `asset.placements`, with no id in them, so there is
  // nothing to look up. A line that could NOT be looked up keeps its own id and no
  // chain: the caller then reads its slot and falls back to the main line's, which is
  // the pre-BX answer and the right one for a caller that has no lines in hand.
  if (line?.kind === 'main') return [];
  return [id, ...parentChain(lines, id).filter((each) => each.kind === 'variant').map((each) => each.id)];
}

/**
 * "from Variant A", or "from the main line" — where a variant was started.
 *
 * Batch BX: a variant of a variant has to SAY so, because "Variant B · Lighter frame"
// on its own reads as a second answer to the same question and the point of exploring
// from another variant is that it is a second answer to a DIFFERENT one. Null for the
// main line, which came from nowhere, and null for a variant with no parent that can be
// read — a row from before this column existed is not a row that says where it came
// from, and "from the main line" printed for one would be a guess the map would draw.
 */
export function lineOriginLabel(
  lines: readonly ReviewLine[],
  line: Pick<ReviewLine, 'id' | 'kind' | 'parentLineId'> | null | undefined,
): string | null {
  if (!line || line.kind !== 'variant' || !line.parentLineId) return null;
  const parent = lineById(lines, line.parentLineId);
  if (!parent) return null;
  return `from ${shortLineLabel(parent) ?? 'another line'}`;
}

/**
 * "Variant B · Lighter frame · from Variant A" — the full label plus where it came from.
 *
 * For a heading with room for the whole sentence: the session map's line panel, the
 * lobby's Lines list, the merge chooser. Falls back to `lineLabel` for a variant whose
 * parent cannot be read and for the main line, so every caller can use this one function
 * and get the shorter form where the longer one has nothing to add.
 */
export function lineLabelWithOrigin(
  lines: readonly ReviewLine[],
  line: ReviewLine | null | undefined,
): string | null {
  const base = lineLabel(line);
  if (!base) return null;
  const origin = lineOriginLabel(lines, line);
  return origin ? `${base}${SEPARATOR}${origin}` : base;
}

/**
 * "merged into Variant A 26 Sep" — where a line went, and when.
 *
 * The tracker's sentence about a card the merge moved ("Raised in Variant B · merged
 * into Variant A 26 Sep") and the map's tooltip for the green return both read it.
 * Null unless BOTH halves are there: a line still being explored went nowhere, one
 * merged before this column existed cannot name where, and one with no `closed_at`
 * cannot say when — and a date taken from `updated_at` would be the date somebody last
 * touched a card on it.
 *
 * No separator before the date, and deliberately: this is a clause inside somebody
 * else's sentence, and "Raised in Variant B · merged into Variant A · 26 Sep" reads as
 * three facts about a card when two of them are one fact.
 */
export function mergedIntoLabel(
  lines: readonly ReviewLine[],
  line: Pick<ReviewLine, 'kind' | 'status' | 'mergedIntoLineId' | 'closedAt'> | null | undefined,
): string | null {
  if (!line || line.kind !== 'variant' || line.status !== 'adopted') return null;
  const target = line.mergedIntoLineId ? lineById(lines, line.mergedIntoLineId) : null;
  if (!target) return null;
  const where = shortLineLabel(target);
  const when = line.closedAt ? shortDate(line.closedAt) : null;
  if (!where || !when) return null;
  return `merged into ${where} ${when}`;
}

/**
 * What a line is called in a sentence that compares two of them: "the main line" or
 * "Variant A".
 *
 * The one plain question a merge asks has to name the line the model is being taken
// INTO, and from batch BX that line is not always the main one — so the words follow
// the target rather than being the constant they were.
 */
export function mergeTargetWord(line: ReviewLine | null | undefined): string {
  if (!line) return 'the other line';
  return isMainLine(line) ? `the ${MAIN_LINE_NAME.toLowerCase()}` : shortLineLabel(line) ?? 'the other line';
}

/** How many lines of this review are finished with and hidden by default. */
export function hiddenLineCount(lines: readonly ReviewLine[]): number {
  return lines.filter((line) => line.kind === 'variant' && line.status === 'dropped').length;
}

/**
 * The reason a variant was dropped, without the card's own prefix on it.
 *
 * The sentence a dropped variant's cards carry is "Dropped with Variant A: too
 * expensive to tool" — `droppedCardReason` builds it, and it is the right sentence for
 * a card that has lost its line and has to say which one it was on. `drop_reason`
 * stores that same sentence on the line's own row, because the room that opens on a
 * dropped variant has to say why in a banner and a banner should not have to read the
 * review's cards first. But a banner UNDER that variant's own name reading "This
 * variant was dropped: Dropped with Variant A: …" says the same thing twice, so the
 * prefix goes and what is left is the reason the meeting agreed.
 *
 * Null when the line was dropped before this column existed, when it was not dropped at
 * all, and when all that is stored IS the prefix — and the caller then says "This
 * variant was dropped." and nothing more, which is still the truth.
 */
export function droppedLineReason(
  line: Pick<ReviewLine, 'kind' | 'status' | 'dropReason'> | null | undefined,
): string | null {
  if (!line || line.kind !== 'variant' || line.status !== 'dropped') return null;
  const raw = (line.dropReason ?? '').trim();
  if (raw === '') return null;
  if (!raw.toLowerCase().startsWith('dropped with')) return raw;
  const at = raw.indexOf(':');
  if (at < 0) return raw;
  const rest = raw.slice(at + 1).trim();
  return rest === '' ? null : rest;
}

// ─── A line that is finished with ───────────────────────────────────────────
// docs/plan/15-sessions-and-variants.md batch BL. An adopted or dropped variant is
// kept, greyed, for the record — and "kept for the record" only means something if
// every place its name appears says what happened to it. A filter entry that reads
// "Variant B" for a side line nobody is meeting on any more is an offer to look at
// something that is over; a card that reads "Variant B · B4" for a card closed
// because the variant was dropped hides the reason it was closed.

/**
 * 'adopted' or 'dropped' for a variant that is finished with, null for one still
 * being explored and for the main line — which is never either, because a review
 * that has stopped meeting has not adopted or dropped itself.
 */
export function lineStatusWord(line: Pick<ReviewLine, 'kind' | 'status'> | null | undefined): 'adopted' | 'dropped' | null {
  if (!line || line.kind !== 'variant') return null;
  return line.status === 'adopted' || line.status === 'dropped' ? line.status : null;
}

/**
 * "Variant A · Steel hinge pin · adopted" — the full label plus what became of it.
 *
 * For the tracker's line filter, which lists every line of a review including the
 * finished ones and has nowhere else to put the fact. Identical to `lineLabel` for
 * a line still being explored and for the main line, so a filter that offers three
 * live lines reads exactly as it did before this batch.
 */
export function lineFilterLabel(line: Pick<ReviewLine, 'kind' | 'letter' | 'name' | 'status'> | null | undefined): string | null {
  const base = lineLabel(line);
  if (!base) return null;
  const status = lineStatusWord(line);
  return status ? `${base}${SEPARATOR}${status}` : base;
}

/**
 * "Raised in Variant A · merged into Main line 12 Oct" — what a card says once the
 * variant it was raised on has been taken into another line.
 *
 * Null unless BOTH halves are there. A card with no origin line was raised on the
 * line it is on and has nothing to say about coming from somewhere else — including
 * a card that has always been on the main line, where "Raised in Main line" would
 * be a sentence about nothing; a card whose `adopted_at` was never written says
 * where it was raised and stops there, because a date invented from `updated_at`
 * would be the date somebody last touched the card and not the date the review took
 * it in.
 *
 * `merged` is the clause `mergedIntoLabel` built, and it is OPTIONAL: batch BX is what
 * gave a merge somewhere to go other than the main line, and an install whose database
 * has no `merged_into_line_id` yet cannot name one. Without it the sentence says
 * "adopted 12 Oct", which was the whole of it until then and is still the truth about
 * a card whose target nobody recorded — a line that has since been deleted, say.
 */
export function adoptedCardLabel(
  originLine: Pick<ReviewLine, 'kind' | 'letter' | 'name'> | null | undefined,
  adoptedAt: string | null | undefined,
  merged: string | null | undefined = null,
): string | null {
  if (!originLine || originLine.kind !== 'variant') return null;
  const where = shortLineLabel(originLine);
  if (!where) return null;
  const when = adoptedAt ? shortDate(adoptedAt) : null;
  if (!when) return null;
  return `Raised in ${where}${SEPARATOR}${merged?.trim() || `adopted ${when}`}`;
}

/**
 * "Dropped with Variant A: Too expensive to tool" — the reason stored on every card
 * a dropped variant left open.
 *
 * Written by api/reviews/lines.ts and handed to drop_review_line, which puts the
 * same string on every card it closes: one reason, word for word, on all of them,
 * so that a reviewer who finds one of these cards in six months' time is reading
 * the sentence the meeting agreed rather than a summary of it. Null for a variant
 * with no usable label or no reason, because "Dropped with : " is not a sentence —
 * and null for the main line, which is never dropped and which would otherwise
 * produce a card saying "Dropped with Main line" about the review's own history.
 */
export function droppedCardReason(
  variant: Pick<ReviewLine, 'kind' | 'letter' | 'name'> | null | undefined,
  reason: string | null | undefined,
): string | null {
  if (!variant || variant.kind !== 'variant') return null;
  const where = shortLineLabel(variant);
  const why = reason?.trim();
  if (!where || !why) return null;
  return `Dropped with ${where}: ${why}`;
}

/**
 * "Closed — dropped with Variant A: Too expensive to tool" — how the tracker shows
 * a card that was closed because the variant exploring it was dropped.
 *
 * The stored reason is a sentence of its own ("Dropped with …") and this is a
 * clause after the word "Closed", so the first letter goes down: the alternative is
 * "Closed — Dropped with", which reads as two headings that have collided. Null for
 * a card with no reason, which is every card closed by hand — those are described by
 * their status and by lib/trackerContinuity's own line, and inventing a reason for
 * them would be inventing a decision.
 */
export function closedCardLabel(closedReason: string | null | undefined): string | null {
  const reason = closedReason?.trim();
  if (!reason) return null;
  return `Closed — ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`;
}

