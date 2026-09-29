// Meeting → tracker.
//
// One call, at meeting-end, turning what happened in a room into a session row
// and one item row per card. Everything the tracker knows about a meeting is
// written here, which is why the design review's continuity is written here too:
// a card that does not say which revision of which product it was raised on is a
// card the tracker can only list, and the plan's whole ask was that it be able to
// say "raised on Rev A · still open on Rev C" instead
// (docs/plan/14-rooms-models-admin-ai.md batch BC).
//
// Nothing here may break a meeting. Every failure is logged and answered with
// null: a meeting that ends without reaching the tracker is a lost record, which
// is bad; a meeting that cannot end is worse.
//
// WHAT THIS WRITES IS ONLY WHAT THIS MEETING PRODUCED. The cards a meeting started
// with — the ones its line was still carrying from the sessions before it, which
// the room shows in the Capture panel's "Carried over" group — are tracker items
// that already exist, and they are never in `insightCards`, so they are never
// inserted again. A risk raised in S2 and still open in S4 is one row with one
// history, not three copies of itself.

import { supabase } from './supabase';
import { InsightCard } from '../types';
import type { SceneModel } from './scene/roomScene';
import {
  listModelRevisions,
  revisionIdForPart,
  revisionsOnScreen,
  type ModelRevision,
} from './reviews/revisionsRepo';
import { nextSessionSeq, resolveLine } from './reviews/linesRepo';
import type { TranscriptRow } from './capture/transcriptText';

/** A node id somebody pointed at, by the name the room knew it by. */
export type PartNames = Record<string, string>;

export async function flushSessionToTracker(opts: {
  roomId: string;
  insightCards: InsightCard[];
  participantCount: number;
  /**
   * Who attended, by name — this browser's person and everybody else in the room,
   * already deduplicated by lib/identity.attendeeNames.
   *
   * Written next to `participant_count` rather than instead of it: the count is
   * all a session recorded before this column existed has, and the session map's
   * panel falls back to it. Absent means the caller did not know — an ad-hoc room
   * with no presence — and the row then gets an empty list, not a guess.
   */
  attendeeNames?: string[];
  modelName: string | null;
  labels?: Record<string, string>;
  /**
   * The design review this meeting was held in, or null for an ad-hoc room
   * nobody curated. Null is a first-class answer and not a missing one: such a
   * session is recorded exactly as it always was, with review_id NULL and no
   * revisions, and the tracker shows it under "no design review".
   */
  reviewId?: string | null;
  /**
   * The scene's models, so the revisions that were actually VISIBLE can be
   * picked out of the review's history. Hidden revisions — the ones Compare put
   * up and then took down, the Rev A a Rev B superseded — are not "on screen"
   * and must not be recorded as what the meeting was looking at.
   */
  onScreen?: readonly Pick<SceneModel, 'line' | 'revision' | 'visible'>[] | null;
  /** Part names for the ids cards point at. See store.ts's pointedAtPartNames. */
  partNames?: PartNames;
  /**
   * The meeting's transcript, when the meeting asked for it to be kept — an empty
   * list (the default) when it did not.
   *
   * Rows of `{ t, speaker, text }` with `{ t, speaker, pointing, untilMs }` among
   * them when "where people were pointing at" was asked for too, sorted by `t` and
   * capped by lib/capture/transcript. Written on the session's own row so the session
   * map can offer the same .txt the person who stopped the recording could download,
   * weeks later and to somebody who was not in the room.
   *
   * An EMPTY list leaves the column out of the INSERT rather than writing NULL to it,
   * which is deliberate: a deployment whose database has not had
   * docs/supabase-schema.sql re-applied since this column was added would fail the
   * whole insert on an unknown column, and a meeting that is not recorded is a worse
   * answer than a transcript that is not stored. Every meeting that did not ask for
   * one is recorded exactly as it was before.
   */
  transcript?: TranscriptRow[];
  /**
   * The line of the design review this meeting was held on — a review_lines.id, or
   * null when the room did not know one.
   *
   * Null is not "no line" but "the room could not say", and the difference matters:
   * a meeting in a curated review always belongs to a line, so this module works the
   * main line out for itself (resolveLine → ensureMainLine) rather than recording a
   * session the map cannot place. An ad-hoc room has no review and so has no line
   * either, and that stays exactly as it was.
   */
  lineId?: string | null;
}): Promise<string | null> {
  const { roomId, insightCards, participantCount, modelName, labels } = opts;
  const transcript = opts.transcript ?? [];

  // A meeting that produced NOTHING is not recorded: no row, no cards, no minutes.
  // That is unchanged, and it is what keeps an empty room from littering a review's
  // line with sessions nobody met in. What batch BU added is that a transcript
  // somebody asked to keep IS something the meeting produced — the person who
  // stopped the recording may have chosen "save the transcript with this meeting"
  // and chosen NOT to generate cards, and refusing the row here would silently drop
  // the one thing they did ask for.
  if (insightCards.length === 0 && transcript.length === 0) return null;

  const reviewId = opts.reviewId ?? null;
  const partNames = opts.partNames ?? {};

  // The revisions this meeting was looking at. Resolved here rather than passed
  // in because the caller has a SCENE (lines, letters, hashes) and the tracker
  // needs ROWS (uuids), and the only thing that turns one into the other is a
  // read of model_revisions — which is this module's business, not the room's.
  const revisions = reviewId
    ? revisionsOnScreen(await listModelRevisions(reviewId), opts.onScreen ?? [])
    : [];

  // Which line this meeting continues, and which number it is on it. Read here
  // rather than in the room for the same reason as the revisions: numbering a
  // session is the tracker's business, and the room only knows the line it was
  // opened on. `seq` is one more than the line's highest, so a meeting somebody
  // deleted from the tracker does not hand its number to this one.
  const line = reviewId ? await resolveLine(reviewId, opts.lineId ?? null) : null;
  const seq = line ? await nextSessionSeq(line.id) : null;

  // 1. Create the session record
  const { data: session, error: sessionErr } = await supabase
    .from('tracker_sessions')
    .insert({
      room_id: roomId,
      title: `Design Review — ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`,
      ended_at: new Date().toISOString(),
      participant_count: participantCount,
      attendee_names: opts.attendeeNames ?? [],
      model_name: modelName,
      labels: labels ?? {},
      review_id: reviewId,
      revision_ids: revisions.map((revision) => revision.id),
      line_id: line?.id ?? null,
      seq,
      // Only when there is one to store: see the `transcript` option for why an
      // absent column must not fail the insert that records the meeting.
      ...(transcript.length > 0 ? { transcript } : {}),
    })
    .select()
    .single();

  if (sessionErr || !session) {
    console.error('[tracker] failed to create session:', sessionErr);
    return null;
  }

  // 2. Insert all insight cards as tracker items
  const items = insightCards.map(card => {
    const part = cardPart(card, partNames, revisions);
    return {
      session_id: session.id,
      type: card.type,
      title: card.title,
      description: card.description,
      priority: card.details.priority,
      status: card.details.status,
      assignee: card.details.assignee ?? null,
      due_date: card.details.dueDate ?? null,
      component_reference: card.details.componentReference ?? null,
      department: card.details.department ?? null,
      agent_id: card.agentId,
      source_message_ids: card.sourceMessageIds ?? null,
      affected_requirement_ids: card.affectedRequirementIds ?? null,
      impact: card.details.impact ?? null,
      mitigation_strategy: card.details.mitigationStrategy ?? null,
      design_driver: card.details.designDriver ?? null,
      tradeoff_analysis: card.details.tradeoffAnalysis ?? null,
      review_id: reviewId,
      raised_on_revision: part.revisionId,
      part_node_id: part.nodeId,
      part_name: part.name,
      // An agent's card is the default and the only kind that existed before
      // batch BG; a hand-made one carries the name of whoever typed it.
      source: card.source === 'manual' ? 'manual' : 'ai',
      created_by_name: card.source === 'manual' ? (card.createdByName ?? null) : null,
      // Both halves of "where this card came from". They are the same line here and
      // only come apart later: adopting a variant into the main line (batch BL)
      // moves line_id and leaves origin_line_id alone, which is what lets the
      // tracker keep saying the card was raised in Variant A after it has joined
      // the main line's board.
      line_id: line?.id ?? null,
      origin_line_id: line?.id ?? null,
    };
  });

  const { error: itemsErr } = await supabase
    .from('tracker_items')
    .insert(items);

  if (itemsErr) {
    console.error('[tracker] failed to insert items:', itemsErr);
  }

  return session.id;
}

