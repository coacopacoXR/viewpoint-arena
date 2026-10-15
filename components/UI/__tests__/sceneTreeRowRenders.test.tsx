// One selection re-renders O(1) rows of the Model Tree — task 05c, the panel half of
// "pointing at a big model costs O(changed), not O(parts)".
//
// The store's half is __tests__/selectNodeTouchesOnlyWhatMoved.test.ts: `selectNode` no
// longer rebuilds every entry of `objectStates`. This is the half that makes it matter, and
// the two are needed together. A row subscribes to its OWN entry, so an identity-preserving
// selection already leaves 999 of 1000 rows with nothing to re-render for — but SceneTree
// itself subscribes to the whole map, and a parent that re-renders re-renders its children
// unless they refuse. `React.memo` on TreeNode and SceneModelRow is the refusal, and this
// file is what stops it being taken back out again.
//
// It also matters for reasons that have nothing to do with the laser. components/Scene/
// World.tsx writes the clock to the store ten times a second, and a scene relayed from the
// room is a new `objectStates` map even when every entry in it is the same object. Profiling
// a 3 200-part model with its tree open (task 05c step 2) found 68% of the main thread in
// React with the laser DOWN and the pointer parked, re-rendering rows nothing had changed.
//
// WHAT IS COUNTED. `node.name` is read exactly once per render of a row — TreeNode renders
// it into the label, and nothing else in the panel reads a node's name (`findAncestorIds`
// walks ids, `countParts` walks types). So a getter on it is a render counter with no spy
// on React's internals and no profiler to interpret.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { useStore } from '../../../store';
import type { ObjectState, SceneNode } from '../../../types';
import SceneTree from '../SceneTree';

vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => ({
    broadcastSceneUpdate: vi.fn(() => true),
    broadcastSetModelEditors: vi.fn(() => true),
    localUserId: 'test-user',
    remoteParticipantList: [],
  }),
}));

const LEAVES = 200;

/** How many times each node's row has rendered, by node id. */
const renders = new Map<string, number>();

function counted(id: string, children: SceneNode[] = []): SceneNode {
  return {
    id,
    type: children.length > 0 ? 'GROUP' : 'MESH',
    children,
    get name() {
      renders.set(id, (renders.get(id) ?? 0) + 1);
      return id;
    },
  };
}

const state = (id: string): ObjectState => ({ id, visible: true, selected: false, expanded: true });

/** A root with `LEAVES` parts under it, flat the way a big assembly's last level is. */
function fixture() {
  const children = Array.from({ length: LEAVES }, (_, index) => counted(`part_${index}`));
  const tree = counted('root', children);
  const objectStates: Record<string, ObjectState> = { root: state('root') };
  for (const child of children) objectStates[child.id] = state(child.id);
  return { tree, objectStates };
}

/** Which rows rendered since the counter was last cleared, sorted for a stable message. */
const rendered = () => [...renders.keys()].sort();

describe('SceneTree rows re-render for their own state and nothing else', () => {
  let scrollIntoView: ReturnType<typeof vi.fn>;

  // Explicit, because vitest runs without `globals` (vitest.config.ts) and that is the flag
  // @testing-library/react registers its own cleanup under. A tree left mounted by the test
  // above stays subscribed to the same store, so it renders its own rows and answers for
  // them in the counts below — and scrolls its own selected row into view.
  afterEach(cleanup);

  beforeEach(() => {
    // jsdom has no scrollIntoView, and TreeNode calls it when a row becomes selected.
    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView =
      scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
    renders.clear();
    const { tree, objectStates } = fixture();
    useStore.setState({
      activeModelType: 'headphones',
      headphonesSceneTree: tree,
      bicycleSceneTree: null,
      importedSceneTree: null,
      objectStates,
      scene: { models: [], builtIn: null },
      sceneEntries: {},
      expandedSceneModels: {},
    });
  });

  it('mounts one row per part', () => {
    render(<SceneTree />);
    expect(renders.size).toBe(LEAVES + 1);
  });

  it('re-renders one row to select a part, and two to move the selection', () => {
    render(<SceneTree />);

    renders.clear();
    act(() => useStore.getState().selectNode('part_7'));
    expect(rendered()).toEqual(['part_7']);

    renders.clear();
    act(() => useStore.getState().selectNode('part_199'));
    // The row the selection left and the row it arrived on. Not the other 199, which is
    // what turns a laser sweep over a 10 000-part assembly from 10 000 row renders a frame
    // into two.
    expect(rendered()).toEqual(['part_199', 'part_7']);

    renders.clear();
    act(() => useStore.getState().selectNode(null));
    expect(rendered()).toEqual(['part_199']);
  });

  it('re-renders no row at all for a store write that moves nothing a row reads', () => {
    render(<SceneTree />);
    act(() => useStore.getState().selectNode('part_3'));

    renders.clear();
    // The clock, ten times a second, from components/Scene/World.tsx.
    act(() => useStore.getState().setTime(12.5));
    expect(rendered()).toEqual([]);

    // A scene relayed from the room is a new objectStates MAP holding the same entries, so
    // the panel re-renders and every row has to refuse to.
    const same = { ...useStore.getState().objectStates };
    renders.clear();
    act(() => useStore.setState({ objectStates: same }));
    expect(rendered()).toEqual([]);
  });

  it('still scrolls the newly selected row into view', () => {
    render(<SceneTree />);
    expect(scrollIntoView).not.toHaveBeenCalled();

    act(() => useStore.getState().selectNode('part_42'));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });

    // Once per row that BECOMES selected, not on every render of a row that already is:
    // a laser parked on one part must not keep tugging the panel.
    scrollIntoView.mockClear();
    act(() => useStore.getState().setTime(13));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('still shows a hidden part as hidden when only its own row changed', () => {
    const { container } = render(<SceneTree />);
    const labelOf = (id: string) =>
      [...container.querySelectorAll('span')].find((span) => span.textContent === id);

    expect(labelOf('part_5')?.className).not.toContain('line-through');
    act(() => useStore.getState().toggleNodeVisibility('part_5'));
    expect(labelOf('part_5')?.className).toContain('line-through');
  });
});
