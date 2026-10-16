// A big model's part tree is mounted a window at a time — task 05d, the Model Tree half of
// "the laser's remaining cost on big models".
//
// WHY THIS FILE EXISTS. A row is not free while it is merely mounted. Every TreeNode holds its
// own zustand subscription, and zustand runs EVERY subscriber's selector on EVERY write, because
// it cannot know a slice did not move without asking. The room writes constantly while somebody
// points at a model: `setUserInteractionPoint` on each pointer move (components/Scene/World.tsx),
// `setTime` ten times a second, and `selectNode` on each part the laser crosses. Task 05d
// profiled a 10 000-part sweep with 10 937 rows mounted and found those three writes were
// 1 788 ms of a 6 518 ms profile — 27 % of the main thread spent telling rows nothing had
// happened to them — and a sweep with NO part under the laser at all (no selection, no tree
// change) still cost 57 ms a frame against 11 ms for the same sweep over a 3 200-part model.
//
// sceneTreeRowRenders.test.tsx is the other half: it says a row re-renders only for its own
// state. That is necessary and not sufficient — a row that never re-renders still answers the
// telephone on every store write, and with ten thousand of them the telephone is the cost. This
// file bounds how many are mounted.
//
// WHAT IS ASSERTED. That the bound holds; that a tree under it renders EXACTLY what it rendered
// before, with no paging controls in it at all; that the window FOLLOWS the selection, so a part
// picked in the 3D view is mounted and scrolled into view rather than clipped away; that the two
// paging controls walk the rest; and that a collapsed group's rows leave the list, which is what
// makes the flat list the same list the recursive one painted.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import React from 'react';
import { Group, Vector3 } from 'three';
import type { SceneModelEntry } from '../../../lib/scene/sceneEntries';
import { MeshPartRegistry } from '../../../lib/scene/partRegistry';
import type { SceneModel } from '../../../lib/scene/roomScene';
import type { SceneNode } from '../../../types';
import { TREE_ROW_WINDOW } from '../SceneTree';

vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => ({
    localUserId: 'me',
    remoteParticipantList: [],
    broadcastSceneUpdate: vi.fn(() => true),
    broadcastSetModelEditors: vi.fn(() => true),
  }),
}));

// Imported after the mocks are registered, the way sceneTreeSceneModels.test.tsx does it.
const { default: SceneTree } = await import('../SceneTree');
const { useStore } = await import('../../../store');

const MODEL_ID = 'model_a';
const PREFIX = 'maaaaaaaa';
/** Node ids: the root is _0, the parts are _1.._count in order. */
const idOf = (index: number) => `${PREFIX}_${index}`;

const PARTS_OVER = TREE_ROW_WINDOW * 2 + 50;
const PARTS_UNDER = 120;
/** The one group of the nested fixture, so a test can collapse it. */
const GROUP_ID = 'group_0';

const leaves = (count: number): SceneNode[] =>
  Array.from({ length: count }, (_, index) => ({
    id: idOf(index + 1),
    name: `part_${index}`,
    type: 'MESH',
  }));

/**
 * A parsed model's entry, from a scene tree this test built.
 *
 * `partRegistry` is required and empty: the fixture parses no geometry, and the Model Tree
 * renders from the SceneNode data and never touches a part.
 */
function entryFor(sceneTree: SceneNode): SceneModelEntry {
  return {
    id: MODEL_ID,
    group: new Group(),
    sceneTree,
    partRegistry: new MeshPartRegistry(new Group()),
    fileName: 'big.step',
    line: 'big',
    revision: 'A',
    baseScale: 1,
    basePosition: new Vector3(),
    scale: 1,
    size: { x: 2, y: 2, z: 2 },
  };
}

/** `count` parts flat under the model's root, the way a big assembly's last level is. */
const flatTree = (count: number): SceneNode => ({
  id: idOf(0),
  name: 'big.step',
  type: 'GROUP',
  children: leaves(count),
});

