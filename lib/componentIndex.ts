// Flatten a SceneNode tree into a list the extraction prompt can hand to the
// model. The model sees one line per component — `id · path` — where the path
// is the human-readable breadcrumb ("Headphones / Left Ear Cup /
// Left Ear Cushion"). The id is what the model must echo back in
// `componentReference` when it attributes an insight to a part.
//
// Breadth-first: the root and its immediate sub-assemblies come first, so a
// truncated list (max 200 by default) still covers the structure of the model
// rather than descending into one branch and hiding the rest. At each depth,
// GROUPs are visited before leaf MESH/PART nodes, so the model sees the
// assembly names before the fasteners on them — and when the list is
// truncated, the skeleton is what survives.
//
// Browser-safe: no env, no I/O, no store access. Takes a SceneNode, returns a
// plain array.

import type { SceneNode } from '../types';

export interface FlatComponent {
  id: string;
  name: string;
  /** "Root / Child / Grandchild" — slash-separated ancestor names. */
  path: string;
}

export interface FlattenResult {
  components: FlatComponent[];
  /** True when the tree had more nodes than the cap allowed through. */
  truncated: boolean;
}

export const DEFAULT_MAX_COMPONENTS = 200;

export function flattenSceneTree(
  root: SceneNode,
  max: number = DEFAULT_MAX_COMPONENTS,
): FlattenResult {
  const components: FlatComponent[] = [];
  let truncated = false;

  // BFS with GROUPs-before-leaves at each depth. Two queues: one for the
  // GROUPs whose children still need visiting, one for leaves waiting to be
  // emitted. Leaves are only emitted once the GROUP queue is drained at the
  // current depth — this keeps the structural skeleton visible when the list
  // is truncated.
  const groupQueue: Array<{ node: SceneNode; path: string }> = [
    { node: root, path: root.name },
  ];
  const leafQueue: Array<{ node: SceneNode; path: string }> = [];

  while (groupQueue.length > 0) {
    const current = groupQueue.shift()!;
    if (components.length >= max) {
      truncated = true;
      break;
    }
    components.push({ id: current.node.id, name: current.node.name, path: current.path });

    for (const child of current.node.children ?? []) {
      const childPath = `${current.path} / ${child.name}`;
      if (child.type === 'GROUP') {
        groupQueue.push({ node: child, path: childPath });
      } else {
        leafQueue.push({ node: child, path: childPath });
      }
    }

    // When the group queue is empty we have finished a depth level. Drain the
    // leaves collected at this level before descending into the next.
    if (groupQueue.length === 0) {
      while (leafQueue.length > 0) {
        if (components.length >= max) {
          truncated = true;
          break;
        }
        const leaf = leafQueue.shift()!;
        components.push({ id: leaf.node.id, name: leaf.node.name, path: leaf.path });
      }
    }
  }

  // Any leaves left behind (hit the cap while draining) also count.
  if (leafQueue.length > 0) truncated = true;

  return { components, truncated };
}
