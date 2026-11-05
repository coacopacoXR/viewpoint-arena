// Which parts of the model a decision card's audio was about.
//
// Task 09b. The user's ask was "a way to check what component is linked to certain
// pieces of audio … in the decision cards", and the three sources were already in the
// room, unconnected: a card carries `sourceMessageIds`, a live transcript line carries
// `offsetMs`, and the pointing timeline carries who had their laser on which part from
// when to when. This module is the join, and it is pure — no store, no DOM, no clock of
// its own — so the overlap maths and the merge rules are testable without rendering
// anything.
//
// WHAT A "SPAN" IS. The live transcript has a start per line and no duration
// (lib/capture/meetingMinutes.liveTranscriptChunks sets startMs === endMs), so a line's
// span is the window lib/selectSegmentsForLine already decided a line occupies:
// [offsetMs, offsetMs + LINE_WINDOW_MS). Reusing that constant rather than inventing a
// second window is what makes the "pointed by" time on a card's chip agree with the 👉
// badge the same line shows in the transcript — two different answers about one moment
// would look like a bug in one of them.
//
// WHAT COUNTS AS "IN THE SCENE". A part that no longer exists keeps its name and is
// marked `missing`: a card raised three meetings ago about a revision that has since been
// replaced is still a card about that part, and a chip that silently dropped it would
// make the card look unattributed. The oracle is the room's per-node state, not
// store.ts's `sceneComponents` — that list is flattened through componentIndex's
// 200-component cap, so on a 3 000-part model it would call a part that is very much on
// screen "missing".

import { LINE_WINDOW_MS } from '../selectSegmentsForLine';
import type { PointingSegment } from '../pointingTimelineStore';
import type { ChatMessage, InsightCard } from '../../types';

/** The half of a card this module reads. */
export type LinkedCard = Pick<InsightCard, 'sourceMessageIds' | 'details'>;

/** One stretch of the recording a card was read from. */
export interface CardAudioSpan {
  /** The transcript line's id — what a click scrolls the panel to and flashes. */
  messageId: string;
  /** Milliseconds into the recording. */
  startMs: number;
  endMs: number;
  /** Who said it, or '' when the line carries no name. */
  speaker: string;
}

/** One person's share of the time a part was pointed at inside a card's spans. */
export interface CardPointer {
  userId: string;
  userName: string;
  ms: number;
}

export interface CardComponentLink {
  /** The scene node's id, or the model's own words when it named no id. */
  partId: string;
  partName: string;
  /**
   * Total milliseconds this part was pointed at across the card's spans. Zero when the
   * only reason it is here is that the model named it.
   */
  pointedMs: number;
  /** Who pointed at it and for how long, longest first. */
  pointedBy: CardPointer[];
  /**
   * The model put this part in `details.componentReference`. Kept as a flag beside the
   * pointing rather than as a separate list, because the two usually name the SAME part
   * (the extraction prompt is told to prefer a part the speaker was pointing at) and one
   * chip reading "pointed by Maria 0:06 · named by the model" is one fact, where two
   * chips would read as two parts.
   *
   * On a hand-made card the reference is a person's choice rather than a model's. The flag
   * means the same thing either way — this is what `details.componentReference` said, and
   * not something the room was observed doing — and components/UI/CardAudioLinks is what
   * words the two differently.
   */
  namedByModel: boolean;
  /** No part with this id is in the scene any more. The name is kept; the click is not offered. */
  missing: boolean;
}

export interface CardAudioLinks {
  spans: CardAudioSpan[];
  components: CardComponentLink[];
}

export interface CardAudioLinksInput {
  card: LinkedCard;
  /** The room's chat history, in which the card's source lines are looked up. */
  messages: readonly ChatMessage[];
  /** The room's pointing timeline. */
  segments: readonly PointingSegment[];
  /**
   * Node id → the name the scene gives it. Optional, and only used to LABEL a part the
   * model named but nobody pointed at: a pointing segment carries its own partName, so
   * a part that was pointed at is named whether or not this map is supplied.
   */
  partNames?: Readonly<Record<string, string>>;
  /**
   * The room's per-node state, keyed by node id. Optional: when it is absent the answer
   * to "is this part still in the scene" is "cannot tell", and nothing is marked
   * missing — which is right for a reader that has no scene, and wrong for one that has
   * an empty one, so callers pass it whenever they have it.
   */
  knownParts?: Readonly<Record<string, unknown>>;
}

/**
 * Whether there is anything to look up at all.
 *
 * Cheap on purpose, and the guard both hosts use before they read the scene's part
 * names: a card about the meeting rather than about a mesh has neither a source line nor
 * a component on it, and flattening a scene tree to find that out is a cost paid per
 * card per render.
 */
export function cardHasLinks(card: LinkedCard): boolean {
  return (
    (card.sourceMessageIds?.length ?? 0) > 0 ||
    (card.details.componentReference ?? '').trim() !== ''
  );
}

/** Whether the row has anything to say. A card with no link at all renders nothing. */
export function hasCardAudioLinks(links: CardAudioLinks): boolean {
  return links.spans.length > 0 || links.components.length > 0;
}

/**
 * Whether a transcript line belongs to the recording that started at `startedAt`.
 *
 * The id is the key (`live-<startedAt>-…`, stamped by lib/useLiveTranscript) and the same
 * one `liveTranscriptChunks` and `buildTranscript` select by. It is what stops a card from
 * an earlier recording in the same room offering a ▶ that plays the wrong minute of the
 * one recording this browser still holds.
 */
