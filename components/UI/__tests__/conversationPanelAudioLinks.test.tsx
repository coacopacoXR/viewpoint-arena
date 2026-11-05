// The Capture panel's cards and the audio they came from (task 09b).
//
// components/UI/__tests__/cardAudioLinks.test.tsx pins the row on its own; this is the
// wiring between the row and the panel that hosts it, which is where the two things the
// task asked for actually land: a chip that takes the SAME select path a Model Tree row
// takes (the store's `selectNode`, handed down rather than re-read), and a timestamp that
// takes the panel's own scroll-to-message routine — the one that centres a line in the
// transcript and flashes it — rather than a second copy of it.
//
// The panel is rendered for real. Everything mocked below is either a leaf the panel merely
// mounts or a boundary this test needs to drive, and the shape of the mocks is the one
// components/UI/__tests__/conversationPanelManualCard.test.tsx already uses.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

const h = vi.hoisted(() => ({
  allowed: [] as string[],
  state: {} as Record<string, unknown>,
  broadcastInsightCard: vi.fn(),
  addInsightCard: vi.fn(),
  updateInsight: vi.fn(),
  selectNode: vi.fn(),
  scrollTo: vi.fn(),
  openedModal: [] as string[],
}));

vi.mock('../../../store', () => ({
  // ConversationPanel is one of the few components that reads the whole store
  // (`const { ... } = useStore()`), so no selector handling is needed.
  useStore: () => h.state,
  sceneComponents: () => [
    { id: 'root', name: 'Headphones', path: 'Headphones' },
    { id: 'node-14', name: 'Left Ear Cup', path: 'Headphones / Left Ear Cup' },
    { id: 'node-22', name: 'Headband', path: 'Headphones / Headband' },
  ],
}));

vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => ({
    remoteParticipantList: [],
    localUserId: 'me',
    broadcastInsightCard: h.broadcastInsightCard,
  }),
}));

vi.mock('../../../lib/reviews/useReviewRole', () => ({
  useReviewRole: () => ({
    role: 'participant',
    rolesApply: false,
    can: (action: string) => h.allowed.includes(action),
    loading: false,
    ownerId: null,
    members: [],
    refresh: () => {},
  }),
}));

vi.mock('../../../lib/identity', () => ({
  getDisplayName: () => 'Maria Okafor',
  getIdentity: () => ({ name: 'Maria Okafor', color: '#f00' }),
  attendeeNames: () => ['Maria Okafor'],
}));

vi.mock('../RecordingControls', () => ({ default: () => null }));
vi.mock('../RecordingIndicator', () => ({ default: () => null }));
vi.mock('../InsightExplainer', () => ({ default: () => null }));
// Stubbed, and recording what it was handed: the assertions here are about a click on the
// row NOT reaching the card's own click handler, and the modal mounting is how that handler
// shows itself (components/UI/__tests__/insightDetailModal.*.test.tsx cover the modal).
vi.mock('../InsightDetailModal', () => ({
  default: (props: { card: { title: string } }) => {
    h.openedModal.push(props.card.title);
    return null;
  },
}));
// Carried over cards read the tracker over the network; nothing here is about them.
vi.mock('../CarriedOverCards', () => ({ default: () => null }));

import ConversationPanel from '../ConversationPanel';
import { usePointingTimelineStore } from '../../../lib/pointingTimelineStore';
import { useKeptRecordingStore } from '../../../lib/capture/keptRecordingStore';
import { clearLaserEntry } from '../../../lib/laserTargetRef';
import type { ChatMessage, InsightCard } from '../../../types';

const RECORDING_START = 1_700_000_000_000;
const PARTICIPANT = ['meet', 'addCard', 'editCard'];

/** A live transcript line at 96 s, stamped the way lib/useLiveTranscript stamps one. */
const LINE_96S: ChatMessage = {
  id: `live-${RECORDING_START}-96000`,
  agentId: '',
  text: 'the pin wears through the bush',
  timestamp: RECORDING_START + 96_000,
  speakerId: 'maria',
  speakerName: 'Maria',
  offsetMs: 96_000,
};

