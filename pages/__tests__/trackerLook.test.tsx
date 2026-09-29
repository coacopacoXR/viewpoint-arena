// The tracker in the app's own look.
//
// docs/plan/15-sessions-and-variants.md batch BW, from the user's note that they
// "would like the aesthetics of the tracker to match the aesthetics of the other
// parts of the app". Two things are pinned here, and both are about the page rather
// than about any one control:
//
// 1. IT WEARS THE SHARED TOP BAR — the lobby's, with the brand that goes home, the
//    Lobby pill, the name chip, and the tracker's own four controls in the bar's
//    actions slot. A screen that draws its own header is a screen that drifts.
// 2. IT SCROLLS ITSELF. index.html fixes the body and hides its overflow for the 3D
//    room, so a page taller than the window is unreachable unless it scrolls itself —
//    the bug the lobby had. The light ground and the white panels are asserted too,
//    because "no dark treatment left" is the whole of the change and a class a later
//    batch puts back is a regression worth failing on.
//
// What is NOT here: every filter, the board, the drawer and the exports, which the
// two behavioural tracker test files already pin and which this batch did not touch.
//
// The fakes are the ones pages/__tests__/trackerDesignReview.test.tsx uses: the page
// under test is the real one, including the shared bar and the board's dnd-kit columns.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { answers, curationsMock, revisionsMock } = vi.hoisted(() => {
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  return {
    answers: tables,
    curationsMock: { list: vi.fn() },
    revisionsMock: { list: vi.fn() },
  };
});

vi.mock('../../lib/supabase', () => {
  interface Answer { data: Array<Record<string, unknown>> | null; error: null }
  interface Chain extends Promise<Answer> {
    select: (columns?: string) => Chain;
    eq: (column: string, value: unknown) => Chain;
    in: (column: string, values: readonly unknown[]) => Chain;
    order: (column: string, ascending?: { ascending?: boolean }) => Chain;
    limit: (count: number) => Chain;
    single: () => Chain;
    maybeSingle: () => Chain;
    insert: (rows: unknown) => Chain;
    update: (rows: unknown) => Chain;
    delete: () => Chain;
  }
  function chain(table: string): Chain {
    const methods = {
      select: () => chain(table),
      eq: () => chain(table),
      in: () => chain(table),
      order: () => chain(table),
      limit: () => chain(table),
      single: () => chain(table),
      maybeSingle: () => chain(table),
      insert: () => chain(table),
      update: () => chain(table),
      delete: () => chain(table),
    };
    return Object.assign(Promise.resolve({ data: answers[table] ?? [], error: null }), methods);
  }
  return {
    supabase: { from: (table: string) => chain(table) },
    supabaseConfigured: true,
  };
});

vi.mock('../../lib/curationsRepo', () => ({
  listAllCurations: () => curationsMock.list(),
}));

vi.mock('../../lib/reviews/revisionsRepo', () => ({
  listModelRevisions: (reviewId: string) => revisionsMock.list(reviewId),
}));

vi.mock('../../components/UI/IntegrationsPanel', () => ({ default: () => null }));

const TrackerPage = (await import('../TrackerPage')).default;

const MEETING = {
  id: 'meet-1', room_id: 'review-1', title: 'Design review — 3 May 2026',
  ended_at: '2026-05-03T16:00:00.000Z', created_at: '2026-05-03T15:00:00.000Z',
  participant_count: 4, model_name: 'qwen', labels: {}, review_id: 'review-1',
};

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'item-1', session_id: MEETING.id, type: 'RISK', title: 'A card', description: '',
    priority: 'High', status: 'Open', assignee: null, due_date: null,
    component_reference: null, department: null, agent_id: 'SYS.OP', source_message_ids: null,
    affected_requirement_ids: null, impact: null, mitigation_strategy: null,
    design_driver: null, tradeoff_analysis: null,
    created_at: '2026-05-03T16:00:00.000Z', updated_at: '2026-05-03T16:00:00.000Z',
    review_id: 'review-1', raised_on_revision: null, created_by_name: null, source: 'ai',
    session: MEETING, ...overrides,
  };
}

let page: HTMLElement;

