// Which parts of the model a card's audio was about — lib/capture/cardComponents.ts.
//
// Task 09b. The join is pure, so this is the whole of its behaviour pinned without a
// component in sight: the overlap maths against a line's window, the merge and sort rules
// for a part that was pointed at twice or by two people, the model's own attribution kept
// distinguishable from "somebody had their laser on it", and the four ways a card can have
// nothing to show.
//
// A line's window is lib/selectSegmentsForLine's LINE_WINDOW_MS, which is what makes the
// time on a card's chip agree with the 👉 badge the same line already shows.

import { describe, it, expect } from 'vitest';
import {
  cardAudioLinks,
  cardHasLinks,
  formatMs,
  hasCardAudioLinks,
  lineIsFromRecording,
} from '../cardComponents';
import { LINE_WINDOW_MS } from '../../selectSegmentsForLine';
import type { PointingSegment } from '../../pointingTimelineStore';
import type { ChatMessage, InsightCard } from '../../../types';

const RECORDING_START = 1_700_000_000_000;

/** A live transcript line, stamped the way lib/useLiveTranscript stamps one. */
function line(offsetMs: number | undefined, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `live-${RECORDING_START}-${offsetMs ?? 'nooffset'}`,
    agentId: '',
    text: 'something said',
    timestamp: RECORDING_START + (offsetMs ?? 0),
    speakerId: 'maria',
    speakerName: 'Maria',
    ...(offsetMs === undefined ? {} : { offsetMs }),
    ...overrides,
  };
}

function segment(fromMs: number, toMs: number, overrides: Partial<PointingSegment> = {}): PointingSegment {
  return {
    userId: 'maria',
    userName: 'Maria',
    partId: 'node-14',
    partName: 'Left Ear Cup',
    source: 'laser',
    fromMs,
    toMs,
    ...overrides,
  };
}

function card(overrides: Partial<InsightCard> = {}): InsightCard {
  return {
    id: 'insight-1',
    type: 'RISK',
    agentId: '1',
    title: 'Clearance too tight',
    description: 'It will not assemble.',
    timestamp: RECORDING_START,
    details: { priority: 'High', status: 'Open' },
    ...overrides,
  };
}

/** One line at 10 s, so its span is [10 000, 10 000 + LINE_WINDOW_MS). */
const LINE_AT_10S = line(10_000);
const SPAN_START = 10_000;
const SPAN_END = SPAN_START + LINE_WINDOW_MS;

describe('the overlap maths', () => {
  it('counts only the part of a pointing segment that falls inside the line’s window', () => {
    const { components } = cardAudioLinks({
      card: card({ sourceMessageIds: [LINE_AT_10S.id] }),
      messages: [LINE_AT_10S],
      // Starts before the line, ends inside it: 2 s of it are somebody else's moment.
      segments: [segment(SPAN_START - 2_000, SPAN_START + 3_000)],
    });

    expect(components).toHaveLength(1);
    expect(components[0].pointedMs).toBe(3_000);
    expect(components[0].pointedBy).toEqual([{ userId: 'maria', userName: 'Maria', ms: 3_000 }]);
  });

  it('counts a segment that runs past the end of the window only up to the window', () => {
    const { components } = cardAudioLinks({
      card: card({ sourceMessageIds: [LINE_AT_10S.id] }),
      messages: [LINE_AT_10S],
      segments: [segment(SPAN_END - 1_000, SPAN_END + 60_000)],
    });

    expect(components[0].pointedMs).toBe(1_000);
  });

  it('counts a segment that covers the whole window as the whole window', () => {
    const { components } = cardAudioLinks({
      card: card({ sourceMessageIds: [LINE_AT_10S.id] }),
      messages: [LINE_AT_10S],
      segments: [segment(0, 600_000)],
    });

    expect(components[0].pointedMs).toBe(LINE_WINDOW_MS);
  });

  it('ignores a segment that stops exactly where the window starts, and one that starts exactly where it ends', () => {
    // The window is end-exclusive, the same way selectSegmentsForLine reads it: a laser
    // that left the part at the instant the line began was not on it while it was said.
    const { components } = cardAudioLinks({
      card: card({ sourceMessageIds: [LINE_AT_10S.id] }),
      messages: [LINE_AT_10S],
      segments: [segment(SPAN_START - 5_000, SPAN_START), segment(SPAN_END, SPAN_END + 5_000)],
    });

    expect(components).toEqual([]);
  });

  it('ignores a zero-length segment', () => {
    const { components } = cardAudioLinks({
      card: card({ sourceMessageIds: [LINE_AT_10S.id] }),
      messages: [LINE_AT_10S],
      segments: [segment(SPAN_START + 1_000, SPAN_START + 1_000)],
    });

    expect(components).toEqual([]);
  });

  it('counts pointing by somebody other than the speaker', () => {
    // "this will not assemble" is usually about the part somebody ELSE has the laser on.
    // selectSegmentsForLine's same-speaker rule is about labelling a line, not about what
    // a card is about.
    const { components } = cardAudioLinks({
      card: card({ sourceMessageIds: [LINE_AT_10S.id] }),
      messages: [LINE_AT_10S],
      segments: [
        segment(SPAN_START, SPAN_START + 4_000, {
          userId: 'pete',
          userName: 'Pete',
          partId: 'node-22',
          partName: 'Headband',
        }),
      ],
    });

    expect(components).toHaveLength(1);
    expect(components[0].partName).toBe('Headband');
    expect(components[0].pointedBy).toEqual([{ userId: 'pete', userName: 'Pete', ms: 4_000 }]);
  });

  it('spans two windows for a card that came from two lines', () => {
    const second = line(30_000);
    const { spans, components } = cardAudioLinks({
      card: card({ sourceMessageIds: [LINE_AT_10S.id, second.id] }),
      messages: [LINE_AT_10S, second],
      segments: [segment(10_000, 12_000), segment(30_000, 33_000)],
    });

    expect(spans).toHaveLength(2);
    // 2 s from the first window, 3 s from the second, merged into one chip.
    expect(components[0].pointedMs).toBe(5_000);
  });
});

