// Who attended a meeting, and the row that stores them.
//
// docs/plan/15-sessions-and-variants.md batch BM. `participant_count` says that six
// people met; `attendee_names` says who they were, and it is the second one the
// session map's panel shows. Both halves are pinned here: the list the room builds
// out of its presence (deduplicated, no blanks, the person who pressed End first)
// and the fact that lib/trackerBridge writes it beside the count rather than
// instead of it.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InsightCard } from '../../types';

const mockInsert = vi.fn();
const mockSingle = vi.fn();

vi.mock('../supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'tracker_sessions') return { insert: mockInsert };
      if (table === 'tracker_items') return { insert: vi.fn().mockResolvedValue({ error: null }) };
      return {};
    },
  },
}));

import { attendeeNames } from '../identity';
import { flushSessionToTracker } from '../trackerBridge';

const CARD: InsightCard = {
  id: 'ic-1',
  type: 'RISK',
  agentId: 'transcript',
  title: 'Hinge pin wears',
  description: 'The bush goes through in 400 hours.',
  timestamp: 0,
  details: { priority: 'High', status: 'Open' },
};

async function flush(overrides: Partial<Parameters<typeof flushSessionToTracker>[0]> = {}) {
  mockInsert.mockReturnValue({
    select: () => ({ single: mockSingle.mockResolvedValue({ data: { id: 'sess-1' }, error: null }) }),
  });
  await flushSessionToTracker({
    roomId: 'room-1',
    insightCards: [CARD],
    participantCount: 2,
    modelName: null,
    ...overrides,
  });
  return mockInsert.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('attendeeNames', () => {
  it('puts the person at this browser first, then the room', () => {
    const names = attendeeNames('Olga Owner', [{ name: 'Ben Editor' }, { name: 'Maria Guest' }]);
    expect(names).toEqual(['Olga Owner', 'Ben Editor', 'Maria Guest']);
  });

  it('records one person once', () => {
    // A tab reopened without a reload, or the same colleague in the presence list
    // twice, is one attendee and not two.
    const names = attendeeNames('Olga Owner', [{ name: 'Ben Editor' }, { name: 'Olga Owner' }]);
    expect(names).toEqual(['Olga Owner', 'Ben Editor']);
  });

  it('records no blank names', () => {
    // Presence can arrive before a name does, and an empty string in the middle of
    // the list reads as a missing attendee in the session panel.
    const names = attendeeNames('', [{ name: '' }, { name: '   ' }, { name: 'Ben Editor' }]);
    expect(names).toEqual(['Ben Editor']);
  });

  it('trims the names it keeps, and stores none of the guest suffix', () => {
    // participantLabel adds "(guest)" on screen; the row is a record of who was in
    // the meeting, not of how one of them signed in.
    const names = attendeeNames('  Olga Owner ', [{ name: ' Ben Editor ' }]);
    expect(names).toEqual(['Olga Owner', 'Ben Editor']);
  });

  it('answers nobody for a room with nobody in it', () => {
    expect(attendeeNames('', [])).toEqual([]);
  });
});

describe('flushSessionToTracker — the attendees', () => {
  it('writes the names beside the head count', async () => {
    const row = await flush({ participantCount: 3, attendeeNames: ['Olga Owner', 'Ben Editor', 'Maria Guest'] });

    expect(row.attendee_names).toEqual(['Olga Owner', 'Ben Editor', 'Maria Guest']);
    // The count stays: it is all a session recorded before this column existed has,
    // and the panel falls back to it.
    expect(row.participant_count).toBe(3);
  });

  it('writes an empty list when the caller knew no names', async () => {
    // An ad-hoc room with no presence. NULL would be indistinguishable from "the
    // column does not exist yet" once it is read back; [] says "nobody was named".
    const row = await flush();

    expect(row.attendee_names).toEqual([]);
    expect(row.participant_count).toBe(2);
  });

  it('does not write a summary at insert time', async () => {
    // The minutes are one AI job that can take seconds and can fail. The row is the
    // record and is written first; lib/capture/meetingMinutes updates it after.
    const row = await flush();

    expect(row).not.toHaveProperty('summary');
  });
});