/** A line from an earlier recording in the same room, which the browser no longer holds. */
const LINE_FROM_ELSEWHERE: ChatMessage = { ...LINE_96S, id: `live-${RECORDING_START - 1}-4000`, offsetMs: 4_000 };

function aiCard(overrides: Partial<InsightCard> = {}): InsightCard {
  return {
    id: 'insight-ai-1',
    type: 'RISK',
    agentId: '1',
    title: 'Clearance too tight',
    description: 'Pete: it will not assemble.',
    timestamp: RECORDING_START,
    sourceMessageIds: [LINE_96S.id],
    details: { priority: 'High', status: 'Open' },
    ...overrides,
  };
}

function openPanel(cards: InsightCard[], chatHistory: ChatMessage[] = [LINE_96S]) {
  h.allowed = PARTICIPANT;
  h.openedModal = [];
  h.state = {
    chatHistory,
    insightCards: cards,
    agents: [{ id: '1', name: 'SYS.OP', role: 'PRESENTER', color: '#ff4400' }],
    viewMode: 'FREE',
    splitScreenTarget: null,
    setSplitScreenTarget: () => {},
    requirements: [],
    isPrivacyMode: false,
    updateInsight: h.updateInsight,
    addInsightCard: h.addInsightCard,
    selectNode: h.selectNode,
    // Both parts in the scene, so neither chip is the "not in the scene any more" one.
    objectStates: {
      'node-14': { id: 'node-14', visible: true, selected: false },
      'node-22': { id: 'node-22', visible: true, selected: false },
    },
    activeModelType: 'IMPORTED',
    importedSceneTree: null,
    sessionHostId: null,
  };
  return render(<ConversationPanel />);
}

/** Maria's laser on the ear cup for the first six of the line's eight seconds. */
function pointing() {
  act(() => {
    usePointingTimelineStore.setState({
      segments: [
        {
          userId: 'maria',
          userName: 'Maria',
          partId: 'node-14',
          partName: 'Left Ear Cup',
          source: 'laser',
          fromMs: 96_000,
          toMs: 102_000,
        },
      ],
    });
  });
}

function keepRecording(startedAt: number = RECORDING_START) {
  act(() => {
    useKeptRecordingStore.setState({ recording: { startedAt, url: 'blob:kept' } });
  });
}

function transcriptLine(id: string): HTMLElement {
  const el = document.getElementById(`msg-${id}`);
  if (!el) throw new Error(`the transcript is not showing ${id}`);
  return el;
}

beforeEach(() => {
  // The panel's sticky-scroll effect and scrollToMessage both call scrollTo, which jsdom
  // does not have.
  Object.defineProperty(Element.prototype, 'scrollTo', { value: h.scrollTo, configurable: true });
  vi.clearAllMocks();
  clearLaserEntry('me');
  pointing();
});

afterEach(() => {
  cleanup();
  clearLaserEntry('me');
  act(() => {
    usePointingTimelineStore.setState({ segments: [] });
    useKeptRecordingStore.setState({ recording: null });
  });
});

