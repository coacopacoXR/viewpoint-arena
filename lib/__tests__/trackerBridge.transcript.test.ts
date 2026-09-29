// lib/trackerBridge.ts — the transcript on the meeting's own row.
//
// docs/plan/15-sessions-and-variants.md batch BU. Two claims, and they pull in
// opposite directions, which is why both are pinned:
//
//   the transcript is stored on tracker_sessions, so the session map can offer the
//   same .txt weeks later and to somebody who was not in the room;
//
//   a meeting that asked to keep one is recorded even when it raised no cards —
//   "Generate cards" and "Save transcript" are two of the three choices the stop
//   panel offers, and a person who took only the second one asked for a record.
//   A meeting that produced NEITHER still writes nothing at all, which is what keeps
//   an empty room from putting a dot on a review's history.
//
// Plus the one that protects every install this file has not been re-applied on: an
// empty transcript leaves the column out of the INSERT entirely, so a database
// without it records the meeting exactly as it did before instead of failing on an
// unknown column and losing the record.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InsightCard } from '../../types';
import type { TranscriptRow } from '../capture/transcriptText';

const { state } = vi.hoisted(() => ({
  state: {
    sessions: [] as Array<Record<string, unknown>>,
    items: [] as Array<Record<string, unknown>>,
    sessionId: 'sess-1',
    sessionError: null as { message: string } | null,
  },
}));

vi.mock('../supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'tracker_sessions') {
        return {
          insert: (row: Record<string, unknown>) => {
            state.sessions.push(row);
            return {
              select: () => ({
                single: async () => ({
                  data: state.sessionError ? null : { id: state.sessionId },
                  error: state.sessionError,
                }),
              }),
            };
          },
        };
      }
      if (table === 'tracker_items') {
        return {
          insert: async (rows: Array<Record<string, unknown>>) => {
            state.items.push(...rows);
            return { error: null };
          },
        };
      }
      return {};
    },
  },
}));

import { flushSessionToTracker } from '../trackerBridge';

const TRANSCRIPT: TranscriptRow[] = [
  { t: 4000, speaker: 'Olga Owner', text: "Let's look at the hinge pin." },
  { t: 7000, speaker: 'Olga Owner', pointing: 'Hinge pin', untilMs: 12000 },
  { t: 15000, speaker: 'Ben Guest', text: 'It wears after a thousand cycles.' },
];

const CARD: InsightCard = {
  id: 'ic-1',
  type: 'RISK',
  agentId: '',
  title: 'Hinge pin wears',
  description: 'After a thousand cycles',
  timestamp: 1_700_000_000_000,
  details: { priority: 'High', status: 'Open' },
};

/** An ad-hoc room: no review, so no line and no revision reads to stub out. */
const MEETING = {
  roomId: 'room-1',
  participantCount: 2,
  modelName: 'headphones',
  attendeeNames: ['Olga Owner', 'Ben Guest'],
};

beforeEach(() => {
  vi.clearAllMocks();
  state.sessions = [];
  state.items = [];
  state.sessionId = 'sess-1';
  state.sessionError = null;
});

describe('a meeting that kept its transcript', () => {
  it('stores it on the session’s own row, beside who attended', async () => {
    const sessionId = await flushSessionToTracker({
      ...MEETING,
      insightCards: [CARD],
      transcript: TRANSCRIPT,
    });

    expect(sessionId).toBe('sess-1');
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].transcript).toEqual(TRANSCRIPT);
    expect(state.sessions[0].attendee_names).toEqual(['Olga Owner', 'Ben Guest']);
  });

  it('is recorded even when it raised no cards at all', async () => {
    // "Generate cards" is a choice, not a consequence of stopping: a person who only
    // pressed "Save transcript with this meeting" asked for a record of the meeting,
    // and a gate on cards alone would have thrown it away.
    const sessionId = await flushSessionToTracker({
      ...MEETING,
      insightCards: [],
      transcript: TRANSCRIPT,
    });

    expect(sessionId).toBe('sess-1');
    expect(state.sessions).toHaveLength(1);
    expect(state.items).toHaveLength(0);
  });
});

describe('a meeting that did not', () => {
  it('leaves the column out of the insert, so a database without it still records the meeting', async () => {
    await flushSessionToTracker({ ...MEETING, insightCards: [CARD] });

    expect(state.sessions).toHaveLength(1);
    expect('transcript' in state.sessions[0]).toBe(false);
  });

  it('treats an empty transcript the same way, and not as a transcript of nothing', async () => {
    await flushSessionToTracker({ ...MEETING, insightCards: [CARD], transcript: [] });

    expect('transcript' in state.sessions[0]).toBe(false);
  });

  it('writes no session at all when there were neither cards nor a transcript', async () => {
    const sessionId = await flushSessionToTracker({ ...MEETING, insightCards: [] });

    expect(sessionId).toBeNull();
    expect(state.sessions).toHaveLength(0);
    expect(state.items).toHaveLength(0);
  });
});