describe('the span a card came from', () => {
  it('is the line’s offset plus the window a transcript line occupies', () => {
    const { spans } = cardAudioLinks({
      card: card({ sourceMessageIds: [LINE_AT_10S.id] }),
      messages: [LINE_AT_10S],
      segments: [],
    });

    expect(spans).toEqual([
      { messageId: LINE_AT_10S.id, startMs: 10_000, endMs: 10_000 + LINE_WINDOW_MS, speaker: 'Maria' },
    ]);
  });

  it('comes out in the order the lines were said, not the order the model listed them', () => {
    const early = line(4_000);
    const late = line(90_000);
    const { spans } = cardAudioLinks({
      card: card({ sourceMessageIds: [late.id, early.id] }),
      messages: [early, late],
      segments: [],
    });

    expect(spans.map((s) => s.startMs)).toEqual([4_000, 90_000]);
  });

  it('is one span for a line a model listed twice', () => {
    const { spans } = cardAudioLinks({
      card: card({ sourceMessageIds: [LINE_AT_10S.id, LINE_AT_10S.id] }),
      messages: [LINE_AT_10S],
      segments: [],
    });

    expect(spans).toHaveLength(1);
  });

  it('clamps a line stamped before the recording started', () => {
    const negative = line(-500);
    const { spans } = cardAudioLinks({
      card: card({ sourceMessageIds: [negative.id] }),
      messages: [negative],
      segments: [],
    });

    expect(spans[0].startMs).toBe(0);
  });
});

