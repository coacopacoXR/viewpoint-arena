// The transcript as a .txt, and the rows it is built from.
//
// docs/plan/15-sessions-and-variants.md batch BU. Two downloads offer the same
// file — the stop panel's, from the room's own memory, and the session map's, from
// tracker_sessions.transcript — so what is pinned here is that they are ONE format:
// the heading, the clock, the pointing lines and their merging, the filename, the
// cap, and the parser that reads the stored jsonb back.
//
// The example in the plan is asserted verbatim, because the person who asked for
// this wrote out what the file should look like and a format that drifts from it is
// a format somebody has to relearn.

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ChatMessage } from '../../../types';
import type { PointingSegment } from '../../pointingTimelineStore';
import {
  MAX_TRANSCRIPT_BYTES,
  MAX_TRANSCRIPT_ENTRIES,
  buildTranscript,
  mergedPointing,
} from '../transcript';
import {
  downloadTranscript,
  parseTranscriptRows,
  transcriptClock,
  transcriptFilename,
  transcriptLineCount,
  transcriptToText,
} from '../transcriptText';

const START = 1_700_000_000_000;

/** A live-transcript line, in the shape lib/useLiveTranscript broadcasts. */
function line(offsetMs: number, speakerName: string, text: string, seq: number): ChatMessage {
  return {
    id: `live-${START}-${seq}`,
    agentId: 'live-transcript',
    text,
    timestamp: START + offsetMs,
    speakerName,
    speakerId: `u-${speakerName.toLowerCase().replace(/\s+/g, '-')}`,
    offsetMs,
  };
}

function pointing(
  fromMs: number,
  toMs: number,
  partName: string,
  overrides: Partial<PointingSegment> = {},
): PointingSegment {
  return {
    userId: 'u-olga',
    userName: 'Olga Owner',
    partId: `p-${partName.toLowerCase().replace(/\s+/g, '-')}`,
    partName,
    source: 'laser',
    fromMs,
    toMs,
    ...overrides,
  };
}

/** The meeting from the plan: two things said, one part pointed at in between. */
const HINGE_CHAT = [
  line(4000, 'Olga Owner', "Let's look at the hinge pin.", 0),
  line(15000, 'Ben Guest', 'It wears after a thousand cycles.', 1),
];
const HINGE_POINTING = [pointing(7000, 12000, 'Hinge pin')];

describe('transcriptToText — the .txt both downloads offer', () => {
  it('is the file the plan asked for, exactly', () => {
    const rows = buildTranscript({
      chatHistory: HINGE_CHAT,
      recordingStart: START,
      segments: HINGE_POINTING,
      includePointing: true,
    });

    expect(
      transcriptToText(rows, {
        includePointing: true,
        title: 'Door hinge, rev C',
        date: '25 Sep 2026',
        attendees: ['Olga Owner', 'Ben Guest'],
      }),
    ).toBe(
      'Door hinge, rev C — 25 Sep 2026\n' +
        'Attendees: Olga Owner, Ben Guest\n' +
        '\n' +
        "[00:00:04] Olga Owner: Let's look at the hinge pin.\n" +
        '[00:00:07]   (Olga Owner pointing at: Hinge pin, 00:00:07–00:00:12)\n' +
        '[00:00:15] Ben Guest: It wears after a thousand cycles.\n',
    );
  });

  it('leaves the pointing out when it was not asked for', () => {
    const rows = buildTranscript({
      chatHistory: HINGE_CHAT,
      recordingStart: START,
      segments: HINGE_POINTING,
      includePointing: false,
    });
    const text = transcriptToText(rows, { title: 'Door hinge, rev C', date: '25 Sep 2026' });

    expect(rows.some((row) => 'pointing' in row)).toBe(false);
    expect(text).not.toContain('pointing at');
    expect(text).toContain('[00:00:04] Olga Owner:');
  });

  it('skips pointing rows it was given but not asked to render', () => {
    // The stored array decides what is IN a transcript; this decides what is
    // printed. A caller that renders rows it did not ask for would show a reader
    // something the meeting never chose to keep.
    const rows = buildTranscript({
      chatHistory: HINGE_CHAT,
      recordingStart: START,
      segments: HINGE_POINTING,
      includePointing: true,
    });
    expect(transcriptToText(rows, { includePointing: false })).not.toContain('pointing at');
  });

  it('has no heading and no blank line when there is nothing to head it with', () => {
    const rows = buildTranscript({ chatHistory: HINGE_CHAT, recordingStart: START });
    expect(transcriptToText(rows)).toBe(
      "[00:00:04] Olga Owner: Let's look at the hinge pin.\n" +
        '[00:00:15] Ben Guest: It wears after a thousand cycles.\n',
    );
  });

  it('omits the attendees line for a meeting that recorded no names', () => {
    const rows = buildTranscript({ chatHistory: HINGE_CHAT, recordingStart: START });
    const text = transcriptToText(rows, { title: 'Door hinge', attendees: [] });
    expect(text).not.toContain('Attendees:');
    expect(text.startsWith('Door hinge\n\n[')).toBe(true);
  });

  it('uses \\n line endings and no \\r, for Notepad, diffs and email alike', () => {
    const rows = buildTranscript({ chatHistory: HINGE_CHAT, recordingStart: START });
    expect(transcriptToText(rows)).not.toContain('\r');
  });

  it('says when the transcript was cut short, rather than ending mid-meeting', () => {
    const rows = [
      { t: 1000, speaker: 'Olga Owner', text: 'First thing said.' },
      { truncated: true as const },
    ];
    expect(transcriptToText(rows)).toContain('it reached the stored limit');
  });
});

