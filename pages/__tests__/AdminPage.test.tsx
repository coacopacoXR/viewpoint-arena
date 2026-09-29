// Tests for the admin page: gate states, the reviews section, and the models
// section. The Reviews section now fetches from /api/admin/reviews (the admin
// endpoint) instead of curationsRepo directly; the toggle-listed action still goes
// through curationsRepo (supabase mock) and the delete goes through
// /api/reviews/delete, because a design review is not one row to remove — its
// meetings, cards, lines and roster go with it, in one transaction, and the
// published anon key is no longer allowed to delete any of it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';

// Mock supabase for the curationsRepo calls that still go through it (setCurationListed).
const mockUpdate = vi.fn();
const mockUpdateEq = vi.fn();

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'review_curations') {
        return {
          update: mockUpdate,
        };
      }
      return {};
    },
    // lib/reviews/deleteClient asks for a session to attach; the admin console has
    // none to give, and a client with no token is exactly what an install with no
    // accounts sends.
    auth: { getSession: vi.fn(async () => ({ data: { session: null } })) },
  },
  supabaseConfigured: true,
}));

// Mock the label fields repo.
vi.mock('../../lib/labelFieldsRepo', () => ({
  fetchLabelFields: vi.fn().mockResolvedValue([]),
  insertLabelField: vi.fn(),
  updateLabelField: vi.fn(),
  deleteLabelField: vi.fn(),
}));

// Mock the audit repo.
vi.mock('../../lib/auditRepo', () => ({
  listAuditEvents: vi.fn().mockResolvedValue({ status: 'ok', events: [] }),
}));

import AdminPage from '../AdminPage';
import { resetAdminGateForTests } from '../../lib/access/useAdminGate';

function renderAdmin() {
  return render(
    <MemoryRouter initialEntries={['/admin']}>
      <AdminPage />
    </MemoryRouter>,
  );
}

const ADMIN_REVIEWS_RESPONSE = {
  reviews: [
    {
      id: 'rev-1',
      title: 'Test Review',
      listed: true,
      archived: false,
      owner_id: null,
      owner_name: null,
      owner_email: null,
      member_count: 2,
      revisions_count: 1,
      last_meeting_at: '2026-09-24T09:00:00Z',
      updated_at: '2026-09-24T10:00:00Z',
      created_at: '2026-09-01T00:00:00Z',
    },
  ],
};

const ADMIN_MODELS_RESPONSE = {
  models: [
    {
      hash: 'a'.repeat(64),
      file_name: 'bracket.glb',
      size: 1024,
      content_type: 'model/gltf-binary',
      uploaded_at: '2026-09-24T09:00:00Z',
      uploaded_by_name: 'Alice',
      referenced: true,
      revisions: [
        { id: 'rev-row-1', review_id: 'rev-1', review_title: 'Test Review', line: 'bracket', revision: 'Rev A' },
      ],
      curation_refs: [],
    },
  ],
  total_storage: 1024,
};

// What the endpoint answers when storage also holds a file no design review
// points at — one imported in a plain session, which nothing else records.
const LOOSE_HASH = 'c'.repeat(64);
const ADMIN_MODELS_WITH_LOOSE_FILE = {
  models: [
    ...ADMIN_MODELS_RESPONSE.models,
    {
      hash: LOOSE_HASH,
      file_name: 'loose-import.step',
      size: 4096,
      content_type: 'model/step',
      uploaded_at: '2026-09-24T11:00:00Z',
      uploaded_by_name: '',
      referenced: false,
      revisions: [],
      curation_refs: [],
    },
  ],
  total_storage: 5120,
};

/**
 * Route fetch calls based on URL. The admin gate, the reviews endpoint, and
 * the models endpoint all ride on the same global fetch in jsdom.
 */