export function lineIsFromRecording(messageId: string, startedAt: number): boolean {
  return startedAt > 0 && messageId.startsWith(`live-${startedAt}-`);
}

export function cardAudioLinks(input: CardAudioLinksInput): CardAudioLinks {
  const spans = spansOf(input.card, input.messages);
  return { spans, components: componentsOf(input.card, spans, input.segments, input.partNames, input.knownParts) };
}

/**
 * The card's source lines, as time ranges, in the order they were said.
 *
 * Two kinds of line produce no span and are skipped rather than answered as a zero-length
 * one: a line the room no longer holds (a card carried over from another meeting, a
 * transcript that has gone) and a line with no `offsetMs` (a system message, a gap line,
 * anything from before the per-speaker transcript existed). Neither has audio behind it,
 * and a span of [0, 8000) invented for one would play the start of the recording and
 * scroll to nothing.
 */
function spansOf(card: LinkedCard, messages: readonly ChatMessage[]): CardAudioSpan[] {
  const ids = card.sourceMessageIds ?? [];
  if (ids.length === 0) return [];

  const byId = new Map<string, ChatMessage>();
  for (const message of messages) byId.set(message.id, message);

  const spans: CardAudioSpan[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    // A model can list the same line twice, and the same span twice is the same chip twice.
    if (seen.has(id)) continue;
    seen.add(id);
    const line = byId.get(id);
    if (!line) continue;
    if (typeof line.offsetMs !== 'number' || !Number.isFinite(line.offsetMs)) continue;
    const startMs = Math.max(0, Math.round(line.offsetMs));
    spans.push({
      messageId: id,
      startMs,
      endMs: startMs + LINE_WINDOW_MS,
      speaker: (line.speakerName ?? '').trim(),
    });
  }
  // In the order they were said rather than the order the model listed them, so the row
  // of timestamps reads left to right the way the meeting did.
  spans.sort((a, b) => a.startMs - b.startMs);
  return spans;
}

interface Accumulated {
  partId: string;
  partName: string;
  pointedMs: number;
  namedByModel: boolean;
  byUser: Map<string, CardPointer>;
}

function componentsOf(
  card: LinkedCard,
  spans: readonly CardAudioSpan[],
  segments: readonly PointingSegment[],
  partNames?: Readonly<Record<string, string>>,
  knownParts?: Readonly<Record<string, unknown>>,
): CardComponentLink[] {
  const accumulated = new Map<string, Accumulated>();

  const entry = (partId: string, partName: string): Accumulated => {
    let found = accumulated.get(partId);
    if (found === undefined) {
      found = { partId, partName: '', pointedMs: 0, namedByModel: false, byUser: new Map() };
      accumulated.set(partId, found);
    }
    // The LAST name the room called it, which is the rule lib/capture/transcript's
    // mergedPointing already applies: a part renamed by a second model importing over the
    // first is shown as the room last showed it.
    if (partName !== '') found.partName = partName;
    return found;
  };

  for (const span of spans) {
    for (const segment of segments) {
      // Everybody's pointing, not just the speaker's: "this" in one person's sentence is
      // often the part somebody else has the laser on, and selectSegmentsForLine's
      // same-speaker rule is about labelling a line, not about what a card is about.
      if (!segment.partId) continue;
      const overlap = Math.min(segment.toMs, span.endMs) - Math.max(segment.fromMs, span.startMs);
      if (overlap <= 0) continue;
      const found = entry(segment.partId, (segment.partName ?? '').trim());
      found.pointedMs += overlap;
      const key = segment.userId !== '' ? segment.userId : segment.userName;
      const pointer = found.byUser.get(key) ?? {
        userId: segment.userId,
        userName: (segment.userName ?? '').trim(),
        ms: 0,
      };
      pointer.ms += overlap;
      if (pointer.userName === '') pointer.userName = (segment.userName ?? '').trim();
      found.byUser.set(key, pointer);
    }
  }

  const reference = (card.details.componentReference ?? '').trim();
  if (reference !== '') {
    entry(reference, partNames?.[reference] ?? '').namedByModel = true;
  }

  const links: CardComponentLink[] = [];
  for (const found of accumulated.values()) {
    links.push({
      partId: found.partId,
      // Fall back to the scene's own name, then to the id: a part the model named and
      // nobody pointed at has no name anywhere else, and a chip reading "m3f9a2b1_14" is
      // still a chip a person can match against the model tree.
      partName: found.partName !== '' ? found.partName : (partNames?.[found.partId] ?? found.partId),
      pointedMs: found.pointedMs,
      pointedBy: [...found.byUser.values()].sort((a, b) => b.ms - a.ms),
      namedByModel: found.namedByModel,
      missing: knownParts !== undefined && knownParts[found.partId] === undefined,
    });
  }
  // Longest-pointed first, because that is the part the audio was mostly about. The name
  // breaks a tie so the order is stable rather than dependent on the order two Maps
  // happened to be filled in.
  links.sort((a, b) => b.pointedMs - a.pointedMs || a.partName.localeCompare(b.partName));
  return links;
}

/**
 * `mm:ss`, minutes zero-padded — "01:36" for a span's start, "00:12" for twelve seconds
 * of pointing. The padding is what makes a row of timestamps line up.
 *
 * The same shape components/UI/RecordingStoppedPanel's exported `formatElapsed` gives,
 * written again here rather than imported: that module pulls in lib/RecordingContext, and
 * a card row in the Capture deck must not drag the recording provider's whole dependency
 * graph into every panel that renders one. Hours are not handled because a span is eight
 * seconds long and a pointed-at total is a minute at most.
 */
export function formatMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
