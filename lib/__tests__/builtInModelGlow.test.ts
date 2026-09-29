import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { targetGlow, SELECTION_GLOW } from '../builtInModelGlow';
import type { ObjectState } from '../../types';

function model() {
  const root = new THREE.Group(); root.userData.nodeId = 'root';
  const cup = new THREE.Group(); cup.userData.nodeId = 'cup';
  const mesh = new THREE.Mesh(); mesh.userData = { nodeId: 'driver', meshIndex: '3' };
  root.add(cup); cup.add(mesh);
  return { root, cup, mesh };
}
const st = (sel: string[]): Record<string, ObjectState> =>
  Object.fromEntries(['root', 'cup', 'driver'].map(id => [id, { id, visible: true, expanded: true, selected: sel.includes(id) }]));

describe('targetGlow', () => {
  it('a pointer beats a selection', () => {
    const { mesh } = model();
    const g = targetGlow(mesh, { granularity: 'part', modelPointerColor: null, meshPointerColors: new Map([['3', '#ff0000']]), objectStates: st(['driver']) });
    expect(g?.color).toBe('#ff0000');
  });
  it('a selected mesh glows with no pointer on it — the tree click case', () => {
    const { mesh } = model();
    const g = targetGlow(mesh, { granularity: 'part', modelPointerColor: null, meshPointerColors: new Map(), objectStates: st(['driver']) });
    expect(g?.color).toBe(SELECTION_GLOW);
  });
  it('selecting a group lights the meshes under it', () => {
    const { mesh } = model();
    const g = targetGlow(mesh, { granularity: 'part', modelPointerColor: null, meshPointerColors: new Map(), objectStates: st(['cup']) });
    expect(g?.color).toBe(SELECTION_GLOW);
  });
  it('nothing selected, nobody pointing: no glow', () => {
    const { mesh } = model();
    expect(targetGlow(mesh, { granularity: 'part', modelPointerColor: null, meshPointerColors: new Map(), objectStates: st([]) })).toBeNull();
  });
  it("'model' granularity uses the whole-model pointer colour", () => {
    const { mesh } = model();
    const g = targetGlow(mesh, { granularity: 'model', modelPointerColor: '#00ff00', meshPointerColors: new Map(), objectStates: st([]) });
    expect(g?.color).toBe('#00ff00');
  });
});
