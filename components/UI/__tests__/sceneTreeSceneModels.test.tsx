// The model tree with several models in the scene.
//
// docs/plan/14-rooms-models-admin-ai.md batch BB. Three things here are easy to
// get wrong in a way that only shows up in a meeting:
//
//   * two models whose parts have the same names have to keep separate node ids,
//     or hiding a flange on one hides a flange on the other;
//   * the eye on a model row means "hide it for the room" or "hide it for me"
//     depending on whether this person is allowed to change the scene, and the
//     second one must not touch the socket at all;
//   * the import button has to say why it is locked, because a button that does
//     nothing reads as a broken app rather than a rule.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { Group, Vector3 } from 'three';
import type { SceneModelEntry } from '../../../lib/scene/sceneEntries';
import type { ModelEditors, SceneModel, SceneUpdate } from '../../../lib/scene/roomScene';

const { broadcastSceneUpdate, broadcastSetModelEditors } = vi.hoisted(() => ({
  broadcastSceneUpdate: vi.fn((_update: SceneUpdate) => true),
  broadcastSetModelEditors: vi.fn((_editors: ModelEditors) => true),
}));

vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => ({
    localUserId: 'me',
    remoteParticipantList: [],
    broadcastSceneUpdate,
    broadcastSetModelEditors,
  }),
}));

// Imported after the mocks are registered.
const { default: SceneTree } = await import('../SceneTree');
const { useStore } = await import('../../../store');

const HASH_A = 'aa'.repeat(32);
const HASH_B = 'bb'.repeat(32);
// The prefixes lib/scene/roomScene derives from those hashes. Written out rather
// than computed so a change to the prefix scheme shows up here as a failing
// assertion about node ids rather than as two tests quietly agreeing with each
// other.
const PREFIX_A = 'maaaaaaaa';
const PREFIX_B = 'mbbbbbbbb';

function sceneModel(id: string, hash: string, overrides: Partial<SceneModel> = {}): SceneModel {
  return {
    id,
    hash,
    fileName: `${id}.step`,
    line: id,
    revision: 'A',
    visible: true,
    offset: [0, 0, 0],
    ...overrides,
  };
}

/** A parsed model: a root group and one part under it, both ids prefixed. */
function entryFor(model: SceneModel, prefix: string, partName: string): SceneModelEntry {
  return {
    id: model.id,
    group: new Group(),
    sceneTree: {
      id: `${prefix}_0`,
      name: model.fileName,
      type: 'GROUP',
      children: [{ id: `${prefix}_1`, name: partName, type: 'MESH' }],
    },
    fileName: model.fileName,
    line: model.line,
    revision: model.revision,
    baseScale: 1,
    basePosition: new Vector3(),
    scale: 1,
    size: { x: 2, y: 2, z: 2 },
  };
}

interface Fixture {
  models: SceneModel[];
  /** Node ids and part names per model, so a test can name both models' parts "Flange". */
  parts?: Record<string, { prefix: string; name: string }>;
  editors?: ModelEditors;
  hostId?: string | null;
  expanded?: boolean;
}

function renderTree(fixture: Fixture) {
  const parts = fixture.parts ?? {};
  const sceneEntries: Record<string, SceneModelEntry> = {};
  const expandedSceneModels: Record<string, boolean> = {};
  for (const model of fixture.models) {
    const part = parts[model.id] ?? { prefix: model.id.slice(0, 8), name: 'Part' };
    sceneEntries[model.id] = entryFor(model, part.prefix, part.name);
    if (fixture.expanded !== false) expandedSceneModels[model.id] = true;
  }

  useStore.setState({
    sceneEntries,
    expandedSceneModels,
    modelEditors: fixture.editors ?? 'host',
    sessionHostId: fixture.hostId === undefined ? 'me' : fixture.hostId,
    activeSceneModelId: null,
    compare: null,
    sceneRefusal: null,
    isImporting: false,
    importError: null,
    importSuccess: null,
  });
  // Adopt the scene the way a SCENE_STATE would, so the combined tree, the node
  // states and the derived activeModelType are all real rather than hand-set.
  useStore.getState().setRoomScene({ models: fixture.models, builtIn: null }, { fresh: true });

  return render(<SceneTree />);
}

/** The eye at the end of a tree row — the last control in it, by design. */
function eyeOf(row: HTMLElement): HTMLElement {
  const eye = row.lastElementChild;
  expect(eye).toBeTruthy();
  return eye as HTMLElement;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  broadcastSceneUpdate.mockClear();
  broadcastSetModelEditors.mockClear();
});