describe('sort and merge', () => {
  it('merges two people on one part into one chip, longest first', () => {
    const { components } = cardAudioLinks({
      card: card({ sourceMessageIds: [LINE_AT_10S.id] }),
      messages: [LINE_AT_10S],
      segments: [
        segment(SPAN_START, SPAN_START + 2_000, { userId: 'pete', userName: 'Pete' }),
        segment(SPAN_START + 1_000, SPAN_START + 6_000),
      ],
    });

    expect(components).toHaveLength(1);
    expect(components[0].pointedMs).toBe(7_000);
    expect(components[0].pointedBy.map((p) => p.userName)).toEqual(['Maria', 'Pete']);
  });

  it('merges one person pointing twice at the same part into one share', () => {
    const { components } = cardAudioLinks({
      card: card({ sourceMessageIds: [LINE_AT_10S.id] }),
      messages: [LINE_AT_10S],
      // The timeline is sampled at 2 Hz, so a hand that moves is several segments.
      segments: [segment(SPAN_START, SPAN_START + 1_000), segment(SPAN_START + 1_000, SPAN_START + 2_500)],
    });

    expect(components[0].pointedBy).toEqual([{ userId: 'maria', userName: 'Maria', ms: 2_500 }]);
  });

  it('puts the part pointed at longest first', () => {
    const { components } = cardAudioLinks({
      card: card({ sourceMessageIds: [LINE_AT_10S.id] }),
      messages: [LINE_AT_10S],
      segments: [
        segment(SPAN_START, SPAN_START + 1_000, { partId: 'node-22', partName: 'Headband' }),
        segment(SPAN_START, SPAN_START + 6_000, { partId: 'node-14', partName: 'Left Ear Cup' }),
        segment(SPAN_START, SPAN_START + 3_000, { partId: 'node-31', partName: 'Hinge pin' }),
      ],
    });

    expect(components.map((c) => c.partName)).toEqual(['Left Ear Cup', 'Hinge pin', 'Headband']);
  });

  it('keeps the last name the room called a part', () => {
    const { components } = cardAudioLinks({
      card: card({ sourceMessageIds: [LINE_AT_10S.id] }),
      messages: [LINE_AT_10S],
      segments: [
        segment(SPAN_START, SPAN_START + 1_000, { partName: 'Ear Cup' }),
        segment(SPAN_START + 1_000, SPAN_START + 2_000, { partName: 'Left Ear Cup (rev B)' }),
      ],
    });

    expect(components[0].partName).toBe('Left Ear Cup (rev B)');
  });

  it('breaks a tie by name, so the order does not depend on the order segments arrived in', () => {
    const input = {
      card: card({ sourceMessageIds: [LINE_AT_10S.id] }),
      messages: [LINE_AT_10S],
    };
    const forwards = cardAudioLinks({
      ...input,
      segments: [
        segment(SPAN_START, SPAN_START + 2_000, { partId: 'b', partName: 'Beta' }),
        segment(SPAN_START, SPAN_START + 2_000, { partId: 'a', partName: 'Alpha' }),
      ],
    });
    const backwards = cardAudioLinks({
      ...input,
      segments: [
        segment(SPAN_START, SPAN_START + 2_000, { partId: 'a', partName: 'Alpha' }),
        segment(SPAN_START, SPAN_START + 2_000, { partId: 'b', partName: 'Beta' }),
      ],
    });

    expect(forwards.components.map((c) => c.partId)).toEqual(['a', 'b']);
    expect(backwards.components.map((c) => c.partId)).toEqual(['a', 'b']);
  });
});

describe('named by the model, and pointed at', () => {
  it('marks the model’s own attribution', () => {
    const { components } = cardAudioLinks({
      card: card({ details: { priority: 'High', status: 'Open', componentReference: 'node-14' } }),
      messages: [],
      segments: [],
      partNames: { 'node-14': 'Left Ear Cup' },
    });

    expect(components).toEqual([
      {
        partId: 'node-14',
        partName: 'Left Ear Cup',
        pointedMs: 0,
        pointedBy: [],
        namedByModel: true,
        missing: false,
      },
    ]);
  });

  it('merges the model’s attribution into the part that was also pointed at, rather than listing it twice', () => {
    const { components } = cardAudioLinks({
      card: card({
        sourceMessageIds: [LINE_AT_10S.id],
        details: { priority: 'High', status: 'Open', componentReference: 'node-14' },
      }),
      messages: [LINE_AT_10S],
      segments: [segment(SPAN_START, SPAN_START + 6_000)],
    });

    expect(components).toHaveLength(1);
    expect(components[0].namedByModel).toBe(true);
    expect(components[0].pointedMs).toBe(6_000);
    expect(components[0].pointedBy).toHaveLength(1);
  });

  it('reads a part the model named and nobody pointed at after the ones they did', () => {
    const { components } = cardAudioLinks({
      card: card({
        sourceMessageIds: [LINE_AT_10S.id],
        details: { priority: 'High', status: 'Open', componentReference: 'node-99' },
      }),
      messages: [LINE_AT_10S],
      segments: [segment(SPAN_START, SPAN_START + 1_000)],
      partNames: { 'node-99': 'Cable gland' },
    });

    expect(components.map((c) => c.partName)).toEqual(['Left Ear Cup', 'Cable gland']);
    expect(components[1].pointedMs).toBe(0);
  });

  it('sorts by overlap first, so a part the model named comes after one a laser crossed', () => {
    const { components } = cardAudioLinks({
      card: card({
        sourceMessageIds: [LINE_AT_10S.id],
        details: { priority: 'High', status: 'Open', componentReference: 'node-99' },
      }),
      messages: [LINE_AT_10S],
      segments: [segment(SPAN_START, SPAN_START + 1)],
      partNames: { 'node-99': 'Cable gland' },
    });

    // Overlap time is the sort, and 1 ms is a laser crossing a part rather than a decision
    // about it — but it is still something the room did, where "named by the model" is a
    // claim the model made. The chip says which is which, so the order can stay one rule.
    expect(components.map((c) => c.partId)).toEqual(['node-14', 'node-99']);
    expect(components[1].namedByModel).toBe(true);
    expect(components[1].pointedMs).toBe(0);
  });

  it('falls back to the reference itself when nothing in the scene names it', () => {
    const { components } = cardAudioLinks({
      card: card({ details: { priority: 'High', status: 'Open', componentReference: 'the bracket thing' } }),
      messages: [],
      segments: [],
    });

    expect(components[0].partId).toBe('the bracket thing');
    expect(components[0].partName).toBe('the bracket thing');
  });

  it('ignores a componentReference that is only whitespace', () => {
    const { components } = cardAudioLinks({
      card: card({ details: { priority: 'High', status: 'Open', componentReference: '   ' } }),
      messages: [],
      segments: [],
    });

    expect(components).toEqual([]);
  });
});

