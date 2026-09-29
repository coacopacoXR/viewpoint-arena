// The model tree asks the same question the room server asks.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH2, bug 2. lib/scene/roomScene's
// scenePermissions is the rule and lib/scene/__tests__/scenePermissions.test.ts
// pins it for every role × setting × mode; what only a render of the tree can
// prove is that the tree ASKS it — that the owner of a review who is not the
// meeting host gets an import button rather than "Import locked", and gets the
// control that decides who else may change the models.
//
// useReviewRole is faked rather than driven through Supabase: the roster read is
// lib/reviews/__tests__'s job, and this file is about what the tree does with the
// answer. Everything else — the store, the scene, the hook that turns the role
// into a permission — is real.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import type { ModelEditors } from '../../../lib/scene/roomScene';
import type { ReviewAction, Role } from '../../../lib/reviews/roles';

const ME = 'me';
const HOST = 'somebody-else';

const roleAnswer = vi.hoisted(() => ({
  role: 'participant' as Role,
  // False is identity.mode 'none' — a deployment that resolves no roles, where the
  // meeting host is the authority. lib/scene/roomScene spells that as role: null.
  rolesApply: true,
}));

vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => ({
    localUserId: ME,
    remoteParticipantList: [],
    broadcastSceneUpdate: () => false,
    broadcastSetModelEditors: () => true,
  }),
}));

vi.mock('../../../lib/reviews/useReviewRole', () => ({
  useReviewRole: () => ({
    get role() { return roleAnswer.role; },
    get rolesApply() { return roleAnswer.rolesApply; },
    can: (action: ReviewAction) => {
      // lib/reviews/roles.ts's table, for the two actions this tree asks about.
      if (roleAnswer.role === 'owner') return true;
      if (roleAnswer.role === 'editor') return action === 'editReview' || action === 'setModelEditors';
      return action === 'meet' || action === 'addCard' || action === 'editCard';
    },
    loading: false,
    ownerId: null,
    members: [],
    refresh: () => {},
  }),
}));

const { default: SceneTree } = await import('../SceneTree');
const { useStore } = await import('../../../store');

/** The room's tree, with this person NOT the meeting host unless a test says so. */
function renderTree(editors: ModelEditors, hostId: string | null = HOST) {
  useStore.setState({
    sceneEntries: {},
    expandedSceneModels: {},
    modelEditors: editors,
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

function importButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Import/i }) as HTMLButtonElement;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  roleAnswer.role = 'participant';
  roleAnswer.rolesApply = true;
});

// Explicit, because test/setup.ts registers no global cleanup and every test here
// renders the same tree.
afterEach(cleanup);

describe('SceneTree — who may change the models', () => {
  it('lets the owner of the review import when somebody else is the meeting host', () => {
    // The bug, exactly as it was reported: the owner created the review, made a
    // colleague an editor, reloaded, and the colleague arrived first.
    roleAnswer.role = 'owner';
    renderTree('host');

    const button = importButton();
    expect(button.textContent).toMatch(/Import 3D Model/i);
    expect(button.hasAttribute('disabled')).toBe(false);
    // And the setting that decides it for everybody else, which was gated on the
    // same host rule.
    expect(screen.getByText('Who can change models')).toBeTruthy();
  });

  it('lets an editor import too, and choose who else may', () => {
    roleAnswer.role = 'editor';
    renderTree('host');

    expect(importButton().hasAttribute('disabled')).toBe(false);
    expect(screen.getByText('Who can change models')).toBeTruthy();
  });

  it('locks a participant out, and says it is the review’s owners and editors', () => {
    roleAnswer.role = 'participant';
    renderTree('host');

    const button = importButton();
    expect(button.textContent).toMatch(/Import locked/i);
    expect(button.hasAttribute('disabled')).toBe(true);
    // The role's wording, not the host's: sending this person to find a host would
    // have sent them to somebody who is not what is standing in their way.
    expect(button.getAttribute('title')).toMatch(/owner and the editors of this design review/i);
    expect(screen.queryByText('Who can change models')).toBeNull();
  });

  it('still honours the review’s own setting for somebody without a role in it', () => {
    roleAnswer.role = 'participant';
    renderTree('everyone');

    expect(importButton().hasAttribute('disabled')).toBe(false);
    // Choosing who else may is a step above changing them, so 'everyone' does not
    // hand it over.
    expect(screen.queryByText('Who can change models')).toBeNull();
  });

  it('keeps the host rule exactly on a deployment with no identities', () => {
    // rolesApply false is what the room server spells as "no roles here": the
    // meeting host is the authority, and a role that would have allowed more is
    // not consulted at all.
    roleAnswer.rolesApply = false;
    roleAnswer.role = 'owner';
    renderTree('host');

    expect(importButton().textContent).toMatch(/Import locked/i);
    expect(importButton().getAttribute('title')).toMatch(/Only the host can change the models/i);
    expect(screen.queryByText('Who can change models')).toBeNull();

    cleanup();
    renderTree('host', ME);
    expect(importButton().hasAttribute('disabled')).toBe(false);
    expect(screen.getByText('Who can change models')).toBeTruthy();
  });

  it('locks a participant out on a deployment with no identities, with the host wording', () => {
    roleAnswer.rolesApply = false;
    renderTree([HOST]);

    expect(importButton().textContent).toMatch(/Import locked/i);
    expect(importButton().getAttribute('title')).toMatch(/host has chosen who may change models/i);
  });
});
