import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildSceneTree } from '../modelLoader';

function makeHierarchy(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'Root';

  const group1 = new THREE.Group();
  group1.name = 'Group1';

  const mesh1 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  mesh1.name = 'Mesh1';

  const mesh2 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  mesh2.name = 'Mesh2';

  group1.add(mesh1);
  group1.add(mesh2);
  root.add(group1);

  const mesh3 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  mesh3.name = 'Mesh3';
  root.add(mesh3);

  return root;
}

describe('buildSceneTree', () => {
  it('builds a tree with stable ids for the same hierarchy', () => {
    const hierarchy1 = makeHierarchy();
    const hierarchy2 = makeHierarchy();

    const counter1 = { value: 0 };
    const counter2 = { value: 0 };

    const tree1 = buildSceneTree(hierarchy1, counter1, 'test');
    const tree2 = buildSceneTree(hierarchy2, counter2, 'test');

    expect(tree1).not.toBeNull();
    expect(tree2).not.toBeNull();
    expect(tree1!.id).toBe(tree2!.id);
    expect(tree1!.children!.length).toBe(tree2!.children!.length);
  });

  it('uses the prefix for node ids', () => {
    const hierarchy = makeHierarchy();
    const counter = { value: 0 };
    const tree = buildSceneTree(hierarchy, counter, 'headphones');

    expect(tree!.id).toBe('headphones_0');
    expect(tree!.children![0].id).toBe('headphones_1');
    expect(tree!.children![0].children![0].id).toBe('headphones_2');
  });

  it('sets userData.nodeId on every object', () => {
    const hierarchy = makeHierarchy();
    const counter = { value: 0 };
    buildSceneTree(hierarchy, counter, 'test');

    expect(hierarchy.userData.nodeId).toBe('test_0');
    expect(hierarchy.children[0].userData.nodeId).toBe('test_1');
    expect((hierarchy.children[0] as THREE.Group).children[0].userData.nodeId).toBe('test_2');
    expect((hierarchy.children[0] as THREE.Group).children[1].userData.nodeId).toBe('test_3');
    expect(hierarchy.children[1].userData.nodeId).toBe('test_4');
  });

  it('sets userData.modelId on every object', () => {
    const hierarchy = makeHierarchy();
    const counter = { value: 0 };
    buildSceneTree(hierarchy, counter, 'test');

    expect(hierarchy.userData.modelId).toBe('test_0');
    expect(hierarchy.children[0].userData.modelId).toBe('test_1');
  });

  it('defaults to imported_ prefix when no prefix provided', () => {
    const hierarchy = makeHierarchy();
    const counter = { value: 0 };
    const tree = buildSceneTree(hierarchy, counter);

    expect(tree!.id).toBe('imported_0');
  });

  it('skips objects without renderable descendants', () => {
    const root = new THREE.Group();
    root.name = 'Root';

    const emptyGroup = new THREE.Group();
    emptyGroup.name = 'EmptyGroup';
    root.add(emptyGroup);

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.name = 'Mesh';
    root.add(mesh);

    const counter = { value: 0 };
    const tree = buildSceneTree(root, counter, 'test');

    expect(tree).not.toBeNull();
    expect(tree!.children!.length).toBe(1);
    expect(tree!.children![0].name).toBe('Mesh');
  });
});

describe('collapseSingleChildGroups', () => {
  it('shows a same-named wrapper group as its only child', async () => {
    const { collapseSingleChildGroups } = await import('../modelLoader');
    const tree = collapseSingleChildGroups({
      id: 'g1', name: 'Hook Left', type: 'GROUP',
      children: [{ id: 'm1', name: 'Hook Left', type: 'MESH' }],
    });
    expect(tree).toEqual({ id: 'm1', name: 'Hook Left', type: 'MESH' });
  });

  it('flattens a chain of wrappers and keeps a meaningful name over a placeholder', async () => {
    const { collapseSingleChildGroups } = await import('../modelLoader');
    const tree = collapseSingleChildGroups({
      id: 'a', name: 'Sketchfab_model', type: 'GROUP', children: [
        { id: 'b', name: 'Left Ear Cup', type: 'GROUP', children: [{ id: 'c', name: 'Mesh 7', type: 'MESH' }] },
      ],
    });
    expect(tree).toEqual({ id: 'c', name: 'Left Ear Cup', type: 'MESH' });
  });

  it('leaves a group with several children alone', async () => {
    const { collapseSingleChildGroups } = await import('../modelLoader');
    const node = { id: 'g', name: 'Cup', type: 'GROUP' as const, children: [
      { id: 'x', name: 'Pad', type: 'MESH' as const }, { id: 'y', name: 'Shell', type: 'MESH' as const },
    ] };
    expect(collapseSingleChildGroups(node)).toBe(node);
  });
});
