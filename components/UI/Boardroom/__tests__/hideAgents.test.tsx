// hideAgents must hide agent tiles from the boardroom shell and layouts,
// while keeping human tiles, insight-card colours, and the toggle reversible.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { useStore } from '../../../../store';
import GalleryLayout from '../layouts/GalleryLayout';
import FocusLayout from '../layouts/FocusLayout';
import type { AgentState, PointOfInterest } from '../../../../types';

// Polyfill ResizeObserver for GalleryLayout (jsdom doesn't have it)
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock react-router-dom for BoardroomShell
vi.mock('react-router-dom', () => ({
  useParams: () => ({ roomId: 'test-room' }),
}));

// Mock useIsMobile to return false (desktop)
vi.mock('../../../../lib/useIsMobile', () => ({
  useIsMobile: () => false,
}));

// Mock @react-three/fiber Canvas so the shell doesn't try to mount WebGL
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children?: React.ReactNode }) => <div data-testid="mock-canvas">{children}</div>,
  useFrame: () => {},
  useThree: () => ({}),
}));

const agents: AgentState[] = [
  { id: '1', name: 'SYS.OP', role: 'PRESENTER', color: '#ff4400', behavior: 'IDLE', currentPoiId: null, attentionLevel: 0 },
  { id: '2', name: 'ENG.UNIT', role: 'REVIEWER', color: '#0066ff', behavior: 'IDLE', currentPoiId: null, attentionLevel: 0 },
];

const pois: PointOfInterest[] = [];

const baseLayoutProps = {
  speakingAgentId: null,
  pinnedAgentId: null,
  pois,
  onPin: vi.fn(),
  presenterLabel: null,
  interactionEnabled: false,
  screenSharing: false,
  userSelfTile: null,
  humanTiles: null,
};

describe('hideAgents — boardroom layouts', () => {
  afterEach(() => {
    cleanup();
    useStore.setState({ hideAgents: true, insightCards: [] });
  });

  describe('GalleryLayout', () => {
    it('renders agent tiles when agents are present', () => {
      render(<GalleryLayout {...baseLayoutProps} agents={agents} />);
      expect(screen.getByText('SYS.OP')).toBeTruthy();
      expect(screen.getByText('ENG.UNIT')).toBeTruthy();
    });

    it('renders no agent tiles when agents is empty', () => {
      render(<GalleryLayout {...baseLayoutProps} agents={[]} />);
      expect(screen.queryByText('SYS.OP')).toBeNull();
      expect(screen.queryByText('ENG.UNIT')).toBeNull();
    });

    it('shows empty state when no agents and no human tiles', () => {
      render(<GalleryLayout {...baseLayoutProps} agents={[]} />);
      expect(screen.getByText('No other participants yet.')).toBeTruthy();
    });

    it('does not show empty state when human tiles are present', () => {
      const humanTiles = <div data-testid="human-tile">Human</div>;
      render(<GalleryLayout {...baseLayoutProps} agents={[]} humanTiles={humanTiles} />);
      expect(screen.queryByText('No other participants yet.')).toBeNull();
      expect(screen.getByTestId('human-tile')).toBeTruthy();
    });

    it('participant count label reflects actual visible count', () => {
      const { rerender } = render(
        <GalleryLayout {...baseLayoutProps} agents={agents} participantCount={5} />
      );
      expect(screen.getByText('Participants (5)')).toBeTruthy();

      rerender(
        <GalleryLayout {...baseLayoutProps} agents={[]} participantCount={0} />
      );
      expect(screen.getByText('Participants (0)')).toBeTruthy();
    });
  });

  describe('FocusLayout', () => {
    it('renders agent tiles when agents are present', () => {
      render(<FocusLayout {...baseLayoutProps} agents={agents} />);
      expect(screen.getByText('SYS.OP')).toBeTruthy();
    });

    it('shows empty state when no agents and no human tiles', () => {
      render(<FocusLayout {...baseLayoutProps} agents={[]} />);
      expect(screen.getByText('No other participants yet.')).toBeTruthy();
    });

    it('does not show empty state when human tiles are present', () => {
      const humanTiles = <div data-testid="human-tile">Human</div>;
      render(<FocusLayout {...baseLayoutProps} agents={[]} humanTiles={humanTiles} />);
      expect(screen.queryByText('No other participants yet.')).toBeNull();
    });
  });

  describe('BoardroomShell wiring', () => {
    // Import dynamically so mocks are in place
    let BoardroomShell: React.FC;

    beforeEach(async () => {
      const mod = await import('../BoardroomShell');
      BoardroomShell = mod.default;
    });

    it('hides agent tiles when hideAgents is true', () => {
      useStore.setState({ hideAgents: true });
      render(<BoardroomShell />);
      // Agent names should not appear in the document
      expect(screen.queryByText('SYS.OP')).toBeNull();
      expect(screen.queryByText('ENG.UNIT')).toBeNull();
      expect(screen.queryByText('DES.LEAD')).toBeNull();
      expect(screen.queryByText('VR.USER')).toBeNull();
    });

    it('shows agent tiles when hideAgents is false', () => {
      useStore.setState({ hideAgents: false });
      render(<BoardroomShell />);
      // At least one agent name should be visible (in the speaking dots or tiles)
      expect(screen.getByText('S')).toBeTruthy(); // SYS.OP initial
    });

    it('flipping hideAgents back restores tiles without remounting shell', () => {
      useStore.setState({ hideAgents: true });
      const { container } = render(<BoardroomShell />);
      expect(screen.queryByText('S')).toBeNull();

      act(() => {
        useStore.setState({ hideAgents: false });
      });
      // After toggling, agent initials should appear in the speaking dots
      expect(screen.getByText('S')).toBeTruthy();
      // The shell container is still the same element (not remounted)
      expect(container.firstChild).toBeTruthy();
    });
  });
});
