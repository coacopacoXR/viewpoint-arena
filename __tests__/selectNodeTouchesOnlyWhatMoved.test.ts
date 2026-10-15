// Moving the selection — task 05c, the store half of "pointing at a big model costs
// O(changed), not O(parts)".
//
// `selectNode` used to rebuild EVERY entry of `objectStates` in order to clear the old
// selection. Object identity is what every consumer of that map compares, so one part
// coming under the laser told every one of them that every part had changed:
//
//   • a Model Tree row subscribes to `objectStates[node.id]`, so all of them re-rendered;
//   • `PartGraph.sync` (lib/scene/partRegistry.ts) diffs the two booleans precisely
//     BECAUSE it could not trust identity — its comment names this action.
//
// Measured with the laser scenario in e2e/perf/orbit.perf.spec.ts: 263 ms a frame at
// 3 200 parts and 771 ms at 10 000, scaling with part count rather than triangles. After
// this change the same runs are 39.4 ms and 114.9 ms.
//
// The companion assertion — that a tree panel re-renders O(1) ROWS for one selection — is
// components/UI/__tests__/sceneTreeRowRenders.test.tsx. This file is the store's half:
// nothing downstream can be cheaper than the identities it is handed.

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../store';
import type { ObjectState } from '../types';

const ROWS = 1000;

const entry = (id: string, over: Partial<ObjectState> = {}): ObjectState => ({
  id,
  visible: true,
  selected: false,
  expanded: true,
  ...over,
});

/** `ROWS` sibling parts under one root, the way initObjectStates writes a flat assembly. */
function manyStates(): Record<string, ObjectState> {
  const states: Record<string, ObjectState> = { root: entry('root') };
  for (let i = 0; i < ROWS; i += 1) states[`part_${i}`] = entry(`part_${i}`);
  return states;
}

/** Which keys hold a DIFFERENT object than they did in `before`. */
function moved(before: Record<string, ObjectState>, after: Record<string, ObjectState>): string[] {
  return Object.keys(after).filter((id) => before[id] !== after[id]);
}

describe('selectNode touches only the entries that move', () => {
  beforeEach(() => {
    useStore.setState({ objectStates: manyStates() });
  });

  it('changes the identity of at most the old and the new selected entry', () => {
    const first = useStore.getState().objectStates;
    useStore.getState().selectNode('part_7');
    const selected = useStore.getState().objectStates;
    expect(moved(first, selected)).toEqual(['part_7']);
    expect(selected['part_7'].selected).toBe(true);

    useStore.getState().selectNode('part_999');
    const movedOn = useStore.getState().objectStates;
    // Two, and named: the part the selection left and the one it arrived on. The other
    // 999 entries are the same objects they were, which is the only thing that lets a
    // subscriber to one of them stay still.
    expect(moved(selected, movedOn).sort()).toEqual(['part_7', 'part_999']);
    expect(movedOn['part_7'].selected).toBe(false);
    expect(movedOn['part_999'].selected).toBe(true);
    expect(moved(first, movedOn).sort()).toEqual(['part_7', 'part_999']);
  });

  it('keeps every other field of the two entries it does rewrite', () => {
    useStore.setState({
      objectStates: { ...useStore.getState().objectStates, part_3: entry('part_3', { visible: false, expanded: false }) },
    });
    useStore.getState().selectNode('part_3');
    const after = useStore.getState().objectStates['part_3'];
    expect(after).toEqual({ id: 'part_3', visible: false, selected: true, expanded: false });
  });

  it('hands the same state back when there is nothing to move', () => {
    const before = useStore.getState();
    // Letting go of the laser over the floor does this, and it used to rebuild all 1000
    // entries to clear a selection nobody had made.
    useStore.getState().selectNode(null);
    expect(useStore.getState().objectStates).toBe(before.objectStates);

    useStore.getState().selectNode('part_4');
    const selected = useStore.getState();
    useStore.getState().selectNode('part_4');
    expect(useStore.getState().objectStates).toBe(selected.objectStates);

    useStore.getState().selectNode(null);
    expect(useStore.getState().objectStates['part_4'].selected).toBe(false);
    const cleared = useStore.getState().objectStates;
    useStore.getState().selectNode(null);
    expect(useStore.getState().objectStates).toBe(cleared);
  });

  it('selects nothing for an id the tree does not have, and still clears what was selected', () => {
    useStore.getState().selectNode('part_5');
    const before = useStore.getState().objectStates;
    useStore.getState().selectNode('not_a_part');
    const after = useStore.getState().objectStates;
    expect(moved(before, after)).toEqual(['part_5']);
    expect(after['part_5'].selected).toBe(false);
    expect(after['not_a_part']).toBeUndefined();
  });

  it('clears every entry that says selected, not just the first one it finds', () => {
    // The old implementation cleared all of them by rebuilding all of them. Two entries
    // claiming the selection is a state no action in the app writes, but a scene relayed
    // from the room or set by a test can hold one, and `selectedNodeId` answering the first
    // while a second stayed lit would leave a part glowing that nothing says is selected.
    useStore.setState({
      objectStates: {
        ...useStore.getState().objectStates,
        part_1: entry('part_1', { selected: true }),
        part_2: entry('part_2', { selected: true }),
      },
    });
    const before = useStore.getState().objectStates;
    useStore.getState().selectNode('part_3');
    const after = useStore.getState().objectStates;
    expect(moved(before, after).sort()).toEqual(['part_1', 'part_2', 'part_3']);
    expect(after['part_1'].selected).toBe(false);
    expect(after['part_2'].selected).toBe(false);
    expect(after['part_3'].selected).toBe(true);
  });
});
