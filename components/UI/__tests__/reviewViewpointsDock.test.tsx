// ReviewViewpointsDock tests, including where the expanded card opens.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ReviewViewpointsDock from '../ReviewViewpointsDock';

// Mock the activeReviewStore
vi.mock('../../../lib/activeReviewStore', () => ({
  useActiveReviewStore: vi.fn(),
}));

import { useActiveReviewStore } from '../../../lib/activeReviewStore';

const mockUseActiveReviewStore = vi.mocked(useActiveReviewStore);

type StoreState = { config: unknown; managerMode: boolean };

function setupStore(config: unknown = null, managerMode = false) {
  const state: StoreState = {
    config,
    managerMode,
  };
  mockUseActiveReviewStore.mockImplementation(((selector?: (s: StoreState) => unknown) => {
    if (typeof selector === 'function') return selector(state);
    return state;
  }) as unknown as typeof useActiveReviewStore);
}

describe('ReviewViewpointsDock positioning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('returns null when config is missing', () => {
    setupStore(null);
    const { container } = render(<ReviewViewpointsDock />);
    expect(container.firstChild).toBeNull();
  });

  it('returns null when no viewpoints, pins, or agenda', () => {
    setupStore({ title: 'Test', viewpoints: [], pins: [], agenda: [] });
    const { container } = render(<ReviewViewpointsDock />);
    expect(container.firstChild).toBeNull();
  });

  it('renders collapsed dock with title', () => {
    setupStore({
      title: 'Test Review',
      viewpoints: [{ id: 'v1', name: 'Viewpoint 1' }],
      pins: [],
      agenda: [{ id: 'a1', title: 'Item 1' }],
    });
    render(<ReviewViewpointsDock />);
    expect(screen.getByText('Test Review')).toBeInTheDocument();
  });

  it('opens the expanded card straight up from the pill, whatever the side panel does', () => {
    setupStore({
      title: 'Test Review',
      viewpoints: [{ id: 'v1', name: 'Viewpoint 1' }],
      pins: [],
      agenda: [],
    });
    render(<ReviewViewpointsDock />);

    fireEvent.click(screen.getAllByTitle('Expand')[0]);

    // The bottom row is inset to the free canvas, so no offset is needed to
    // clear the side panel — and the old right-[356px] shift put the card on
    // top of the model tree at laptop widths.
    const expandedCard = screen.getAllByText('Active Review')[0].closest('div[class*="absolute"]');
    expect(expandedCard).toBeTruthy();
    expect(expandedCard?.className).toContain('right-0');
    expect(expandedCard?.className).not.toContain('right-[356px]');
  });

  it('auto-closes when manager mode is enabled', () => {
    setupStore({
      title: 'Test Review',
      viewpoints: [{ id: 'v1', name: 'Viewpoint 1' }],
      pins: [],
      agenda: [],
    });
    const { rerender } = render(<ReviewViewpointsDock />);
    
    // Expand the dock
    const expandButtons = screen.getAllByTitle('Expand');
    fireEvent.click(expandButtons[0]);
    expect(screen.getAllByText('Active Review').length).toBeGreaterThan(0);
    
    // Enable manager mode
    setupStore(
      {
        title: 'Test Review',
        viewpoints: [{ id: 'v1', name: 'Viewpoint 1' }],
        pins: [],
        agenda: [],
      },
      true
    );
    rerender(<ReviewViewpointsDock />);
    
    // The expanded card should be gone (only the collapsed dock remains)
    expect(screen.queryAllByText('Active Review').length).toBe(0);
  });
});