async function renderTracker() {
  const view = render(
    <MemoryRouter>
      <TrackerPage />
    </MemoryRouter>,
  );
  await waitFor(() => {
    expect(screen.queryByText('Loading tracker…')).toBeNull();
  });
  await act(async () => {});
  await act(async () => {});
  page = screen.getByTestId('tracker-scroll');
  return view;
}

beforeEach(() => {
  localStorage.clear();
  answers['tracker_sessions'] = [MEETING];
  answers['tracker_items'] = [item({ id: 'item-1', title: 'Weld crack at the fillet' })];
  answers['tracker_status_history'] = [];
  answers['review_label_fields'] = [];
  curationsMock.list.mockReset().mockResolvedValue([
    {
      id: 'review-1', title: 'Landing gear bracket', description: '', viewpoint_count: 0,
      pin_count: 0, slide_count: 0, listed: true,
      updated_at: '2026-05-03T16:00:00.000Z', created_at: '2026-02-01T09:00:00.000Z',
    },
  ]);
  revisionsMock.list.mockReset().mockResolvedValue([]);
});

afterEach(cleanup);

describe('the tracker — the bar it shares with the lobby', () => {
  it('wears the lobby’s top bar, and offers the lobby rather than itself', async () => {
    await renderTracker();

    // The brand, which is the way home, and the pill that says so in words.
    expect(screen.getByLabelText('Viewpoint Arena lobby')).toHaveAttribute('href', '/');
    expect(screen.getByTestId('topbar-lobby-link')).toHaveAttribute('href', '/');
    // A bar standing on the tracker that offered "Tracker" would offer a link to where
    // the reader already is.
    expect(screen.queryByTestId('lobby-tracker-link')).toBeNull();
    // And the name chip, which is why this page has no identity form of its own.
    expect(screen.getByTestId('identity-chip')).toBeInTheDocument();
  });

  it('keeps its own four controls in the bar, and its counts', async () => {
    await renderTracker();

    const actions = screen.getByTestId('topbar-actions');
    expect(actions).toHaveTextContent('+ Demo Data');
    expect(actions).toHaveTextContent('Label fields');
    expect(actions).toHaveTextContent('Integrations');
    expect(actions).toHaveTextContent('Export CSV');
    expect(screen.getByTestId('tracker-counts')).toHaveTextContent('1 sessions · 1 items');
  });

  it('has no header of its own left, and no dark treatment anywhere', async () => {
    await renderTracker();

    // The black bar's own word for the page is gone: the brand is the app's now.
    expect(page.textContent).not.toContain('Viewpoint Tracker');
    expect(page.textContent).not.toContain('← Arena');
    expect(page.innerHTML).not.toContain('#111111');
    expect(page.innerHTML).not.toContain('bg-black text-white flex items-center justify-between');
  });
});

describe('the tracker — its own scroll container', () => {
  it('scrolls itself on the light ground, the way the lobby does', async () => {
    await renderTracker();

    // index.html fixes the body and hides its overflow for the 3D room, so this is
    // what makes a page taller than the window reachable at all.
    expect(page.className).toContain('h-full');
    expect(page.className).toContain('overflow-y-auto');
    expect(page.className).toContain('bg-[#f3f4f6]');
  });

  it('puts the meetings on a white panel rather than on a dark rail', async () => {
    await renderTracker();

    const rail = document.querySelector('aside');
    expect(rail?.className).toContain('bg-white');
    expect(rail?.className).toContain('border-gray-200');
    expect(rail?.innerHTML).not.toContain('bg-white/10');
  });

  it('draws the four views as the lobby’s chips: black for the one that is on', async () => {
    await renderTracker();

    const chips = screen.getAllByRole('button', { name: /^(board|list|matrix|trends)$/i });
    expect(chips).toHaveLength(4);
    const on = chips.find((chip) => chip.getAttribute('aria-pressed') === 'true');
    const off = chips.find((chip) => chip.getAttribute('aria-pressed') === 'false');
    expect(on?.textContent?.toLowerCase()).toBe('board');
    expect(on?.className).toContain('bg-black');
    expect(off?.className).toContain('bg-white');
    expect(off?.className).toContain('border-gray-200');
  });
});