function routeFetch(overrides: {
  reviewsResponse?: unknown;
  modelsResponse?: unknown;
  gateUnlocked?: boolean;
} = {}) {
  const gateUnlocked = overrides.gateUnlocked ?? true;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/api/admin-unlock')) {
      if (init?.method === 'DELETE') {
        return new Response(JSON.stringify({ unlocked: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ required: true, unlocked: gateUnlocked }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/api/admin/reviews')) {
      return new Response(JSON.stringify(overrides.reviewsResponse ?? ADMIN_REVIEWS_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/api/admin/models')) {
      return new Response(JSON.stringify(overrides.modelsResponse ?? ADMIN_MODELS_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/api/reviews/delete')) {
      return new Response(
        JSON.stringify({ ok: true, action: 'review', reviewId: 'rev-1', sessions: 2, items: 5 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

describe('AdminPage', () => {
  beforeEach(() => {
    resetAdminGateForTests();
    vi.clearAllMocks();
    // eq chains for curationsRepo (setCurationListed).
    mockUpdate.mockReturnValue({ eq: mockUpdateEq });
    mockUpdateEq.mockResolvedValue({ error: null });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders "not configured" when required: false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ required: false, unlocked: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    renderAdmin();

    await vi.waitFor(() => {
      expect(screen.getByText('Admin not available')).toBeTruthy();
    });
    expect(screen.getByText(/passphrase is not set/)).toBeTruthy();
  });

  it('renders the unlock form when required && !unlocked', async () => {
    vi.stubGlobal('fetch', routeFetch({ gateUnlocked: false }));

    renderAdmin();

    await vi.waitFor(() => {
      expect(screen.getByText('Admin access')).toBeTruthy();
    });
    expect(screen.getByPlaceholderText('Enter admin passphrase')).toBeTruthy();
  });

  it('renders the sidebar with all sections including Models', async () => {
    vi.stubGlobal('fetch', routeFetch());

    renderAdmin();

    await vi.waitFor(() => {
      expect(screen.getByText('Design reviews')).toBeTruthy();
    });
    expect(screen.getByText('Models')).toBeTruthy();
    expect(screen.getByText('Labels')).toBeTruthy();
    expect(screen.getByText('Access')).toBeTruthy();
  });

  it('renders the reviews section with data from the admin endpoint', async () => {
    vi.stubGlobal('fetch', routeFetch());

    renderAdmin();

    await vi.waitFor(() => {
      expect(screen.getByText('Test Review')).toBeTruthy();
    });
    // The enriched data from the admin endpoint.
    expect(screen.getByText(/2 members/)).toBeTruthy();
    expect(screen.getByText(/1 revision/)).toBeTruthy();
  });

  it('delete requires two clicks, and then asks the endpoint rather than the database', async () => {
    const fetchMock = routeFetch();
    vi.stubGlobal('fetch', fetchMock);

    renderAdmin();

    await vi.waitFor(() => {
      expect(screen.getByText('Test Review')).toBeTruthy();
    });

    const deleteBtn = screen.getByText('Delete');
    fireEvent.click(deleteBtn);

    await vi.waitFor(() => {
      expect(screen.getByText('Confirm delete')).toBeTruthy();
    });

    const sent = () =>
      fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/reviews/delete'));
    // The first click only asks. A delete that fires on the click that reveals the
    // confirmation is a delete that happens to anybody who misclicks.
    expect(sent()).toHaveLength(0);

    const confirmBtn = screen.getByText('Confirm delete');
    fireEvent.click(confirmBtn);

    await vi.waitFor(() => {
      expect(sent().length).toBeGreaterThan(0);
    });
    // The whole review goes, not one row: api/reviews/delete.ts removes its meetings,
    // cards, lines and roster with it, in one transaction. The admin console no longer
    // deletes a curation row and leaves a tracker full of cards nobody can open.
    const body = JSON.parse(String(sent()[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body['action']).toBe('review');
    expect(body['reviewId']).toBe('rev-1');
  });

  it('renders the models section when navigated to', async () => {
    vi.stubGlobal('fetch', routeFetch());

    renderAdmin();

    await vi.waitFor(() => {
      expect(screen.getByText('Test Review')).toBeTruthy();
    });

    // Click the Models section in the sidebar.
    fireEvent.click(screen.getByText('Models'));

    await vi.waitFor(() => {
      expect(screen.getByText('bracket.glb')).toBeTruthy();
    });
    expect(screen.getAllByText(/1\.0 KB/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Alice/)).toBeTruthy();
  });

  it('shows a file no design review uses, and lets an admin delete it', async () => {
    const fetchMock = routeFetch({ modelsResponse: ADMIN_MODELS_WITH_LOOSE_FILE });
    vi.stubGlobal('fetch', fetchMock);

    renderAdmin();

    await vi.waitFor(() => {
      expect(screen.getByText('Test Review')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('Models'));
    await vi.waitFor(() => {
      expect(screen.getByText('loose-import.step')).toBeTruthy();
    });

    // The file storage holds but no review points at says so — and it is the
    // only one that does, because the other is a review's current model.
    expect(screen.getAllByText('Not used by any design review')).toHaveLength(1);

    const looseDelete = screen.getByTitle('Delete file');
    expect((looseDelete as HTMLButtonElement).disabled).toBe(false);
    const referencedDelete = screen.getByTitle('Still referenced — delete revisions first');
    expect((referencedDelete as HTMLButtonElement).disabled).toBe(true);

    // Two clicks, like every other destructive action on this page.
    fireEvent.click(looseDelete);
    fireEvent.click(screen.getByText('Confirm'));

    await vi.waitFor(() => {
      const askedToDelete = fetchMock.mock.calls.some(
        ([url]) => String(url).includes('type=file') && String(url).includes(LOOSE_HASH),
      );
      expect(askedToDelete).toBe(true);
    });
  });

  it('mode none hides the owner column and transfer button', async () => {
    // In mode 'none', the admin endpoint returns reviews without owner fields.
    const noOwnerReviews = {
      reviews: [
        {
          id: 'rev-1',
          title: 'Test Review',
          listed: true,
          archived: false,
          owner_id: null,
          owner_name: null,
          owner_email: null,
          member_count: 0,
          revisions_count: 0,
          last_meeting_at: null,
          updated_at: '2026-09-24T10:00:00Z',
          created_at: '2026-09-01T00:00:00Z',
        },
      ],
    };
    vi.stubGlobal('fetch', routeFetch({ reviewsResponse: noOwnerReviews }));

    renderAdmin();

    await vi.waitFor(() => {
      expect(screen.getByText('Test Review')).toBeTruthy();
    });

    // No owner line, no Transfer button.
    expect(screen.queryByText(/Owner:/)).toBeNull();
    expect(screen.queryByText('Transfer')).toBeNull();
  });
});
