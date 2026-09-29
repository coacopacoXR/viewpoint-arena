import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { pickSelectionId } from '../pickSelectionId';

function makeObject(userData: Record<string, unknown> = {}): THREE.Object3D {
  const obj = new THREE.Object3D();
  Object.assign(obj.userData, userData);
  return obj;
}

describe('pickSelectionId', () => {
  it('returns null for null hit object', () => {
    expect(pickSelectionId(null, 'part')).toBeNull();
    expect(pickSelectionId(null, 'model')).toBeNull();
  });

  it('returns null when no ancestor has modelId', () => {
    const obj = makeObject({ nodeId: 'node_1' });
    expect(pickSelectionId(obj, 'part')).toBeNull();
    expect(pickSelectionId(obj, 'model')).toBeNull();
  });

  it('returns null when ancestor has skipRaycast', () => {
    const parent = makeObject({ skipRaycast: true, modelId: 'root' });
    const child = makeObject({ nodeId: 'node_1' });
    parent.add(child);
    expect(pickSelectionId(child, 'part')).toBeNull();
    expect(pickSelectionId(child, 'model')).toBeNull();
  });

  it('returns root modelId for model granularity', () => {
    const root = makeObject({ modelId: 'headphones_assembly' });
    const child = makeObject({ nodeId: 'headphones_0' });
    root.add(child);
    expect(pickSelectionId(child, 'model')).toBe('headphones_assembly');
  });

  it('returns nearest nodeId for part granularity', () => {
    const root = makeObject({ modelId: 'headphones_assembly', nodeId: 'headphones_root' });
    const group = makeObject({ nodeId: 'headphones_1' });
    const mesh = makeObject({ nodeId: 'headphones_2' });
    root.add(group);
    group.add(mesh);
    expect(pickSelectionId(mesh, 'part')).toBe('headphones_2');
  });

  it('falls back to root modelId when no nodeId exists for part granularity', () => {
    const root = makeObject({ modelId: 'headphones_assembly' });
    const mesh = makeObject({});
    root.add(mesh);
    expect(pickSelectionId(mesh, 'part')).toBe('headphones_assembly');
  });

  it('skips Agent-prefixed objects and Lines', () => {
    const root = makeObject({ modelId: 'root' });
    const agent = makeObject({ nodeId: 'agent_node' });
    agent.name = 'Agent_1';
    const mesh = makeObject({ nodeId: 'mesh_node' });
    root.add(agent);
    agent.add(mesh);

    const line = new THREE.Line();
    line.userData = { nodeId: 'line_node' };
    root.add(line);

    expect(pickSelectionId(mesh, 'part')).toBe('mesh_node');
    expect(pickSelectionId(line, 'part')).toBe('root');
  });
});