// Explicit, because test/setup.ts registers no global cleanup (vitest runs
// without `globals`, so React Testing Library cannot hook afterEach itself) and
// every test here renders the same tree: without this the second test's
// getAllByText finds the first test's rows too.
afterEach(cleanup);

describe('SceneTree — several models in one scene', () => {
  const bracket = sceneModel('bracket', HASH_A, { line: 'bracket', revision: 'A' });
  const gasket = sceneModel('gasket', HASH_B, { line: 'gasket', revision: 'A' });

  it('shows one top-level group per model, named for its line and revision', () => {
    renderTree({ models: [bracket, gasket] });

    expect(screen.getByText('bracket · Rev A')).toBeTruthy();
    expect(screen.getByText('gasket · Rev A')).toBeTruthy();
    // And the two rows are the models, not a wrapper around them.
    expect(screen.getByTestId(`scene-model-row-${bracket.id}`)).toBeTruthy();
    expect(screen.getByTestId(`scene-model-row-${gasket.id}`)).toBeTruthy();
  });

  it('keeps two models’ same-named parts apart, so hiding one leaves the other', () => {
    // The realistic collision: a bracket and its mating part both have a flange,
    // and both files number their nodes from zero.
    renderTree({
      models: [bracket, gasket],
      parts: {
        [bracket.id]: { prefix: PREFIX_A, name: 'Flange' },
        [gasket.id]: { prefix: PREFIX_B, name: 'Flange' },
      },
    });

    const flanges = screen.getAllByText('Flange');
    expect(flanges).toHaveLength(2);

    // Hiding the first model's flange. Both rows say "Flange"; only one of them
    // may go dark.
    fireEvent.click(eyeOf(flanges[0].parentElement as HTMLElement));

    const states = useStore.getState().objectStates;
    expect(states[`${PREFIX_A}_1`].visible).toBe(false);
    expect(states[`${PREFIX_B}_1`].visible).toBe(true);
    // Both models' roots have their own state too, which is what the laser and
    // the pin lookup read when they walk up from a mesh.
    expect(states[`${PREFIX_A}_0`]).toBeTruthy();
    expect(states[`${PREFIX_B}_0`]).toBeTruthy();
  });

  it('sends setVisible to the room when this person may change the models', () => {
    renderTree({ models: [bracket], hostId: 'me' });

    fireEvent.click(eyeOf(screen.getByTestId(`scene-model-row-${bracket.id}`)));

    expect(broadcastSceneUpdate).toHaveBeenCalledWith({
      op: 'setVisible',
      id: bracket.id,
      visible: false,
    });
    // Shared visibility changed, and no local override was left behind to
    // contradict the room the next time it is read.
    expect(useStore.getState().scene.models[0].visible).toBe(false);
    expect(useStore.getState().localModelVisibility[bracket.id]).toBeUndefined();
  });

  it('hides a model on your own screen only when you may not change the room’s', () => {
    renderTree({ models: [bracket], editors: 'host', hostId: 'somebody-else' });

    fireEvent.click(eyeOf(screen.getByTestId(`scene-model-row-${bracket.id}`)));

    // Nothing goes down the socket: hiding a model so you can see the one behind
    // it is not a change to what the review is about, and somebody who is not
    // allowed to change the scene must still be able to do it.
    expect(broadcastSceneUpdate).not.toHaveBeenCalled();
    expect(useStore.getState().localModelVisibility[bracket.id]).toBe(false);
    // The room's copy is untouched, so nobody else's screen changes.
    expect(useStore.getState().scene.models[0].visible).toBe(true);
  });

  it('disables the import button for somebody who may not change models, and says why', () => {
    renderTree({ models: [], editors: 'host', hostId: 'somebody-else' });

    const button = screen.getByRole('button', { name: /Import locked/i });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('title')).toMatch(/Only the host can change the models/);
  });

  it('lets the host import, and shows them who else may', () => {
    renderTree({ models: [bracket], hostId: 'me' });

    const button = screen.getByRole('button', { name: /Import 3D Model/i });
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(screen.getByText('Who can change models')).toBeTruthy();
  });

  it('does not offer the permission control to anybody who is not the host', () => {
    renderTree({ models: [bracket], hostId: 'somebody-else' });

    expect(screen.queryByText('Who can change models')).toBeNull();
  });

  it('lets everybody import once the host has said everyone', () => {
    renderTree({ models: [bracket], editors: 'everyone', hostId: 'somebody-else' });

    expect(screen.getByRole('button', { name: /Import 3D Model/i }).hasAttribute('disabled')).toBe(false);
    // The eye is now a shared change again, because this person may make one.
    fireEvent.click(eyeOf(screen.getByTestId(`scene-model-row-${bracket.id}`)));
    expect(broadcastSceneUpdate).toHaveBeenCalledWith({
      op: 'setVisible',
      id: bracket.id,
      visible: false,
    });
  });
});

