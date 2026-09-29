// The Capture panel's + Card, end to end (docs/plan/14 batch BG).
//
// The form has its own test; this one is about the PANEL: who is offered the
// button, what saving does to the store and to the room, how the card reads
// afterwards, and that a hand-made card is editable exactly like an agent's.
//
// The panel is rendered for real. Everything mocked below is either a leaf the
// panel merely mounts (recording controls, explainer) or a boundary this test
// needs to drive (presence, the role hook, the store).

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const h = vi.hoisted(() => ({
  // What can(action) answers, i.e. lib/reviews/roles.ts's ALLOWED row for me.
  allowed: [] as string[],
  state: {} as Record<string, unknown>,
  broadcastInsightCard: vi.fn(),
  addInsightCard: vi.fn(),
  updateInsight: vi.fn(),
  // InsightDetailModal is stubbed rather than rendered: the assertions here are
  // about the canEdit the panel hands it, not about the modal's own fields
  // (components/UI/__tests__/insightDetailModal.*.test.tsx cover those).
  modalProps: [] as Array<{ title: string; canEdit: boolean | undefined }>,
}));

vi.mock('../../../store', () => ({
  // ConversationPanel is one of the few components that reads the whole store
  // (`const { ... } = useStore()`), so no selector handling is needed.
  useStore: () => h.state,
  // What the panel used to build itself, out of getCurrentSceneTree +
  // flattenSceneTree: the same parts, already flattened, because batch BI put the
  // "a room with no model has no parts" decision inside the store's one helper.
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
}));

vi.mock('../RecordingControls', () => ({ default: () => null }));
vi.mock('../RecordingIndicator', () => ({ default: () => null }));
vi.mock('../InsightExplainer', () => ({ default: () => null }));
vi.mock('../InsightDetailModal', () => ({
  default: (props: { card: { title: string }; canEdit?: boolean }) => {
    h.modalProps.push({ title: props.card.title, canEdit: props.canEdit });
    return null;
  },
}));

import ConversationPanel from '../ConversationPanel';
import { clearLaserEntry, setLaserEntry } from '../../../lib/laserTargetRef';
import type { InsightCard } from '../../../types';

const PARTICIPANT = ['meet', 'addCard', 'editCard'];
const GUEST = ['meet'];

function aiCard(overrides: Partial<InsightCard> = {}): InsightCard {
  return {
    id: 'insight-ai-1',
    type: 'RISK',
    agentId: '1',
    title: 'Clearance too tight',
    description: 'Pete: it will not assemble.',
    timestamp: 1_700_000_000_000,
    details: { priority: 'High', status: 'Open' },
    ...overrides,
  };
}

function manualCard(overrides: Partial<InsightCard> = {}): InsightCard {
  return aiCard({
    id: 'insight-manual-1',
    agentId: '',
    title: 'Pad cracks at the hinge',
    source: 'manual',
    createdByName: 'Maria Okafor',
    ...overrides,
  });
}

function panelState(overrides: Record<string, unknown> = {}) {
  h.state = {
    chatHistory: [],
    insightCards: [],
    agents: [{ id: '1', name: 'SYS.OP', role: 'PRESENTER', color: '#ff4400' }],
    viewMode: 'FREE',
    splitScreenTarget: null,
    setSplitScreenTarget: () => {},
    requirements: [],
    isPrivacyMode: false,
    updateInsight: h.updateInsight,
    addInsightCard: h.addInsightCard,
    objectStates: {},
    activeModelType: 'IMPORTED',
    importedSceneTree: null,
    sessionHostId: null,
    ...overrides,
  };
}

function openPanel(allowed: string[] = PARTICIPANT, overrides: Record<string, unknown> = {}) {
  h.allowed = allowed;
  h.modalProps = [];
  panelState(overrides);
  return render(<ConversationPanel />);
}

function openForm() {
  fireEvent.click(screen.getByTitle('Add a card by hand'));
  return screen.getByRole('form', { name: 'New card' });
}

beforeEach(() => {
  // The panel's sticky-scroll effect calls scrollTo, which jsdom does not have.
  Object.defineProperty(Element.prototype, 'scrollTo', { value: () => {}, configurable: true });
  vi.clearAllMocks();
  clearLaserEntry('me');
});

afterEach(() => {
  cleanup();
  clearLaserEntry('me');
});

