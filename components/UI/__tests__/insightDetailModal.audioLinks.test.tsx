// The detail modal's "Linked components" row (task 09b).
//
// The row is the same component the Capture deck draws (components/UI/CardAudioLinks), so
// what is pinned here is the three things that are the MODAL's decision and not the row's:
//
//   * it is drawn at all, for every one of the four hosts that open this modal, because the
//     data is read here rather than handed in — a card opened from the boardroom, the manager
//     workspace or the meeting summary gets the same row as one opened from the Capture panel;
//   * it sits OUTSIDE the <fieldset disabled> that makes the form read-only for a person who
//     may not edit, because selecting a part, following a timestamp and playing a clip are
//     looking and not editing. A guest gets the same row an editor does;
//   * both clicks close the modal first, since both do something on the screen behind it.
//
// components/UI/__tests__/cardAudioLinks.test.tsx pins the row itself, and
// components/UI/__tests__/conversationPanelAudioLinks.test.tsx pins it in the deck.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ChatMessage, InsightCard } from '../../../types';
import type { PointingSegment } from '../../../lib/pointingTimelineStore';

const RECORDING_START = 1_700_000_000_000;

const h = vi.hoisted(() => ({
  selectNode: vi.fn(),
  chatHistory: [] as ChatMessage[],
  objectStates: {} as Record<string, unknown>,
  segments: [] as PointingSegment[],
}));

vi.mock('../../../store', () => ({
  useStore: ((selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      requirements: [],
      updateInsight: vi.fn(),
      chatHistory: h.chatHistory,
      objectStates: h.objectStates,
      selectNode: h.selectNode,
      activeModelType: 'IMPORTED',
      importedSceneTree: null,
    };
    if (typeof selector === 'function') return selector(state);
    return state;
  }) as unknown as typeof vi.fn,
  sceneComponents: () => [
    { id: 'node-14', name: 'Left Ear Cup', path: 'Headphones / Left Ear Cup' },
    { id: 'node-22', name: 'Headband', path: 'Headphones / Headband' },
  ],
}));

// The pointing timeline is a store of its own, and the row reads it directly rather than
// being handed it, so this is the boundary a test drives.
vi.mock('../../../lib/pointingTimelineStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/pointingTimelineStore')>();
  return {
    ...actual,
    usePointingTimelineStore: (selector: (s: { segments: PointingSegment[] }) => unknown) =>
      selector({ segments: h.segments }),
  };
});

// AssigneeComboBox (imported by InsightDetailModal) depends on these.
vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => ({ remoteParticipantList: [], localUserId: '' }),
}));
vi.mock('../../../lib/activeReviewStore', () => ({
  useActiveReviewStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ config: { team: [] }, addTeamMember: vi.fn() }),
}));
vi.mock('../../../lib/identity', () => ({ getIdentity: () => null }));

import InsightDetailModal from '../InsightDetailModal';

const LINE_96S: ChatMessage = {
  id: `live-${RECORDING_START}-96000`,
  agentId: '',
  text: 'the pin wears through the bush',
  timestamp: RECORDING_START + 96_000,
  speakerId: 'maria',
  speakerName: 'Maria',
  offsetMs: 96_000,
};

function card(overrides: Partial<InsightCard> = {}): InsightCard {
  return {
    id: 'card-1',
    type: 'RISK',
    agentId: '1',
    title: 'Clearance too tight',
    description: 'It will not assemble.',
    timestamp: RECORDING_START,
    sourceMessageIds: [LINE_96S.id],
    details: { priority: 'High', status: 'Open', componentReference: 'node-14' },
    ...overrides,
  };
}

function openModal(props: Partial<React.ComponentProps<typeof InsightDetailModal>> = {}) {
  h.chatHistory = [LINE_96S];
  h.objectStates = { 'node-14': {}, 'node-22': {} };
  h.segments = [
    {
      userId: 'maria',
      userName: 'Maria',
      partId: 'node-14',
      partName: 'Left Ear Cup',
      source: 'laser',
      fromMs: 96_000,
      toMs: 102_000,
    },
  ];
  const onClose = vi.fn();
  const onScrollToMessage = vi.fn();
  render(
    <InsightDetailModal card={card()} onClose={onClose} onScrollToMessage={onScrollToMessage} {...props} />,
  );
  return { onClose, onScrollToMessage };
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('the modal’s linked components row', () => {
  it('shows the part, who pointed at it, and the span it was said in', () => {
    openModal();

    expect(screen.getByText('Linked components')).toBeTruthy();
    expect(screen.getByText('Left Ear Cup')).toBeTruthy();
    expect(screen.getByText('pointed by Maria, 00:06 · named by the model')).toBeTruthy();
    expect(screen.getByTestId('linked-span')).toHaveTextContent('01:36–01:44');
    // The full view has room for who said it, which the nine-pixel chip in the deck has not.
    expect(screen.getByText('Maria')).toBeTruthy();
  });

  it('shows nothing extra for a card with no link at all', () => {
    openModal({
      card: card({ sourceMessageIds: undefined, details: { priority: 'High', status: 'Open' } }),
    });

    expect(screen.getByText('Subject')).toBeTruthy();
    expect(screen.queryByText('Linked components')).toBeNull();
  });

  it('shows a hand-made card’s component and no spans', () => {
    openModal({
      card: card({
        agentId: '',
        source: 'manual',
        createdByName: 'Maria Okafor',
        sourceMessageIds: undefined,
        details: { priority: 'Medium', status: 'Open', componentReference: 'node-22' },
      }),
    });

    expect(screen.getByText('Headband')).toBeTruthy();
    // A person chose this part, not a model.
    expect(screen.getByText('named on the card')).toBeTruthy();
    expect(screen.queryByTestId('linked-span')).toBeNull();
  });
});

describe('clicking in the modal’s row', () => {
  it('closes the modal and selects the part, so the highlight is visible', () => {
    const { onClose } = openModal();

    fireEvent.click(screen.getByTestId('linked-component'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.selectNode).toHaveBeenCalledWith('node-14');
  });

  it('closes the modal and scrolls the transcript to the line', () => {
    const { onClose, onScrollToMessage } = openModal();

    fireEvent.click(screen.getByTestId('linked-span'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onScrollToMessage).toHaveBeenCalledWith(LINE_96S.id);
  });

  it('leaves the timestamps as labels for a host with no transcript on screen', () => {
    openModal({ onScrollToMessage: undefined });

    expect(screen.queryByTestId('linked-span')).toBeNull();
    expect(screen.getByText('01:36–01:44')).toBeTruthy();
  });
});

describe('a person who may not edit the card', () => {
  it('still gets the row, and still gets to press it', () => {
    // The <fieldset disabled> that makes every field read-only for a guest does not reach
    // this row: reading a card and looking at the part it is about are not editing it.
    openModal({ canEdit: false });

    const chip = screen.getByTestId('linked-component');
    expect(chip).not.toBeDisabled();
    expect(screen.getByTestId('linked-span')).not.toBeDisabled();

    fireEvent.click(chip);
    expect(h.selectNode).toHaveBeenCalledWith('node-14');
  });

  it('still has every field of the form read-only', () => {
    openModal({ canEdit: false });
    expect(screen.getByDisplayValue('Clearance too tight')).toBeDisabled();
  });
});
