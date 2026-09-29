import { describe, expect, it } from 'vitest';
import { flattenSceneTree, DEFAULT_MAX_COMPONENTS } from '../componentIndex';
import type { SceneNode } from '../../types';

const HEADPHONES: SceneNode = {
  id: 'headphones_assembly',
  name: 'Headphones',
  type: 'GROUP',
  children: [
    {
      id: 'left_cup',
      name: 'Left Ear Cup',
      type: 'GROUP',
      children: [
        { id: 'left_driver', name: 'Left Driver Unit', type: 'PART' },
        { id: 'left_cushion', name: 'Left Ear Cushion', type: 'MESH' },
      ],
    },
    {
      id: 'right_cup',
      name: 'Right Ear Cup',
      type: 'GROUP',
      children: [
        { id: 'right_driver', name: 'Right Driver Unit', type: 'PART' },
        { id: 'right_cushion', name: 'Right Ear Cushion', type: 'MESH' },
      ],
    },
    {
      id: 'headband',
      name: 'Headband',
      type: 'GROUP',
      children: [
        { id: 'headband_pad', name: 'Headband Padding', type: 'MESH' },
        { id: 'headband_frame', name: 'Headband Frame', type: 'MESH' },
      ],
    },
  ],
};

describe('flattenSceneTree', () => {
  it('builds slash-separated paths from root to leaf', () => {
    const { components } = flattenSceneTree(HEADPHONES);
    const byId = Object.fromEntries(components.map((c) => [c.id, c]));
    expect(byId['headphones_assembly'].path).toBe('Headphones');
    expect(byId['left_cup'].path).toBe('Headphones / Left Ear Cup');
    expect(byId['left_cushion'].path).toBe(
      'Headphones / Left Ear Cup / Left Ear Cushion',
    );
  });

  it('emits every node when the tree fits within the cap', () => {
    const { components, truncated } = flattenSceneTree(HEADPHONES);
    // Root + 3 groups + 6 leaves = 10
    expect(components).toHaveLength(10);
    expect(truncated).toBe(false);
  });

  it('visits GROUPs before leaves at each depth (breadth-first, groups first)', () => {
    const { components } = flattenSceneTree(HEADPHONES);
    const ids = components.map((c) => c.id);
    // Root first, then the three sub-assembly GROUPs, then the six leaves.
    expect(ids[0]).toBe('headphones_assembly');
    const groupIds = ['left_cup', 'right_cup', 'headband'];
    const leafIds = [
      'left_driver',
      'left_cushion',
      'right_driver',
      'right_cushion',
      'headband_pad',
      'headband_frame',
    ];
    for (const gid of groupIds) {
      for (const lid of leafIds) {
        expect(ids.indexOf(gid)).toBeLessThan(ids.indexOf(lid));
      }
    }
  });

  it('keeps GROUPs when truncating, drops leaves first', () => {
    // Cap at 5: root + 3 groups + 1 leaf. All groups survive, 5 of 6 leaves drop.
    const { components, truncated } = flattenSceneTree(HEADPHONES, 5);
    expect(truncated).toBe(true);
    expect(components).toHaveLength(5);
    const ids = components.map((c) => c.id);
    expect(ids).toContain('headphones_assembly');
    expect(ids).toContain('left_cup');
    expect(ids).toContain('right_cup');
    expect(ids).toContain('headband');
  });

  it('reports truncated=false when the tree fits exactly', () => {
    const { truncated } = flattenSceneTree(HEADPHONES, 10);
    expect(truncated).toBe(false);
  });

  it('reports truncated=true when the tree exceeds the cap by one', () => {
    const { components, truncated } = flattenSceneTree(HEADPHONES, 9);
    expect(truncated).toBe(true);
    expect(components).toHaveLength(9);
  });

  it('handles a single-node tree', () => {
    const leaf: SceneNode = { id: 'solo', name: 'Solo Part', type: 'MESH' };
    const { components, truncated } = flattenSceneTree(leaf);
    expect(components).toEqual([{ id: 'solo', name: 'Solo Part', path: 'Solo Part' }]);
    expect(truncated).toBe(false);
  });

  it('handles a tree with no children on the root', () => {
    const root: SceneNode = { id: 'root', name: 'Root', type: 'GROUP' };
    const { components, truncated } = flattenSceneTree(root);
    expect(components).toEqual([{ id: 'root', name: 'Root', path: 'Root' }]);
    expect(truncated).toBe(false);
  });

  it('defaults to DEFAULT_MAX_COMPONENTS (200)', () => {
    expect(DEFAULT_MAX_COMPONENTS).toBe(200);
  });
});