describe('SceneTree — comparing revisions', () => {
  const revA = sceneModel('bracket-a', HASH_A, { line: 'bracket', revision: 'A' });
  const revB = sceneModel('bracket-b', HASH_B, { line: 'bracket', revision: 'B' });
  const other = sceneModel('gasket', 'cc'.repeat(32), { line: 'gasket', revision: 'A' });

  it('offers Compare on a line that has two revisions, and not on one that has not', () => {
    renderTree({ models: [revA, revB, other] });

    expect(screen.getAllByTitle(/Compare revisions of bracket/)).toHaveLength(2);
    expect(screen.queryByTitle(/Compare revisions of gasket/)).toBeNull();
  });

  it('puts the two revisions side by side for the whole room, and remembers what to put back', () => {
    renderTree({
      models: [revA, revB],
      parts: {
        [revA.id]: { prefix: PREFIX_A, name: 'Flange' },
        [revB.id]: { prefix: PREFIX_B, name: 'Flange' },
      },
    });
    // Rev B was the one on screen; Rev A is dark until the comparison asks for it.
    useStore.getState().applyLocalSceneUpdate({ op: 'setVisible', id: revA.id, visible: false });
    broadcastSceneUpdate.mockClear();

    fireEvent.click(screen.getAllByTitle(/Compare revisions of bracket/)[0]);
    fireEvent.click(screen.getByText('Show side by side'));

    const sent = broadcastSceneUpdate.mock.calls.map((call) => call[0]);
    // Both revisions end up visible, and the newer one moves out beside the
    // older — the older keeps its offset, because the room's pins are on it.
    expect(sent).toContainEqual({ op: 'setVisible', id: revA.id, visible: true });
    expect(sent).toContainEqual({ op: 'setVisible', id: revB.id, visible: true });
    expect(sent.filter((u) => u.op === 'setOffset' && u.id === revA.id)).toHaveLength(1);
    expect(sent.find((u) => u.op === 'setOffset' && u.id === revA.id && u.offset[0] === revA.offset[0])).toBeTruthy();
    const moved = sent.find(
      (u): u is Extract<SceneUpdate, { op: 'setOffset' }> => u.op === 'setOffset' && u.id === revB.id,
    );
    expect(moved?.offset[0]).toBeGreaterThan(revB.offset[0]);

    const compare = useStore.getState().compare;
    expect(compare?.line).toBe('bracket');
    expect(compare?.restore).toEqual([
      { id: revA.id, visible: false, offset: [0, 0, 0] },
      { id: revB.id, visible: true, offset: [0, 0, 0] },
    ]);
  });

  it('puts the room back the way it was when the comparison ends', () => {
    renderTree({ models: [revA, revB] });
    fireEvent.click(screen.getAllByTitle(/Compare revisions of bracket/)[0]);
    fireEvent.click(screen.getByText('Show side by side'));
    expect(useStore.getState().scene.models.some((m) => m.offset[0] !== 0)).toBe(true);
    broadcastSceneUpdate.mockClear();

    // The picker stays open and now offers the way out; the comparison itself is
    // what changed the scene, so leaving it has to change the scene back.
    fireEvent.click(screen.getByText('Leave comparison'));

    expect(useStore.getState().compare).toBeNull();
    const scene = useStore.getState().scene;
    expect(scene.models.find((m) => m.id === revA.id)?.offset).toEqual([0, 0, 0]);
    expect(scene.models.find((m) => m.id === revB.id)?.offset).toEqual([0, 0, 0]);
    // And the room was told, not just this screen.
    expect(broadcastSceneUpdate.mock.calls.map((call) => call[0])).toContainEqual({
      op: 'setOffset',
      id: revB.id,
      offset: [0, 0, 0],
    });
  });
});
