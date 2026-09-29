// The session map's panel offers a meeting's transcript — and only when it has one.
//
// docs/plan/15-sessions-and-variants.md batch BU. What is pinned here is the read
// side of "Save transcript with this meeting": that the panel says how much of the
// meeting was kept and offers the same .txt the stop panel did, that a meeting which
// kept nothing shows NO transcript row rather than an empty one, and that the map
// still reads the database nothing at all — the reader is handed to it, and a map
// without one is a map that does not offer a download.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SessionMap from '../SessionMap';
import type { ReviewLine } from '../../../lib/reviews/lines';
import type { LineSession } from '../../../lib/reviews/linesRepo';
import type { TranscriptRow } from '../../../lib/capture/transcriptText';

const downloadTranscript = vi.fn((_text: string, _filename: string) => true);

// Only the download is faked. The text is built by the real
// lib/capture/transcriptText, so what this file asserts about the file is the file —
// including that the pointing rows the meeting stored are in it.
vi.mock('../../../lib/capture/transcriptText', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/capture/transcriptText')>();
  return {
    ...actual,
    downloadTranscript: (text: string, filename: string) => downloadTranscript(text, filename),
  };
});

const REVIEW = 'review-1';

const MAIN: ReviewLine = {
  id: 'line-main', reviewId: REVIEW, kind: 'main', name: 'Main line', letter: null,
  parentSessionId: null, parentLineId: null, mergedIntoLineId: null, dropReason: null, status: 'active', createdBy: null, createdByName: '',
  createdAt: '2026-03-01T09:00:00.000Z', closedAt: null,
};

function session(id: string, seq: number, overrides: Partial<LineSession> = {}): LineSession {
  return {
    id,
    title: `Design Review — ${id}`,
    // Midday UTC, so the day the file is headed with is the same day in every time
    // zone this suite can run in: the transcript's date comes from endedAt through
    // toLocaleDateString, and a meeting that ended at 23:00Z is two different days
    // in two different zones.
    endedAt: `2026-09-${20 + seq}T12:00:00.000Z`,
    participantCount: 2,
    attendeeNames: ['Olga Owner', 'Ben Guest'],
    modelName: 'imported',
    lineId: MAIN.id,
    seq,
    revisionIds: [],
    summary: null,
    ...overrides,
  };
}

const SESSIONS = [session('sess-1', 1), session('sess-2', 2)];

const TRANSCRIPT: TranscriptRow[] = [
  { t: 4000, speaker: 'Olga Owner', text: "Let's look at the hinge pin." },
  { t: 7000, speaker: 'Olga Owner', pointing: 'Hinge pin', untilMs: 12000 },
  { t: 15000, speaker: 'Ben Guest', text: 'It wears after a thousand cycles.' },
];

const readTranscript = vi.fn(async (_id: string) => TRANSCRIPT);

function renderMap(props: Partial<React.ComponentProps<typeof SessionMap>> = {}) {
  return render(
    <MemoryRouter>
      <SessionMap
        reviewTitle="Door hinge, rev C"
        lines={[MAIN]}
        sessions={SESSIONS}
        readTranscript={readTranscript}
        {...props}
      />
    </MemoryRouter>,
  );
}

/** Open the panel on the second stop, which is the meeting with the transcript. */
function openSecondStop() {
  fireEvent.click(screen.getAllByTestId('session-stop')[1]);
}

describe('the session panel’s transcript', () => {
  beforeEach(() => {
    readTranscript.mockClear().mockImplementation(async () => TRANSCRIPT);
    downloadTranscript.mockClear();
  });

  afterEach(cleanup);

  it('is not read until somebody opens a meeting', () => {
    renderMap();
    expect(readTranscript).not.toHaveBeenCalled();
  });

  it('says how many lines the meeting kept, counting what people said', async () => {
    renderMap();
    openSecondStop();

    // Two things were said; the pointing span between them is part of the record but
    // is not a line of it.
    expect(await screen.findByTestId('session-transcript')).toBeInTheDocument();
    expect(screen.getByText(/Transcript · 2 lines/)).toBeInTheDocument();
    expect(readTranscript).toHaveBeenCalledWith('sess-2');
  });

  it('offers the same .txt the stop panel did, with the pointing the meeting stored', async () => {
    renderMap();
    openSecondStop();
    fireEvent.click(await screen.findByRole('button', { name: /download \.txt/i }));

    expect(downloadTranscript).toHaveBeenCalledTimes(1);
    const [text, filename] = downloadTranscript.mock.calls[0];
    expect(text).toContain('Door hinge, rev C — 22 Sep 2026');
    expect(text).toContain('Attendees: Olga Owner, Ben Guest');
    expect(text).toContain("[00:00:04] Olga Owner: Let's look at the hinge pin.");
    expect(text).toContain('[00:00:07]   (Olga Owner pointing at: Hinge pin, 00:00:07–00:00:12)');
    expect(filename).toBe('Door hinge, rev C — 22 Sep 2026 transcript.txt');
  });

  it('shows no transcript row for a meeting that kept none', async () => {
    // Every meeting recorded before this batch, every meeting nobody asked to keep,
    // and every meeting held in privacy mode. Absent, not empty: an empty row with a
    // download on it offers a file of nothing.
    readTranscript.mockImplementation(async () => null);
    renderMap();
    openSecondStop();

    expect(await screen.findByText(/No summary was stored for this session/i)).toBeInTheDocument();
    expect(screen.queryByTestId('session-transcript')).toBeNull();
    expect(screen.queryByRole('button', { name: /download \.txt/i })).toBeNull();
  });

  it('shows no transcript row where there is no reader to ask', async () => {
    renderMap({ readTranscript: undefined });
    openSecondStop();

    expect(await screen.findByText(/No summary was stored for this session/i)).toBeInTheDocument();
    expect(screen.queryByTestId('session-transcript')).toBeNull();
    expect(readTranscript).not.toHaveBeenCalled();
  });

  it('drops the transcript of the meeting that was open when another one is opened', async () => {
    renderMap();
    openSecondStop();
    expect(await screen.findByText(/Transcript · 2 lines/)).toBeInTheDocument();

    readTranscript.mockImplementation(async () => null);
    fireEvent.click(screen.getAllByTestId('session-stop')[0]);

    // The first stop's panel must not go on offering the second stop's file: a
    // transcript under the wrong meeting's heading is a record nobody can trust.
    expect(screen.queryByTestId('session-transcript')).toBeNull();
  });
});
