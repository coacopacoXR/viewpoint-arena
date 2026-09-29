// The model tree in a room with nothing in it — batch BI's first section.
//
// A room used to open on a pair of headphones whether the meeting was about them or
// not, so the tree always had a product to list and a file name to show. It now has
// to say "there is nothing here" without inventing one, and to offer the sample
// models that ship with the app as what they have become: samples, chosen through
// the same scene operation and the same permission as an import.
//
// Same harness as sceneTreeModelPermissions.test.tsx, for the same reason: the role
// read is lib/reviews/__tests__'s job and this file is about what the tree does
// with the answer.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { Role } from '../../../lib/reviews/roles';
import type { SceneUpdate } from '../../../lib/scene/roomScene';

const ME = 'me';
const HOST = 'somebody-else';

const sent = vi.hoisted(() => ({ updates: [] as SceneUpdate[] }));

const roleAnswer = vi.hoisted(() => ({
  role: 'owner' as Role,
  rolesApply: true,
}));

vi.mock('../../../lib/PresenceContext', () => ({
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

vi.mock('../../../lib/reviews/useReviewRole', () => ({
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

const { default: SceneTree } = await import('../SceneTree');
const { useStore } = await import('../../../store');

function renderTree(hostId: string | null = HOST) {
  useStore.setState({
    sceneEntries: {},
    expandedSceneModels: {},
    modelEditors: 'host',
    sessionHostId: hostId,
    activeSceneModelId: null,
    compare: null,
    sceneRefusal: null,
    isImporting: false,
    importError: null,
    importSuccess: null,
  });
  useStore.getState().setRoomScene({ models: [], builtIn: null }, { fresh: true });
  return render(<SceneTree />);
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  sent.updates.length = 0;
  roleAnswer.role = 'owner';
  roleAnswer.rolesApply = true;
});

// Explicit, because test/setup.ts registers no global cleanup and every test here
// renders the same tree.
afterEach(cleanup);

describe('SceneTree — an empty room', () => {
  it('says there is no model, and names no product and no file', () => {
    renderTree();

    expect(screen.getByText('No model yet')).toBeTruthy();
    // The two lies an empty room used to be capable of telling: a part list for a
    // synthesiser nobody loaded, and the file name of a pair of headphones.
    expect(screen.queryByText('headphones.glb')).toBeNull();
    expect(screen.queryByText('synth_assembly.step')).toBeNull();
    expect(screen.queryByText('Headphones')).toBeNull();
  });

  it('offers the sample in the import area', () => {
    renderTree();

    expect(screen.getByText(/or try a sample/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Synth assembly' })).toBeTruthy();
  });

  it('chooses a sample through the same setBuiltIn an import would use', () => {
    renderTree();

    fireEvent.click(screen.getByRole('button', { name: 'Synth assembly' }));

    // One operation, sent to the room server first and applied locally second —
    // the order the import pipeline uses, so the server stays the truth and the
    // model still appears the moment the button is pressed.
    expect(sent.updates).toEqual([{ op: 'setBuiltIn', builtIn: 'synth' }]);
    expect(useStore.getState().activeModelType).toBe('synth');
    // And the room is no longer empty: the tree lists the sample's parts and names
    // its file, which is a true sentence now.
    expect(screen.queryByText('No model yet')).toBeNull();
    expect(screen.getByText('synth_assembly.step')).toBeTruthy();
  });

  it('marks the sample that is already in the room', () => {
    useStore.setState({ sessionHostId: HOST, modelEditors: 'host', sceneEntries: {} });
    useStore.getState().setRoomScene({ models: [], builtIn: 'synth' }, { fresh: true });
    render(<SceneTree />);

    expect(screen.queryByText('No model yet')).toBeNull();
    expect(screen.getByRole('button', { name: 'Synth assembly' }).className).toMatch(/bg-blue-500/);
  });

  it('locks the samples out with the same rule as the import button', () => {
    // The permission is one rule the browser and the room server both ask, so a
    // sample has to be refused for exactly the reason an import is — and say so
    // before the click rather than after the server refuses it.
    roleAnswer.role = 'participant';
    renderTree();

    const button = screen.getByRole('button', { name: 'Synth assembly' }) as HTMLButtonElement;
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('title')).toMatch(/owner and the editors of this design review/i);

    fireEvent.click(button);
    expect(sent.updates).toEqual([]);
    expect(useStore.getState().activeModelType).toBe('none');
  });

  it('stops offering samples once the scene holds a model of its own', () => {
    // activeModelTypeFor reads 'imported' whenever the list is non-empty, so a
    // sample chosen underneath an import would be recorded and stay invisible.
    useStore.setState({
      sceneEntries: {},
      expandedSceneModels: {},
      modelEditors: 'host',
      sessionHostId: HOST,
      activeSceneModelId: null,
      compare: null,
      sceneRefusal: null,
      isImporting: false,
      importError: null,
      importSuccess: null,
    });
    useStore.getState().setRoomScene({
      models: [{
        id: 'model-1',
        hash: 'a1'.repeat(32),
        fileName: 'bracket.step',
        line: 'bracket',
        revision: 'A',
        visible: true,
        offset: [0, 0, 0],
      }],
      builtIn: null,
    }, { fresh: true });
    render(<SceneTree />);

    expect(screen.queryByText(/or try a sample/i)).toBeNull();
    expect(screen.queryByText('No model yet')).toBeNull();
    expect(useStore.getState().activeModelType).toBe('imported');
  });
});