describe('transcriptClock', () => {
  it.each([
    [0, '00:00:00'],
    [4000, '00:00:04'],
    [12000, '00:00:12'],
    [65_000, '00:01:05'],
    [3_725_000, '01:02:05'],
    // A meeting that ran all day is a meeting that ran all day: hours are not capped
    // at 24 and not wrapped into days.
    [93_600_000, '26:00:00'],
  ])('prints %ims as %s', (ms, expected) => {
    expect(transcriptClock(ms)).toBe(expected);
  });

  it('floors a partial second and refuses to print a negative clock', () => {
    expect(transcriptClock(4999)).toBe('00:00:04');
    expect(transcriptClock(-500)).toBe('00:00:00');
  });
});

describe('buildTranscript', () => {
  it('selects this recording’s lines and no others', () => {
    const earlier = [line(1000, 'Maria Guest', 'Before the recording.', 0)];
    const chat = [...earlier.map((m) => ({ ...m, id: 'live-999-0' })), ...HINGE_CHAT];
    const rows = buildTranscript({ chatHistory: chat, recordingStart: START });

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => 'text' in row && row.text !== 'Before the recording.')).toBe(true);
  });

  it('answers nothing for a room that never recorded', () => {
    expect(buildTranscript({ chatHistory: HINGE_CHAT, recordingStart: 0 })).toEqual([]);
  });

  it('orders by when it happened, speech before a pointing span that starts on the same millisecond', () => {
    const rows = buildTranscript({
      chatHistory: [line(7000, 'Olga Owner', 'Look here.', 0)],
      recordingStart: START,
      segments: [pointing(7000, 9000, 'Hinge pin')],
      includePointing: true,
    });
    expect(rows.map((row) => ('text' in row ? 'said' : 'pointed'))).toEqual(['said', 'pointed']);
  });

  it('drops a line with nothing said on it', () => {
    const rows = buildTranscript({
      chatHistory: [line(1000, 'Olga Owner', '   ', 0), line(2000, 'Olga Owner', 'Something.', 1)],
      recordingStart: START,
    });
    expect(rows).toHaveLength(1);
  });
});