describe('a part that is no longer in the scene', () => {
  it('keeps the name and marks it missing', () => {
    const { components } = cardAudioLinks({
      card: card({ details: { priority: 'High', status: 'Open', componentReference: 'node-gone' } }),
      messages: [],
      segments: [],
      partNames: { 'node-gone': 'Old Hinge Pin' },
      knownParts: { 'node-14': {} },
    });

    expect(components[0]).toMatchObject({ partName: 'Old Hinge Pin', missing: true });
  });

  it('does not mark a part the room still holds', () => {
    const { components } = cardAudioLinks({
      card: card({ sourceMessageIds: [LINE_AT_10S.id] }),
      messages: [LINE_AT_10S],
      segments: [segment(SPAN_START, SPAN_START + 1_000)],
      knownParts: { 'node-14': {} },
    });

    expect(components[0].missing).toBe(false);
  });

  it('marks a part from a replaced revision missing even though its name is remembered', () => {
    const { components } = cardAudioLinks({
      card: card({ sourceMessageIds: [LINE_AT_10S.id] }),
      messages: [LINE_AT_10S],
      segments: [segment(SPAN_START, SPAN_START + 4_000, { partId: 'rev-a_node-7', partName: 'Hinge Pin' })],
      partNames: { 'node-14': 'Left Ear Cup' },
      knownParts: { 'node-14': {} },
    });

    expect(components.map((c) => [c.partName, c.missing])).toEqual([['Hinge Pin', true]]);
  });

  it('claims nothing when the caller has no scene to ask', () => {
    // A reader with no room (a test of the modal's requirements block) cannot tell a part
    // that is missing from a part it simply cannot see, and guessing "missing" would strike
    // out every chip on the card.
    const { components } = cardAudioLinks({
      card: card({ details: { priority: 'High', status: 'Open', componentReference: 'node-gone' } }),
      messages: [],
      segments: [],
    });

    expect(components[0].missing).toBe(false);
  });
});

