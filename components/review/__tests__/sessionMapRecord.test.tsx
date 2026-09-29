// The session map's panel: one meeting, opened — who attended it and its minutes.
//
// docs/plan/15-sessions-and-variants.md batch BM. The panel has always had both
// slots; what it could put in them was a head count and a lie by omission, because
// nothing ever stored a summary. Both slots are pinned here, and so are both
// fallbacks: a meeting recorded before this batch has a count and no names, and a
// meeting whose minutes were never written — no transcript, privacy mode, capture
// paused, a provider that refused — says so rather than showing a blank.
//
// The minutes are model output rendered as TEXT. That is the point of the last
// test: markdown is stored, and nothing here interprets it.

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SessionMap from '../SessionMap';
import type { ReviewLine } from '../../../lib/reviews/lines';
import type { LineSession } from '../../../lib/reviews/linesRepo';

afterEach(cleanup);

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
    endedAt: `2026-0${seq}-0${seq}T16:00:00.000Z`,
    participantCount: 4,
    modelName: 'Bracket',
    lineId: MAIN.id,
    seq,
    revisionIds: [],
    summary: null,
    ...overrides,
  };
}

/** Render a map of exactly these meetings and open the panel on the first stop. */
function openFirst(sessions: LineSession[]): void {
  render(
    <MemoryRouter>
      <SessionMap reviewTitle="Bracket assembly" lines={[MAIN]} sessions={sessions} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getAllByTestId('session-stop')[0]);
}

/** The panel's "Attended" cell: the <dt> and the <dd> beside it. */
function attended(): HTMLElement {
  return screen.getByText('Attended').parentElement as HTMLElement;
}

describe('the panel — who attended', () => {
  it('names the people who were in the meeting', () => {
    openFirst([
      session('open-me', 1, { attendeeNames: ['Olga Owner', 'Ben Editor'], participantCount: 2 }),
    ]);

    const cell = attended();
    expect(within(cell).getByText('Olga Owner, Ben Editor')).toBeTruthy();
    // The names replace the count in the same slot; the count is still on the row.
    expect(within(cell).queryByText('2 people')).toBeNull();
  });

  it('falls back to the head count for a meeting recorded before there were names', () => {
    openFirst([session('open-me', 1, { participantCount: 6 })]);

    const cell = attended();
    expect(within(cell).getByText('6 people')).toBeTruthy();
  });

  it('falls back to the count when the row has an empty list', () => {
    openFirst([session('open-me', 1, { attendeeNames: [], participantCount: 1 })]);

    const cell = attended();
    expect(within(cell).getByText('1 person')).toBeTruthy();
  });
});

describe('the panel — the minutes', () => {
  it('shows them line by line, headings and bullets without their markers', () => {
    openFirst([
      session('open-me', 1, { summary: '## Decisions\nRev B approved.\n\n## Actions\n- [ ] re-run the fatigue case — Ben' }),
    ]);

    expect(screen.getByText('Decisions')).toBeTruthy();
    expect(screen.getByText('Rev B approved.')).toBeTruthy();
    expect(screen.getByText('• [ ] re-run the fatigue case — Ben')).toBeTruthy();
    expect(screen.queryByText(/##/)).toBeNull();
    expect(screen.queryByText('No summary was stored for this session.')).toBeNull();
  });

  it('says when none was stored rather than leaving the slot out', () => {
    openFirst([session('open-me', 1)]);

    expect(screen.getByText('No summary was stored for this session.')).toBeTruthy();
    expect(screen.queryByText('Summary')).toBeNull();
  });

  it('scrolls a long meeting\'s minutes instead of stretching the panel', () => {
    openFirst([session('open-me', 1, { summary: 'A line.\n'.repeat(400) })]);

    const summary = screen.getAllByText('A line.')[0].parentElement as HTMLElement;
    expect(summary.className).toContain('max-h-40');
    expect(summary.className).toContain('overflow-y-auto');
  });

  it('renders the markdown as text, because it is model output', () => {
    // No dangerouslySetInnerHTML and no markdown library: a summary that arrived
    // carrying markup is a summary that is shown, not one that runs.
    openFirst([session('open-me', 1, { summary: '<img src=x onerror="window.__ran = true">' })]);

    expect(screen.getByText('<img src=x onerror="window.__ran = true">')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('the panel — a meeting that has both', () => {
  it('shows the names and the minutes together', () => {
    openFirst([
      session('open-me', 1, { attendeeNames: ['Olga Owner'], summary: 'Rev B approved.' }),
      session('sess-2', 2),
    ]);

    expect(within(attended()).getByText('Olga Owner')).toBeTruthy();
    expect(screen.getByText('Rev B approved.')).toBeTruthy();
  });
});

describe('summaryLines', () => {
  it('reads headings and bullets and leaves other text as written', async () => {
    const { summaryLines } = await import('../SessionMap');
    expect(summaryLines('Intro\n\n## Risks raised\n- Hinge pin wears (Medium)\n<b>x</b>')).toEqual([
      { kind: 'text', text: 'Intro' },
      { kind: 'text', text: '' },
      { kind: 'heading', text: 'Risks raised' },
      { kind: 'bullet', text: 'Hinge pin wears (Medium)' },
      { kind: 'text', text: '<b>x</b>' },
    ]);
  });
});