/** What a card was raised on and about, as far as this meeting can say. */
interface CardOrigin {
  revisionId: string | null;
  nodeId: string | null;
  name: string | null;
}

/**
 * Which revision and which part a card belongs to.
 *
 * The part is the card's `componentReference`, but only when it is one: that
 * field is free text the extraction model fills in, and it is only constrained to
 * the model tree's ids when the extraction was given a tree. So it counts as a
 * part when the pointing timeline knows the id — somebody was pointing at it — or
 * when it carries the node-id prefix of a revision on screen, which no invented
 * string can do by accident. Otherwise the card is about the meeting, not about
 * a mesh, and part_node_id stays NULL rather than holding a guess.
 *
 * The revision is the one that part belongs to, or — for a card with no part,
 * and for a part from a built-in preset with no stored revision — the first
 * revision on screen, which is the product the meeting was there to look at.
 * NULL when the meeting had no stored revisions at all, which is every meeting
 * held before model_revisions existed and every ad-hoc one.
 */
function cardPart(
  card: InsightCard,
  partNames: PartNames,
  revisions: readonly ModelRevision[],
): CardOrigin {
  const reference = card.details.componentReference?.trim() ?? '';
  const fromTimeline = reference !== '' && partNames[reference] !== undefined;
  const revisionOfPart = reference === '' ? null : revisionIdForPart(reference, revisions);
  const nodeId = fromTimeline || revisionOfPart !== null ? reference : null;

  const first = revisions.length > 0 ? revisions[0].id : null;
  return {
    revisionId: revisionOfPart ?? first,
    nodeId,
    name: nodeId === null ? null : (partNames[nodeId] ?? null),
  };
}