describe('mergedPointing — consecutive spans by one person on one part', () => {
  it('merges a hand that left the part and came back inside three samples', () => {
    // The timeline is sampled at 2 Hz, so 500ms apart is one continuous "look at
    // this", not two decisions to point at the same part.
    const merged = mergedPointing([
      pointing(7000, 9000, 'Hinge pin'),
      pointing(9500, 12000, 'Hinge pin'),
    ]);
    expect(merged).toEqual([{ t: 7000, speaker: 'Olga Owner', pointing: 'Hinge pin', untilMs: 12000 }]);
  });

  it('keeps two spans that are far apart, because the conversation moved on', () => {
    expect(
      mergedPointing([pointing(7000, 9000, 'Hinge pin'), pointing(40000, 44000, 'Hinge pin')]),
    ).toHaveLength(2);
  });

  it('keeps two people pointing at the same part apart', () => {
    const merged = mergedPointing([
      pointing(7000, 9000, 'Hinge pin'),
      pointing(9200, 11000, 'Hinge pin', { userName: 'Ben Guest', userId: 'u-ben' }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('keeps one person pointing at two parts apart', () => {
    const merged = mergedPointing([
      pointing(7000, 9000, 'Hinge pin'),
      pointing(9200, 11000, 'Knuckle'),
    ]);
    expect(merged.map((span) => span.pointing)).toEqual(['Hinge pin', 'Knuckle']);
  });

  it('keeps the name the room last called the part', () => {
    const merged = mergedPointing([
      pointing(7000, 9000, 'Hinge pin'),
      pointing(9200, 11000, 'Hinge pin (rev C)', { partId: 'p-hinge-pin' }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].pointing).toBe('Hinge pin (rev C)');
  });

  it('drops a span with no part on it and one with nobody on it', () => {
    expect(mergedPointing([pointing(1000, 2000, '  ')])).toEqual([]);
    expect(mergedPointing([pointing(1000, 2000, 'Hinge pin', { userName: '' })])).toEqual([]);
  });

  it('sorts spans that arrived out of order', () => {
    const merged = mergedPointing([
      pointing(40000, 44000, 'Knuckle'),
      pointing(7000, 9000, 'Hinge pin'),
    ]);
    expect(merged.map((span) => span.t)).toEqual([7000, 40000]);
  });
});

describe('the cap', () => {
  it('keeps the first 20 000 entries and marks the transcript truncated', () => {
    const chat: ChatMessage[] = [];
    for (let i = 0; i < MAX_TRANSCRIPT_ENTRIES + 500; i += 1) {
      chat.push(line(i * 100, 'Olga Owner', `Line ${i}.`, i));
    }
    const rows = buildTranscript({ chatHistory: chat, recordingStart: START });

    expect(rows).toHaveLength(MAX_TRANSCRIPT_ENTRIES);
    expect(rows[rows.length - 1]).toEqual({ truncated: true });
    expect(rows[0]).toMatchObject({ t: 0, text: 'Line 0.' });
    expect(rows[MAX_TRANSCRIPT_ENTRIES - 2]).toMatchObject({ text: `Line ${MAX_TRANSCRIPT_ENTRIES - 2}.` });
  });

  it('stays inside 2 MB of JSON when the lines themselves are enormous', () => {
    const chat: ChatMessage[] = [];
    // 60 lines of 100 kB is 6 MB of transcript: over the cap on bytes alone, with
    // nowhere near 20 000 entries in it.
    for (let i = 0; i < 60; i += 1) {
      chat.push(line(i * 1000, 'Olga Owner', 'x'.repeat(100_000), i));
    }
    const rows = buildTranscript({ chatHistory: chat, recordingStart: START });
    const json = JSON.stringify(rows);

    expect(json.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES);
    expect(rows.length).toBeLessThan(60);
    expect(rows[rows.length - 1]).toEqual({ truncated: true });
  });

  it('does not mark a transcript that fitted', () => {
    const rows = buildTranscript({ chatHistory: HINGE_CHAT, recordingStart: START });
    expect(rows.some((row) => 'truncated' in row)).toBe(false);
  });
});

describe('transcriptFilename', () => {
  it('is <review name> — <date> transcript.txt', () => {
    expect(transcriptFilename('Door hinge, rev C', '25 Sep 2026')).toBe(
      'Door hinge, rev C — 25 Sep 2026 transcript.txt',
    );
  });

  it('replaces every character a file system refuses', () => {
    const name = transcriptFilename('Hinge/pin: rev C?<weird>|"name"*', '25 Sep 2026');
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
    expect(name.endsWith('transcript.txt')).toBe(true);
    expect(name).toContain('25 Sep 2026');
  });

  it('drops a trailing dot or space on the name, which Windows would remove silently', () => {
    // Only at the END of the filename: a review called "Rev C." keeps its dot when
    // the date follows it, because there it is not trailing and Windows does not
    // eat it.
    expect(transcriptFilename('Rev C', '25 Sep 2026. ')).toBe('Rev C — 25 Sep 2026 transcript.txt');
    expect(transcriptFilename('Rev C.', null)).toBe('Rev C transcript.txt');
    expect(transcriptFilename('Door hinge, rev C.', '25 Sep 2026')).toBe(
      'Door hinge, rev C. — 25 Sep 2026 transcript.txt',
    );
  });

  it('shortens a name too long to be a filename', () => {
    const name = transcriptFilename('Bracket '.repeat(60), '25 Sep 2026');
    expect(name.length).toBeLessThanOrEqual(140);
    expect(name.endsWith(' transcript.txt')).toBe(true);
  });

  it('still answers a usable name with no review and no date', () => {
    expect(transcriptFilename(null, null)).toBe('Meeting transcript.txt');
    expect(transcriptFilename('  ', undefined)).toBe('Meeting transcript.txt');
  });
});

describe('transcriptLineCount', () => {
  it('counts what somebody said, not the pointing spans among it', () => {
    expect(
      transcriptLineCount([
        { t: 1, speaker: 'Olga Owner', text: 'One.' },
        { t: 2, speaker: 'Olga Owner', pointing: 'Hinge pin', untilMs: 3 },
        { t: 4, speaker: 'Ben Guest', text: 'Two.' },
        { truncated: true },
      ]),
    ).toBe(2);
  });
});

describe('parseTranscriptRows — reading the jsonb column back', () => {
  it('answers null for a meeting that stored nothing', () => {
    expect(parseTranscriptRows(null)).toBeNull();
    expect(parseTranscriptRows(undefined)).toBeNull();
    expect(parseTranscriptRows('not an array')).toBeNull();
  });

  it('reads back what was written', () => {
    const written = buildTranscript({
      chatHistory: HINGE_CHAT,
      recordingStart: START,
      segments: HINGE_POINTING,
      includePointing: true,
    });
    const read = parseTranscriptRows(JSON.parse(JSON.stringify(written)));
    expect(read).toEqual(written);
  });

  it('drops a row it does not recognise instead of failing the whole transcript', () => {
    const rows = parseTranscriptRows([
      { t: 1000, speaker: 'Olga Owner', text: 'Kept.' },
      { t: 'soon', speaker: 'Olga Owner', text: 'A bad offset.' },
      { speaker: 'Olga Owner', text: 'No offset at all.' },
      { t: 2000, text: 'Nobody said it.' },
      { t: 3000, speaker: 'Ben Guest', pointing: '' },
      42,
      null,
      { truncated: true },
    ]);
    expect(rows).toEqual([
      { t: 1000, speaker: 'Olga Owner', text: 'Kept.' },
      { truncated: true },
    ]);
  });

  it('treats a pointing row with no end as ending where it began', () => {
    expect(parseTranscriptRows([{ t: 5000, speaker: 'Olga Owner', pointing: 'Hinge pin' }])).toEqual([
      { t: 5000, speaker: 'Olga Owner', pointing: 'Hinge pin', untilMs: 5000 },
    ]);
  });
});

describe('downloadTranscript', () => {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:transcript');
  const revokeObjectURL = vi.fn();

  afterEach(() => {
    vi.unstubAllGlobals();
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    document.body.innerHTML = '';
  });

  it('offers the text as a file and then gives the URL back', async () => {
    // jsdom has neither, which is why both are stubbed: a download is the one part of
    // this batch that cannot be tested by calling a function and reading its answer.
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const click = vi.fn();
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const element = originalCreateElement(tag);
      if (tag === 'a') element.click = click;
      return element;
    });

    expect(downloadTranscript('the transcript\n', 'Door hinge — 25 Sep 2026 transcript.txt')).toBe(true);

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toContain('text/plain');
    expect(await blob.text()).toBe('the transcript\n');
    expect(click).toHaveBeenCalledTimes(1);
    // The anchor is temporary: it is clicked and removed, never left in the room's DOM.
    expect(document.querySelector('a[download]')).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:transcript');
    vi.restoreAllMocks();
  });

  it('answers false where there is nothing to download into', () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: undefined }));
    expect(downloadTranscript('text', 'name.txt')).toBe(false);
  });
});
