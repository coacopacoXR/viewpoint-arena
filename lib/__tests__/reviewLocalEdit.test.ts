// Batch BH3: which changes to a review count as THIS browser editing it.
//
// The room used to save whenever the review it was holding changed — and the
// review it was holding also changes when a REVIEW_CONFIG arrives from somebody
// else, when the room seeds itself from the lobby's handover draft, and when the
// row is read back. Any of those could put a copy on the database that was older
// than the one already there, which is how a saved view went missing with two
// people in the room (pages/__tests__/roomReviewStaleWrite.test.tsx drives that).
//
// So an edit raises a flag for this browser, and only a flagged change is saved.
// This file is the list of what counts: every action that produces a draft marks,
// and nothing that adopts somebody else's copy does.

import { describe, it, expect, beforeEach } from 'vitest';
import { useActiveReviewStore } from '../activeReviewStore';
import { consumeLocalEdit, forgetLocalEdit, markLocalEdit } from '../reviewLocalEdit';
import type { ReviewDraft } from '../reviewSetupStore';

type Store = ReturnType<typeof useActiveReviewStore.getState>;

function baseDraft(overrides: Partial<ReviewDraft> = {}): ReviewDraft {
  const now = Date.now();
  return {
    reviewId: 'rev-1',
    title: 'Bracket',
    description: '',
    asset: { modelType: 'headphones', references: [] },
    viewpoints: [
      { id: 'vp-1', label: 'View 1', position: [0, 0, 0], lookAt: [0, 0, 0], createdAt: now },
      { id: 'vp-2', label: 'View 2', position: [0, 0, 0], lookAt: [0, 0, 0], createdAt: now },
    ],
    pins: [
      { id: 'pin-1', label: 'Weld', worldPos: [0, 0, 0], severity: 'info', createdAt: now, committedCommentId: 'c-1' },
      { id: 'pin-2', label: 'Gap', worldPos: [0, 0, 0], severity: 'info', createdAt: now },
    ],
    agenda: [
      { id: 'ag-1', title: 'First', viewpointIds: [], pinIds: [] },
      { id: 'ag-2', title: 'Second', viewpointIds: [], pinIds: [] },
    ],
    requirements: [
      { id: 'req-1', code: 'R1', description: 'One', category: 'MECHANICAL', status: 'PENDING' },
      { id: 'req-2', code: 'R2', description: 'Two', category: 'MECHANICAL', status: 'PENDING' },
    ],
    team: [{ id: 'm-1', name: 'Olivia' }, { id: 'm-2', name: 'Pete' }],
    labels: { material: 'Steel' },
    listed: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Every action that changes the review, which is every action the room's tabs,
 * its amber strip, its Review popup, its manager notes and its comment list can
 * reach. Each is called against the fixture above, so each has something to act
 * on and answers with the draft it produced.
 */
const EDITS: Array<[string, (store: Store) => unknown]> = [
  ['addViewpoint', (s) => s.addViewpoint({ label: 'View 3', position: [0, 0, 0], lookAt: [0, 0, 0] })],
  ['updateViewpoint', (s) => s.updateViewpoint('vp-1', { label: 'Renamed' })],
  ['removeViewpoint', (s) => s.removeViewpoint('vp-2')],
  ['updatePin', (s) => s.updatePin('pin-2', { notes: 'Undercut' })],
  ['removePin', (s) => s.removePin('pin-2')],
  ['commitPinAsComment', (s) => s.commitPinAsComment('pin-2', 'Olivia', '#fff')],
  ['clearCommittedCommentId', (s) => s.clearCommittedCommentId('c-1')],
  ['applyCommentEdit', (s) => s.applyCommentEdit('pre-vp-vp-1', { content: 'Noted' })],
  ['addAgendaItem', (s) => s.addAgendaItem({ title: 'Third' })],
  ['updateAgendaItem', (s) => s.updateAgendaItem('ag-1', { followUp: 'Ask Pete' })],
  ['removeAgendaItem', (s) => s.removeAgendaItem('ag-2')],
  ['reorderAgenda', (s) => s.reorderAgenda(0, 1)],
  ['attachViewpointToAgendaItem', (s) => s.attachViewpointToAgendaItem('ag-1', 'vp-1')],
  ['detachViewpointFromAgendaItem', (s) => s.detachViewpointFromAgendaItem('ag-1', 'vp-1')],
  ['attachPinToAgendaItem', (s) => s.attachPinToAgendaItem('ag-1', 'pin-1')],
  ['detachPinFromAgendaItem', (s) => s.detachPinFromAgendaItem('ag-1', 'pin-1')],
  ['addRequirement', (s) => s.addRequirement({ code: 'R3', description: 'Three', category: 'MECHANICAL', status: 'PENDING' })],
  ['updateRequirement', (s) => s.updateRequirement('req-1', { status: 'AT_RISK' })],
  ['removeRequirement', (s) => s.removeRequirement('req-2')],
  ['reorderRequirements', (s) => s.reorderRequirements(0, 1)],
  ['setLabel', (s) => s.setLabel('material', 'Ti-6Al-4V')],
  ['clearLabel', (s) => s.clearLabel('material')],
  ['addTeamMember', (s) => s.addTeamMember({ name: 'Sam' })],
  ['updateTeamMember', (s) => s.updateTeamMember('m-1', { role: 'Owner' })],
  ['removeTeamMember', (s) => s.removeTeamMember('m-2')],
  ['reorderTeam', (s) => s.reorderTeam(0, 1)],
];

/** Actions that change what this browser is looking at, not the review itself. */
const NOT_EDITS: Array<[string, (store: Store) => unknown]> = [
  ['setConfig', (s) => s.setConfig(baseDraft())],
  ['setConfig(null)', (s) => s.setConfig(null)],
  ['setManagerMode', (s) => s.setManagerMode(true)],
  ['setSessionNotes', (s) => s.setSessionNotes('local only')],
  ['setAgendaIdx', (s) => s.setAgendaIdx(1)],
  ['nextSlide', (s) => s.nextSlide()],
  ['prevSlide', (s) => s.prevSlide()],
  ['jumpToSlide', (s) => s.jumpToSlide(1)],
  ['jumpToViewpoint', (s) => s.jumpToViewpoint('vp-1')],
  ['jumpToViewpointAtIdx', (s) => s.jumpToViewpointAtIdx(1)],
  ['nextViewpoint', (s) => s.nextViewpoint()],
  ['prevViewpoint', (s) => s.prevViewpoint()],
  ['setActiveViewpointIdx', (s) => s.setActiveViewpointIdx(1)],
  ['clearJumpTarget', (s) => s.clearJumpTarget()],
];

/** Actions that find nothing to change, and so must not licence a write. */
const NO_OPS: Array<[string, (store: Store) => unknown]> = [
  ['setLabel to the value it already has', (s) => s.setLabel('material', 'Steel')],
  ['clearLabel on a field that is not set', (s) => s.clearLabel('phase')],
  ['reorderAgenda onto itself', (s) => s.reorderAgenda(0, 0)],
  ['reorderAgenda out of range', (s) => s.reorderAgenda(0, 9)],
  ['reorderRequirements onto itself', (s) => s.reorderRequirements(1, 1)],
  ['commitPinAsComment on an unknown pin', (s) => s.commitPinAsComment('nope', 'A', '#000')],
  ['commitPinAsComment on a pin already committed', (s) => s.commitPinAsComment('pin-1', 'A', '#000')],
  ['clearCommittedCommentId for an unknown comment', (s) => s.clearCommittedCommentId('nope')],
  ['applyCommentEdit for a live comment', (s) => s.applyCommentEdit('c-1', { content: 'x' })],
  ['reorderTeam out of range', (s) => s.reorderTeam(0, 5)],
];

beforeEach(() => {
  forgetLocalEdit();
  useActiveReviewStore.setState({ config: baseDraft(), jumpTarget: null, activeViewpointIdx: 0, agendaIdx: 0 });
  forgetLocalEdit();
});

describe('the local-edit flag', () => {
  it('is raised once and read once', () => {
    expect(consumeLocalEdit()).toBe(false);
    markLocalEdit();
    expect(consumeLocalEdit()).toBe(true);
    expect(consumeLocalEdit()).toBe(false);
    markLocalEdit();
    forgetLocalEdit();
    expect(consumeLocalEdit()).toBe(false);
  });

  it.each(EDITS)('%s marks the review as edited here', (_name, run) => {
    expect(run(useActiveReviewStore.getState()), 'the action should have changed the review').toBeTruthy();
    expect(consumeLocalEdit()).toBe(true);
  });

  it.each(NOT_EDITS)('%s does not mark the review as edited here', (_name, run) => {
    run(useActiveReviewStore.getState());
    expect(consumeLocalEdit()).toBe(false);
  });

  it.each(NO_OPS)('%s leaves the flag alone', (_name, run) => {
    run(useActiveReviewStore.getState());
    expect(consumeLocalEdit()).toBe(false);
  });

  it('marks nothing when there is no review open', () => {
    useActiveReviewStore.getState().setConfig(null);
    forgetLocalEdit();
    expect(useActiveReviewStore.getState().addViewpoint({ label: 'V', position: [0, 0, 0], lookAt: [0, 0, 0] })).toBeNull();
    expect(consumeLocalEdit()).toBe(false);
  });

  it('is cancelled by adopting somebody else’s copy of the review', () => {
    // A mark no subscriber was listening for — a viewer who renamed something
    // while nobody was writing — must not survive into a copy that arrives from
    // the room, or the next change this browser sees would be written as its own.
    markLocalEdit();
    useActiveReviewStore.getState().setConfig(baseDraft({ title: 'From the room' }));
    expect(consumeLocalEdit()).toBe(false);
  });
});