describe('a card with nothing to show', () => {
  it('answers nothing for a card with no source lines and no component', () => {
    const links = cardAudioLinks({ card: card(), messages: [LINE_AT_10S], segments: [segment(0, 99_000)] });

    expect(links).toEqual({ spans: [], components: [] });
    expect(hasCardAudioLinks(links)).toBe(false);
    expect(cardHasLinks(card())).toBe(false);
  });

  it('answers no span for a source line the room no longer holds', () => {
    // A card carried over from another meeting: its transcript is not in this chatHistory.
    const { spans } = cardAudioLinks({
      card: card({ sourceMessageIds: ['live-1-2'] }),
      messages: [LINE_AT_10S],
      segments: [segment(0, 600_000)],
    });

    expect(spans).toEqual([]);
  });

  it('answers no span for a line with no timestamp', () => {
    const systemLine = line(undefined, { id: 'system-gap-1', speakerId: undefined, speakerName: undefined });
    const { spans, components } = cardAudioLinks({
      card: card({ sourceMessageIds: [systemLine.id] }),
      messages: [systemLine],
      segments: [segment(0, 600_000)],
    });

    // And with no span there is nothing to overlap, so no pointing either: a span invented
    // for a line with no offset would play the first eight seconds of the recording and
    // claim the whole meeting was about whatever the laser crossed then.
    expect(spans).toEqual([]);
    expect(components).toEqual([]);
  });

  it('answers no pointing for a card whose lines nobody pointed during', () => {
    const links = cardAudioLinks({
      card: card({ sourceMessageIds: [LINE_AT_10S.id] }),
      messages: [LINE_AT_10S],
      segments: [segment(600_000, 610_000)],
    });

    expect(links.spans).toHaveLength(1);
    expect(links.components).toEqual([]);
    // The span is still worth showing: it is the audio the card came from, whether or not
    // anybody had a laser on anything while it was said.
    expect(hasCardAudioLinks(links)).toBe(true);
  });

  it('says a card with a component on it has something to show, before the scene is read', () => {
    expect(cardHasLinks(card({ details: { priority: 'High', status: 'Open', componentReference: 'node-14' } }))).toBe(true);
    expect(cardHasLinks(card({ sourceMessageIds: ['live-1-2'] }))).toBe(true);
    expect(cardHasLinks(card({ sourceMessageIds: [] }))).toBe(false);
  });
});

describe('a hand-made card', () => {
  // `source: 'manual'` is not read here and does not need to be: a card somebody typed has
  // a componentReference (ManualCardForm attaches the part on screen) and no source lines,
  // and that combination is the whole of what makes its row different.
  const manual = card({
    id: 'insight-manual-1',
    agentId: '',
    source: 'manual',
    createdByName: 'Maria Okafor',
    details: { priority: 'Medium', status: 'Open', componentReference: 'node-22' },
  });

  it('shows the component chip and no spans', () => {
    const links = cardAudioLinks({
      card: manual,
      messages: [LINE_AT_10S],
      segments: [segment(SPAN_START, SPAN_END)],
      partNames: { 'node-22': 'Headband' },
      knownParts: { 'node-22': {} },
    });

    expect(links.spans).toEqual([]);
    expect(links.components).toEqual([
      {
        partId: 'node-22',
        partName: 'Headband',
        pointedMs: 0,
        pointedBy: [],
        namedByModel: true,
        missing: false,
      },
    ]);
  });

  it('says the part is missing once the model it was typed against has been replaced', () => {
    const { components } = cardAudioLinks({
      card: manual,
      messages: [],
      segments: [],
      partNames: { 'node-22': 'Headband' },
      knownParts: { 'node-14': {} },
    });

    expect(components[0]).toMatchObject({ partName: 'Headband', missing: true });
  });

  it('still picks up pointing at the part it names, if a line ever turns up', () => {
    const withLine = card({ ...manual, sourceMessageIds: [LINE_AT_10S.id] });
    const { components } = cardAudioLinks({
      card: withLine,
      messages: [LINE_AT_10S],
      segments: [segment(SPAN_START, SPAN_START + 5_000, { partId: 'node-22', partName: 'Headband' })],
      knownParts: { 'node-22': {} },
    });

    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({ partName: 'Headband', pointedMs: 5_000, namedByModel: true });
  });
});

describe('which recording a span belongs to', () => {
  it('recognises the line by the start its id carries', () => {
    expect(lineIsFromRecording(`live-${RECORDING_START}-3`, RECORDING_START)).toBe(true);
  });

  it('refuses a line from an earlier recording in the same room', () => {
    // The browser only ever holds the LATEST recording, so a ▶ on this card's span would
    // play the wrong minute of a different one.
    expect(lineIsFromRecording(`live-${RECORDING_START - 1}-3`, RECORDING_START)).toBe(false);
  });

  it('refuses everything when the start was never known', () => {
    expect(lineIsFromRecording(`live-${RECORDING_START}-3`, 0)).toBe(false);
  });
});

describe('the clock on a chip and on a span', () => {
  it('reads mm:ss with the minutes padded, so a row of timestamps lines up', () => {
    expect(formatMs(0)).toBe('00:00');
    expect(formatMs(12_000)).toBe('00:12');
    expect(formatMs(96_000)).toBe('01:36');
    expect(formatMs(104_000)).toBe('01:44');
  });

  it('floors, and never goes negative', () => {
    expect(formatMs(1_999)).toBe('00:01');
    expect(formatMs(-500)).toBe('00:00');
    expect(formatMs(Number.NaN)).toBe('00:00');
  });
});