/** The same parts under one collapsible group, which is what a real assembly looks like. */
const nestedTree = (count: number): SceneNode => ({
  id: idOf(0),
  name: 'big.step',
  type: 'GROUP',
  children: [{ id: GROUP_ID, name: 'Frame', type: 'GROUP', children: leaves(count) }],
});

/**
 * The part rows currently in the document, by name, in order.
 *
 * Read off the label spans rather than counted off a class: `h-7` is on a model row and on the
 * rows of any group in the tree too, and a count that was one out for a reason nobody wrote down
 * is a test that fails confusingly.
 */
function mountedParts(container: HTMLElement): string[] {
  return [...container.querySelectorAll('span')]
    .map((span) => span.textContent ?? '')
    .filter((text) => text.startsWith('part_'));
}

function renderModel(sceneTree: SceneNode, expanded = true) {
  const model: SceneModel = {
    id: MODEL_ID,
    hash: 'aa'.repeat(32),
    fileName: 'big.step',
    line: 'big',
    revision: 'A',
    visible: true,
    offset: [0, 0, 0],
  };
  useStore.setState({
    sceneEntries: { [MODEL_ID]: entryFor(sceneTree) },
    expandedSceneModels: expanded ? { [MODEL_ID]: true } : {},
    modelEditors: 'host',
    sessionHostId: 'me',
    activeSceneModelId: null,
    compare: null,
    sceneRefusal: null,
    isImporting: false,
    importError: null,
    importSuccess: null,
  });
  // Adopt the scene the way a SCENE_STATE would, so objectStates — including the `expanded: true`
  // every node starts with, which is what makes an opened model mount its whole tree — is real
  // rather than hand-set.
  useStore.getState().setRoomScene({ models: [model], builtIn: null }, { fresh: true });
  return render(<SceneTree />);
}