describe('a card in the deck', () => {
  it('says which part its audio was about, and who was pointing at it', () => {
    openPanel([aiCard()]);

    expect(screen.getByTestId('card-audio-links')).toBeTruthy();
    expect(screen.getByText('Left Ear Cup')).toBeTruthy();
    expect(screen.getByText('pointed by Maria, 00:06')).toBeTruthy();
    expect(screen.getByTestId('linked-span')).toHaveTextContent('01:36–01:44');
  });

  it('says when the model named the part too', () => {
    openPanel([aiCard({ details: { priority: 'High', status: 'Open', componentReference: 'node-14' } })]);

    expect(screen.getByText('pointed by Maria, 00:06 · named by the model')).toBeTruthy();
  });

  it('draws nothing at all for a card with no link', () => {
    // No "Linked components: none" on every card in the deck.
    openPanel([aiCard({ sourceMessageIds: undefined, details: { priority: 'High', status: 'Open' } })]);

    expect(screen.getByText('Clearance too tight')).toBeTruthy();
    expect(screen.queryByTestId('card-audio-links')).toBeNull();
    expect(screen.queryByText('Linked components')).toBeNull();
  });

  it('shows a hand-made card’s component and no spans', () => {
    openPanel([
      aiCard({
        id: 'insight-manual-1',
        agentId: '',
        source: 'manual',
        createdByName: 'Maria Okafor',
        sourceMessageIds: undefined,
        details: { priority: 'Medium', status: 'Open', componentReference: 'node-22' },
      }),
    ]);

    expect(screen.getByText('Headband')).toBeTruthy();
    // A person chose this part, not a model — the same card's footer says "Added by Maria".
    expect(screen.getByText('named on the card')).toBeTruthy();
    expect(screen.queryByTestId('linked-span')).toBeNull();
  });

  it('marks a part the scene no longer holds, and offers no click on it', () => {
    openPanel([aiCard({ details: { priority: 'High', status: 'Open', componentReference: 'node-gone' } })]);

    expect(screen.getByTestId('linked-component-missing')).toHaveTextContent('node-gone');
    // The part Maria was pointing at is still in the scene, so it is still a chip to press.
    expect(screen.getAllByTestId('linked-component')).toHaveLength(1);
    expect(screen.getByTestId('linked-component')).toHaveTextContent('Left Ear Cup');
  });
});

describe('clicking a chip in the deck', () => {
  it('selects the part through the store, the way a Model Tree row does', () => {
    openPanel([aiCard()]);

    fireEvent.click(screen.getByTestId('linked-component'));
    expect(h.selectNode).toHaveBeenCalledWith('node-14');
  });

  it('does not open the card detail as well', () => {
    openPanel([aiCard()]);

    fireEvent.click(screen.getByTestId('linked-component'));
    expect(h.openedModal).toEqual([]);

    // The card itself still opens it, so the row is not swallowing every click on the card.
    fireEvent.click(screen.getByText('Clearance too tight'));
    expect(h.openedModal).toEqual(['Clearance too tight']);
  });
});

describe('clicking a timestamp in the deck', () => {
  it('scrolls the transcript to that line and flashes it', () => {
    openPanel([aiCard()]);
    const line = transcriptLine(LINE_96S.id);
    expect(line.style.backgroundColor).toBe('');

    fireEvent.click(screen.getByTestId('linked-span'));

    expect(h.scrollTo).toHaveBeenCalled();
    expect(line.style.backgroundColor).toBe('rgba(255, 255, 255, 0.2)');
  });

  it('does not open the card detail as well', () => {
    openPanel([aiCard()]);

    fireEvent.click(screen.getByTestId('linked-span'));
    expect(h.openedModal).toEqual([]);
  });
});

describe('playing a span back from the deck', () => {
  it('offers no ▶ while this browser holds no recording', () => {
    openPanel([aiCard()]);
    expect(screen.queryByTestId('linked-span-play')).toBeNull();
  });

  it('offers a ▶ once the recording it came from is still held', () => {
    keepRecording();
    openPanel([aiCard()]);
    expect(screen.getByTestId('linked-span-play')).toBeTruthy();
  });

  it('offers none for a card from an earlier recording in the same room', () => {
    // Only the latest recording is kept; a ▶ here would play the wrong minute of it.
    keepRecording();
    openPanel([aiCard({ sourceMessageIds: [LINE_FROM_ELSEWHERE.id] })], [LINE_FROM_ELSEWHERE]);
    expect(screen.queryByTestId('linked-span-play')).toBeNull();
    // The span itself is still worth showing: it is when the line was said.
    expect(screen.getByTestId('linked-span')).toHaveTextContent('00:04–00:12');
  });

  it('offers one per span, for a card that came from two lines', () => {
    keepRecording();
    const second: ChatMessage = { ...LINE_96S, id: `live-${RECORDING_START}-200000`, offsetMs: 200_000 };
    openPanel([aiCard({ sourceMessageIds: [LINE_96S.id, second.id] })], [LINE_96S, second]);

    expect(screen.getAllByTestId('linked-span-play')).toHaveLength(2);
  });
});
