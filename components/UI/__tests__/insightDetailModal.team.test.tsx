import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

// Mock store.
vi.mock('../../../store', () => ({
  useStore: ((selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      requirements: [],
      updateInsight: vi.fn(),
    };
    if (typeof selector === 'function') return selector(state);
    return state;
  }) as unknown as typeof vi.fn,
}));

// Mock presence.
vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => ({
    remoteParticipantList: [{ userId: 'r1', name: 'Maria', color: '#f00' }],
    localUserId: 'local-1',
  }),
}));

// Mock activeReviewStore.
vi.mock('../../../lib/activeReviewStore', () => ({
  useActiveReviewStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = { config: { team: [{ id: 't1', name: 'TeamAlice' }] } };
    if (typeof selector === 'function') return selector(state);
    return state;
  },
}));

// Mock identity.
vi.mock('../../../lib/identity', () => ({
  getIdentity: () => ({ name: 'LocalUser', color: '#000' }),
}));

import InsightDetailModal from '../InsightDetailModal';
import type { InsightCard } from '../../../types';

function makeCard(overrides: Partial<InsightCard> = {}): InsightCard {
  return {
    id: 'card-1',
    type: 'ACTION',
    agentId: '1',
    title: 'Test Action',
    description: 'Something to do',
    timestamp: Date.now(),
    details: { priority: 'High', status: 'Open' },
    ...overrides,
  };
}

describe('InsightDetailModal — team (no hardcoded names)', () => {
  afterEach(() => {
    cleanup();
  });

  it('does not render any invented team member names', () => {
    render(<InsightDetailModal card={makeCard()} onClose={() => {}} />);
    expect(screen.queryByText('Alex Chen (Lead)')).toBeNull();
    expect(screen.queryByText('Sarah J. (Ergo)')).toBeNull();
    expect(screen.queryByText('Design Team A')).toBeNull();
    expect(screen.queryByText('Mfg. Engineering')).toBeNull();
    expect(screen.queryByText('Validation Lab')).toBeNull();
  });

  it('renders the assignee combo box input', () => {
    render(<InsightDetailModal card={makeCard()} onClose={() => {}} />);
    const inputs = screen.getAllByRole('combobox');
    expect(inputs.length).toBeGreaterThan(0);
  });

  it('offers the people currently in the room when the combo box is focused', () => {
    // There is no stored roster any more (user, 2026-09-23): the list is the
    // room plus whatever the user types.
    render(<InsightDetailModal card={makeCard()} onClose={() => {}} />);
    const inputs = screen.getAllByRole('combobox');
    const input = inputs[inputs.length - 1];
    fireEvent.focus(input);
    // The people in the room appear; a stored roster no longer exists.
    expect(screen.getByText('Maria')).toBeInTheDocument();
    expect(screen.getByText('LocalUser')).toBeInTheDocument();
    expect(screen.queryByText('TeamAlice')).not.toBeInTheDocument();
  });
});