describe('the Model Tree mounts a bounded window of a big model', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  // Explicit, because vitest runs without `globals` (vitest.config.ts) and that is the flag
  // @testing-library/react registers its own cleanup under. A tree left mounted by the test above
  // stays subscribed to the same store and mounts its own rows into the counts below.
  afterEach(cleanup);

  it('mounts at most TREE_ROW_WINDOW rows, however many parts the model has', () => {
    const { container } = renderModel(flatTree(PARTS_OVER));
    const mounted = mountedParts(container);

    expect(mounted).toHaveLength(TREE_ROW_WINDOW);
    expect(mounted[0]).toBe('part_0');
    expect(mounted.at(-1)).toBe(`part_${TREE_ROW_WINDOW - 1}`);
    // And the rest is named rather than silently gone: the panel says how many are left.
    expect(screen.getByTestId('tree-rows-more').textContent).toContain(
      String(PARTS_OVER - TREE_ROW_WINDOW),
    );
    expect(screen.queryByTestId('tree-rows-earlier')).toBeNull();
  });

  it('renders a tree that fits exactly as it did before, with no paging in it', () => {
    const { container } = renderModel(flatTree(PARTS_UNDER));

    expect(mountedParts(container)).toHaveLength(PARTS_UNDER);
    expect(screen.queryByTestId('tree-rows-more')).toBeNull();
    expect(screen.queryByTestId('tree-rows-earlier')).toBeNull();
  });

  it('mounts nothing at all while the model row is collapsed', () => {
    const { container } = renderModel(flatTree(PARTS_OVER), false);
    expect(mountedParts(container)).toHaveLength(0);
  });

  it('pages forward and back through the parts', () => {
    const { container } = renderModel(flatTree(PARTS_OVER));

    fireEvent.click(screen.getByTestId('tree-rows-more'));
    let mounted = mountedParts(container);
    expect(mounted[0]).toBe(`part_${TREE_ROW_WINDOW}`);
    expect(mounted).toHaveLength(TREE_ROW_WINDOW);
    // Both controls now: the window is off the top and still short of the bottom.
    expect(screen.getByTestId('tree-rows-earlier').textContent).toContain(String(TREE_ROW_WINDOW));

    fireEvent.click(screen.getByTestId('tree-rows-earlier'));
    mounted = mountedParts(container);
    expect(mounted[0]).toBe('part_0');
    expect(screen.queryByTestId('tree-rows-earlier')).toBeNull();
  });

  it('does not offer a page past the last part', () => {
    const { container } = renderModel(flatTree(PARTS_OVER));
    // Two pages forward is past the end of a 2 × window + 50 list, so the second lands on the
    // last window rather than on an empty one.
    fireEvent.click(screen.getByTestId('tree-rows-more'));
    fireEvent.click(screen.getByTestId('tree-rows-more'));

    const mounted = mountedParts(container);
    expect(mounted.at(-1)).toBe(`part_${PARTS_OVER - 1}`);
    expect(mounted.length).toBeLessThanOrEqual(TREE_ROW_WINDOW);
    expect(screen.queryByTestId('tree-rows-more')).toBeNull();
  });

  it('moves the window to a part selected outside it, and scrolls that row into view', () => {
    const { container } = renderModel(flatTree(PARTS_OVER));
    const scrollIntoView = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>;
    const middle = 'part_600';
    const far = `part_${PARTS_OVER - 1}`;
    expect(mountedParts(container)).not.toContain(middle);

    // What a laser crossing the model, a pin, or a colleague's selection does: one store write
    // naming a part the window is not currently showing.
    act(() => useStore.getState().selectNode(idOf(601)));

    let mounted = mountedParts(container);
    expect(mounted).toContain(middle);
    expect(mounted).toHaveLength(TREE_ROW_WINDOW);
    // Centred rather than pinned to an edge, so a selection walking one row at a time through the
    // tree does not re-window on every step.
    expect(mounted.indexOf(middle)).toBe(Math.floor(TREE_ROW_WINDOW / 2));
    // The row's own effect is what scrolls it, and it can only because the row is mounted — the
    // behaviour this window must not take away.
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });

    // The last part cannot be centred: there is no window past the end of the list to centre it
    // in. Clamped, so the row is mounted last rather than the window running off into nothing.
    act(() => useStore.getState().selectNode(idOf(PARTS_OVER)));
    mounted = mountedParts(container);
    expect(mounted).toContain(far);
    expect(mounted).toHaveLength(TREE_ROW_WINDOW);
    expect(mounted.indexOf(far)).toBe(TREE_ROW_WINDOW - 1);
    expect(mounted.at(-1)).toBe(far);
    expect(screen.queryByTestId('tree-rows-more')).toBeNull();
    expect(screen.getByTestId('tree-rows-earlier')).not.toBeNull();
  });

  it('leaves the window alone for a selection already inside it', () => {
    const { container } = renderModel(flatTree(PARTS_OVER));
    act(() => useStore.getState().selectNode(idOf(6)));
    const withSelection = mountedParts(container);

    expect(withSelection[0]).toBe('part_0');
    expect(withSelection).toHaveLength(TREE_ROW_WINDOW);

    // And a write that moves nothing a row reads mounts and unmounts nothing either.
    act(() => useStore.getState().setTime(12.5));
    expect(mountedParts(container)).toEqual(withSelection);
  });

  it('takes a collapsed group out of the list, which is what makes it the same list', () => {
    const { container } = renderModel(nestedTree(PARTS_OVER));
    // The group's own row takes a slot in the window, so one fewer part is mounted.
    expect(mountedParts(container)).toHaveLength(TREE_ROW_WINDOW - 1);

    act(() => useStore.getState().toggleNodeExpanded(GROUP_ID));
    expect(mountedParts(container)).toHaveLength(0);

    act(() => useStore.getState().toggleNodeExpanded(GROUP_ID));
    expect(mountedParts(container)).toHaveLength(TREE_ROW_WINDOW - 1);
  });

  it('still hides a part in the tree when only its own row changed', () => {
    const { container } = renderModel(flatTree(PARTS_OVER));
    const labelOf = (name: string) =>
      [...container.querySelectorAll('span')].find((span) => span.textContent === name);

    expect(labelOf('part_3')?.className).not.toContain('line-through');
    act(() => useStore.getState().toggleNodeVisibility(idOf(4)));
    expect(labelOf('part_3')?.className).toContain('line-through');
  });
});
