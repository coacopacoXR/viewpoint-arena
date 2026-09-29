// What an empty room says about itself — batch BI's first section.
//
// A room used to open on a pair of headphones, so an empty canvas was something
// only a deliberate removal could produce and it needed no explanation. Now it is
// where every room starts, and it has to say so: one calm sentence in the middle of
// the canvas and the two ways out of it — import the product this meeting is about,
// or start from the sample. Somebody who may not change the models
// gets the sentence and nothing else, because two buttons they cannot press are
// noise in the middle of the thing everybody is looking at.
//
// The picker is the model tree's, reached through the same module slot the PLM
// launch uses to hand a file over: claiming it here and asserting the click reached
// it is what proves there is one import pipeline and not two.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { Role } from '../../../../lib/reviews/roles';
import type { SceneUpdate } from '../../../../lib/scene/roomScene';

const ME = 'me';
const HOST = 'somebody-else';

const sent = vi.hoisted(() => ({ updates: [] as SceneUpdate[] }));

const roleAnswer = vi.hoisted(() => ({
  role: 'owner' as Role,
  rolesApply: true,
}));

vi.mock('../../../../lib/PresenceContext', () => ({
  usePresence: () => ({
    localUserId: ME,
    remoteParticipantList: [],
    broadcastSceneUpdate: (update: SceneUpdate) => {
      sent.updates.push(update);
      return true;
    },
    broadcastSetModelEditors: () => true,
  }),
}));

vi.mock('../../../../lib/reviews/useReviewRole', () => ({
  useReviewRole: () => ({
    get role() { return roleAnswer.role; },
    get rolesApply() { return roleAnswer.rolesApply; },
    can: (action: string) => roleAnswer.role === 'owner'
      || (roleAnswer.role === 'editor' && (action === 'editReview' || action === 'setModelEditors'))
      || action === 'meet' || action === 'addCard' || action === 'editCard',
    loading: false,
    ownerId: null,
    members: [],
    refresh: () => {},
  }),
}));

const { default: EmptyScenePrompt } = await import('../EmptyScenePrompt');
const { useStore } = await import('../../../../store');
const { claimImportPicker } = await import('../../../../lib/scene/importHandoff');

let releasePicker: (() => void) | null = null;

function renderPrompt(builtIn: 'synth' | 'headphones' | 'bicycle' | null = null) {
  useStore.setState({
    modelEditors: 'host',
    sessionHostId: HOST,
    isImporting: false,
  });
  useStore.getState().setRoomScene({ models: [], builtIn }, { fresh: true });
  return render(<EmptyScenePrompt />);
}

beforeEach(() => {
  sent.updates.length = 0;
  roleAnswer.role = 'owner';
  roleAnswer.rolesApply = true;
});

afterEach(() => {
  releasePicker?.();
  releasePicker = null;
  cleanup();
});

describe('EmptyScenePrompt — an empty room', () => {
  it('says there is no model yet, and offers the two ways out', () => {
    renderPrompt();

    const prompt = screen.getByTestId('empty-scene-prompt');
    expect(within(prompt).getByText('No model yet')).toBeTruthy();
    expect(within(prompt).getByRole('button', { name: 'Import a model' })).toBeTruthy();
    expect(within(prompt).getByRole('button', { name: /Try a sample/ })).toBeTruthy();
  });

  it('opens the model tree\'s own picker, rather than growing a second one', () => {
    const opened = vi.fn();
    releasePicker = claimImportPicker(opened);
    renderPrompt();

    fireEvent.click(screen.getByRole('button', { name: 'Import a model' }));

    expect(opened).toHaveBeenCalledTimes(1);
    // Nothing on the socket: choosing a file is the pipeline's business, and the
    // pipeline is the tree's.
    expect(sent.updates).toEqual([]);
  });

  it('says so when there is no picker to reach', () => {
    // No scene panel mounted — the mobile room, or one still loading. The module
    // that hands the picker over asks for a sentence rather than silence, and this
    // is it.
    renderPrompt();

    fireEvent.click(screen.getByRole('button', { name: 'Import a model' }));

    expect(screen.getByText(/no file picker to reach/i)).toBeTruthy();
  });

  it('lists the sample, and puts it in the room when chosen', () => {
    renderPrompt();

    fireEvent.click(screen.getByRole('button', { name: /Try a sample/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Synth assembly' }));

    expect(sent.updates).toEqual([{ op: 'setBuiltIn', builtIn: 'synth' }]);
    expect(useStore.getState().activeModelType).toBe('synth');
    // The room is not empty any more, so the prompt is gone for everybody in it —
    // it is derived from the scene, and the scene is the server's.
    expect(screen.queryByTestId('empty-scene-prompt')).toBeNull();
  });

  it('shows somebody who may not change the models a sentence and no buttons', () => {
    roleAnswer.role = 'participant';
    renderPrompt();

    const prompt = screen.getByTestId('empty-scene-prompt');
    expect(within(prompt).getByText('No model yet — the host will add one')).toBeTruthy();
    expect(within(prompt).queryByRole('button')).toBeNull();
  });

  it('renders nothing at all in a room that already has a model', () => {
    const { container } = renderPrompt('synth');
    expect(container.firstChild).toBeNull();
  });
});
