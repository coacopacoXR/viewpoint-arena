// Adding a pin from inside the room — batch BI's second section.
//
// The Pins tab could list a pin, jump to it and edit it, but not add one: `addPin`
// lived only in lib/reviewSetupStore, which is the lobby's draft and not the review
// a room is presenting. What only a render of the panel can prove is the whole
// path — that the tab arms the room's ONE raycast rather than growing a second one,
// that the point and the part the canvas answers with become a pin, and that the
// pin travels the way every other review edit does: through the actions the tab was
// rendered against, which mark it as this browser's edit (so RoomPage's subscriber
// saves it, batch BH3) and broadcast the draft that came back (so everybody else's
// copy becomes it).
//
// The click on the model is not simulated — there is no WebGL here, and the raycast
// is components/Scene/SpatialComments' job. What stands in for it is the store
// write that raycast makes, which is the whole of the contract between the two.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import type { ReviewDraft } from '../../../lib/reviewSetupStore';

const noop = () => {};

// `unknown` rather than ReviewDraft: vi.hoisted runs before the imports exist, and
// a type is erased anyway — the call is read back as a ReviewDraft below.
const broadcast = vi.hoisted(() => ({ reviewConfig: vi.fn((_draft: unknown) => true) }));

vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => ({
    localUserId: 'me',
    remoteParticipantList: [],
    broadcastReviewConfig: broadcast.reviewConfig,
  }),
}));

// A deployment with no accounts: the People tab is not offered, and nothing here
// reaches a roster.
vi.mock('../../../lib/config/ConfigContext', () => ({
  useConnectorConfig: () => ({
    config: { identity: { mode: 'none', methods: [], allowGuests: true } },
    loading: false,
    error: null,
    available: true,
  }),
}));

// PeopleTab reaches lib/supabase at import time, and createClient(undefined, …)
// throws. The tab is never rendered here, but the module is loaded.
vi.mock('../../../lib/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) }, from: () => ({}) },
  supabaseConfigured: true,
}));

const { default: ReviewEditPanel } = await import('../ReviewEditPanel');
const { useStore } = await import('../../../store');
const { useActiveReviewStore } = await import('../../../lib/activeReviewStore');
const { consumeLocalEdit, forgetLocalEdit } = await import('../../../lib/reviewLocalEdit');
const { createReviewDraft } = await import('../../../lib/reviewSetupStore');

function draft(overrides: Partial<ReviewDraft> = {}): ReviewDraft {
  return { ...createReviewDraft('room-1', 'Landing gear review'), ...overrides };
}

/** The panel, on its Pins tab, with a review open in the room. */
function renderPins(config: ReviewDraft = draft()) {
  useStore.setState({ commentMode: 'none' });
  useStore.getState().setPendingComment(null, null, null);
  useActiveReviewStore.getState().setConfig(config);
  forgetLocalEdit();
  broadcast.reviewConfig.mockClear();

  const view = render(<ReviewEditPanel reviewId="room-1" onRosterChanged={noop} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Pins' }));
  return view;
}

/** What the room's raycast does with a click on the model. */
function clickTheModel(partName: string, nodeId = 'node-1') {
  act(() => {
    useStore.getState().setPendingComment({ x: 1.5, y: 0.25, z: -2 }, nodeId, partName);
  });
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

describe('ReviewEditPanel — adding a pin in the room', () => {
  it('arms the room\'s pin drop, and offers the way out of it', () => {
    renderPins();

    fireEvent.click(screen.getByRole('button', { name: /\+ Pin/ }));

    expect(useStore.getState().commentMode).toBe('placing-pin');
    expect(screen.getByText(/Click the model to place the pin/)).toBeTruthy();
    // The arm is not a toggle left on by accident: Done, Cancel and unmounting the
    // panel all have to put the room back, or the next click on the model would
    // place a pin nobody is watching for.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useStore.getState().commentMode).toBe('none');
  });

  it('turns the point and the part the click found into a pin, through the review\'s own write', () => {
    renderPins();
    fireEvent.click(screen.getByRole('button', { name: /\+ Pin/ }));

    clickTheModel('Left Ear Cup');

    const pins = useActiveReviewStore.getState().config?.pins ?? [];
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({
      label: 'New pin',
      worldPos: [1.5, 0.25, -2],
      meshIndex: 'node-1',
      partName: 'Left Ear Cup',
      severity: 'info',
    });
    // And it is on screen as a row, with its notes open, rather than somewhere in
    // a list to hunt through.
    expect(screen.getByDisplayValue('New pin')).toBeTruthy();
  });

  it('marks the edit and broadcasts the draft, the way every other review edit does', () => {
    renderPins();
    fireEvent.click(screen.getByRole('button', { name: /\+ Pin/ }));

    clickTheModel('Left Ear Cup');

    // The mark is what RoomPage's subscriber waits for, and it saves on nothing
    // else — so a pin that did not raise it would be visible in this browser and
    // gone on the next reload.
    expect(consumeLocalEdit()).toBe(true);
    // One broadcast, carrying the draft that came back from the write: the room
    // server relays it to every other connection and remembers it for whoever
    // joins next.
    expect(broadcast.reviewConfig).toHaveBeenCalledTimes(1);
    const sent = broadcast.reviewConfig.mock.calls[0][0] as ReviewDraft;
    expect(sent.pins).toHaveLength(1);
    expect(sent.pins[0].partName).toBe('Left Ear Cup');
  });

  it('mirrors the pin into the room\'s comments, so its marker is on the canvas', () => {
    // That mirror is what makes a pin something everybody in the meeting can see
    // rather than something only the editor's panel lists.
    renderPins();
    const before = useStore.getState().comments.length;
    fireEvent.click(screen.getByRole('button', { name: /\+ Pin/ }));

    clickTheModel('Left Ear Cup');

    expect(useStore.getState().comments).toHaveLength(before + 1);
  });

  it('puts the room back once the pin has landed', () => {
    renderPins();
    fireEvent.click(screen.getByRole('button', { name: /\+ Pin/ }));

    clickTheModel('Left Ear Cup');

    expect(useStore.getState().commentMode).toBe('none');
    expect(useStore.getState().pendingCommentPosition).toBeNull();
    expect(useStore.getState().pendingCommentNodeName).toBeNull();
    // And the tab is ready to arm another drop.
    expect(screen.getByRole('button', { name: /\+ Pin/ })).toBeTruthy();
  });

  it('leaves a pending comment alone when nothing is being placed', () => {
    // The comment panel uses the same three fields. A pin drop that fired on any
    // pending point would turn somebody's comment into a pin.
    renderPins();

    clickTheModel('Left Ear Cup');

    expect(useActiveReviewStore.getState().config?.pins).toEqual([]);
    expect(consumeLocalEdit()).toBe(false);
    expect(broadcast.reviewConfig).not.toHaveBeenCalled();
  });

  it('gives the drop up when the panel goes away with it armed', () => {
    const view = renderPins();
    fireEvent.click(screen.getByRole('button', { name: /\+ Pin/ }));
    expect(useStore.getState().commentMode).toBe('placing-pin');

    view.unmount();

    expect(useStore.getState().commentMode).toBe('none');
    expect(useStore.getState().pendingCommentPosition).toBeNull();
  });
});
