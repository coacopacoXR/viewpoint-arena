import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { InsightCard, Requirement } from '../../../types';

let mockRequirements: Requirement[] = [];

vi.mock('../../../store', () => ({
  useStore: ((selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      requirements: mockRequirements,
      updateInsight: vi.fn(),
    };
    if (typeof selector === 'function') return selector(state);
    return state;
  }) as unknown as typeof vi.fn,
}));

// AssigneeComboBox (imported by InsightDetailModal) depends on these.
vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => ({ remoteParticipantList: [], localUserId: '' }),
}));
vi.mock('../../../lib/activeReviewStore', () => ({
  useActiveReviewStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = { config: { team: [] }, addTeamMember: vi.fn() };
    if (typeof selector === 'function') return selector(state);
    return state;
  },
}));
vi.mock('../../../lib/identity', () => ({
  getIdentity: () => null,
}));

import InsightDetailModal from '../InsightDetailModal';

function makeCard(overrides: Partial<InsightCard> = {}): InsightCard {
  return {
    id: 'card-1',
    type: 'RISK',
    agentId: '1',
    title: 'Test Risk',
    description: 'Something risky',
    timestamp: Date.now(),
    details: { priority: 'High', status: 'Open' },
    ...overrides,
  };
}

describe('InsightDetailModal — requirements', () => {
  beforeEach(() => {
    mockRequirements = [];
  });

  afterEach(() => {
    cleanup();
  });

  it('does not render Requirements Impact when requirements list is empty', () => {
    mockRequirements = [];
    const card = makeCard({ affectedRequirementIds: ['r1', 'r2'] });
    render(<InsightDetailModal card={card} onClose={() => {}} />);
    expect(screen.queryByText('Requirements Impact')).toBeNull();
  });

  it('renders Requirements Impact when requirements resolve', () => {
    mockRequirements = [
      { id: 'r1', code: 'REQ-001', description: 'Knob force', category: 'MECHANICAL', status: 'MET' },
    ];
    const card = makeCard({ affectedRequirementIds: ['r1'] });
    render(<InsightDetailModal card={card} onClose={() => {}} />);
    expect(screen.getByText('Requirements Impact')).toBeInTheDocument();
    expect(screen.getByText(/REQ-001/)).toBeInTheDocument();
  });

  it('renders without affectedRequirementIds gracefully', () => {
    mockRequirements = [];
    const card = makeCard();
    render(<InsightDetailModal card={card} onClose={() => {}} />);
    expect(screen.queryByText('Requirements Impact')).toBeNull();
  });
});