describe('who is offered + Card', () => {
  it('offers it to everybody who may add a card', () => {
    openPanel();
    expect(screen.getByTitle('Add a card by hand')).toBeTruthy();
  });

  it('does not offer it to a guest', () => {
    openPanel(GUEST);
    expect(screen.queryByTitle('Add a card by hand')).toBeNull();
  });

  it('offers it with no AI in the room at all — nothing captured, privacy mode on', () => {
    // The point of the feature: typing a card is the ALTERNATIVE to capture, so
    // it cannot depend on a recording, on a provider, or on capture being live.
    openPanel(PARTICIPANT, { isPrivacyMode: true });
    expect(screen.getByTitle('Add a card by hand')).toBeTruthy();
    expect(openForm()).toBeTruthy();
  });
});

describe('saving a hand-made card', () => {
  it('adds it to the store and broadcasts the same card to the room', () => {
    openPanel();
    const form = openForm();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Pad cracks at the hinge' } });
    fireEvent.submit(form);

    expect(h.addInsightCard).toHaveBeenCalledTimes(1);
    // One card object, sent to the room unchanged: receivers of INSIGHT_CARD
    // need no new handling for a card a person typed.
    expect(h.broadcastInsightCard).toHaveBeenCalledWith(h.addInsightCard.mock.calls[0][0]);

    const card = h.addInsightCard.mock.calls[0][0] as InsightCard;
    expect(card.source).toBe('manual');
    expect(card.createdByName).toBe('Maria Okafor');
    expect(card.agentId).toBe('');
    expect(card.type).toBe('RISK');
    expect(card.details.priority).toBe('Medium');
    expect(card.details.status).toBe('Open');
    expect(card.title).toBe('Pad cracks at the hinge');
    // The form closes, so the deck shows the list again rather than an empty form.
    expect(screen.queryByRole('form', { name: 'New card' })).toBeNull();
  });

  it('attaches the part the room has selected', () => {
    openPanel(PARTICIPANT, { objectStates: { 'node-14': { visible: true, selected: true, expanded: false } } });
    const form = openForm();
    expect(screen.getByText('Left Ear Cup')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Pad cracks' } });
    fireEvent.submit(form);

    const card = h.addInsightCard.mock.calls[0][0] as InsightCard;
    expect(card.details.componentReference).toBe('node-14');
  });

  it('attaches the part the laser is on, even with nothing selected in the tree', () => {
    setLaserEntry('me', 'node-22', null, 'Headband', '#f00');
    openPanel();
    const form = openForm();
    expect(screen.getByText('Headband')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Headband flexes' } });
    fireEvent.submit(form);

    const card = h.addInsightCard.mock.calls[0][0] as InsightCard;
    expect(card.details.componentReference).toBe('node-22');
  });
});

describe('how a card reads afterwards', () => {
  it('says who added a hand-made card', () => {
    openPanel(PARTICIPANT, { insightCards: [manualCard()] });
    expect(screen.getByText('Added by Maria Okafor')).toBeTruthy();
    // No agent wrote it, so no agent is named either.
    expect(screen.queryByText('SYS.OP')).toBeNull();
  });

  it('still names the agent on a card an agent wrote', () => {
    openPanel(PARTICIPANT, { insightCards: [aiCard()] });
    expect(screen.getByText('SYS.OP')).toBeTruthy();
    expect(screen.queryByText(/Added by/)).toBeNull();
  });

  it('falls back to "by hand" for a manual card with no name recorded', () => {
    openPanel(PARTICIPANT, { insightCards: [manualCard({ createdByName: '   ' })] });
    expect(screen.getByText('Added by hand')).toBeTruthy();
  });
});

describe('editing a card afterwards', () => {
  it('hands an editor the same form for a hand-made card as for an agent’s', () => {
    openPanel(PARTICIPANT, { insightCards: [manualCard(), aiCard()] });
    fireEvent.click(screen.getByText('Pad cracks at the hinge'));
    fireEvent.click(screen.getByText('Clearance too tight'));

    expect(h.modalProps).toEqual([
      { title: 'Pad cracks at the hinge', canEdit: true },
      { title: 'Clearance too tight', canEdit: true },
    ]);
    expect(screen.getAllByTitle('Accept')).toHaveLength(2);
  });

  it('offers a guest the card to read but not to change', () => {
    openPanel(GUEST, { insightCards: [manualCard()] });
    fireEvent.click(screen.getByText('Pad cracks at the hinge'));

    expect(h.modalProps).toEqual([{ title: 'Pad cracks at the hinge', canEdit: false }]);
    expect(screen.queryByTitle('Accept')).toBeNull();
    expect(screen.queryByTitle('Reject')).toBeNull();
  });
});
