// A highlight that gives the material back what it took — batch BT.
//
// The bug this pins: components/Scene/ImportedModel.tsx wrote BLACK and zero over a
// material's emissive whenever a mesh stopped being selected, so one trip through the
// model tree took the glow a file had given its own lens off it for good. "Not great at
// keeping the textures" is what that looks like from the outside, and it is invisible in
// a screenshot of a model that never had an emissive — which is every model in the repo.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { applyBuiltInGlow } from '../../builtInModelGlow';
import { originalEmissiveOf, setEmissiveHighlight } from '../materialHighlight';

const GLOW = { color: new THREE.Color(0x0044aa), intensity: 0.5 };

function material(emissive: number, intensity: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x888888,
    emissive: new THREE.Color(emissive),
    emissiveIntensity: intensity,
  });
}

describe('setEmissiveHighlight', () => {
  it('gives a material its own emissive back when the highlight ends', () => {
    const mat = material(0xff6600, 0.8);

    setEmissiveHighlight(mat, GLOW);
    expect(mat.emissive.getHex()).toBe(0x0044aa);
    expect(mat.emissiveIntensity).toBe(0.5);

    setEmissiveHighlight(mat, null);
    expect(mat.emissive.getHex()).toBe(0xff6600);
    expect(mat.emissiveIntensity).toBe(0.8);
  });

  it('survives being highlighted twice, which is what selecting two parts in a row is', () => {
    const mat = material(0x00ff88, 1);

    setEmissiveHighlight(mat, GLOW);
    setEmissiveHighlight(mat, null);
    setEmissiveHighlight(mat, { color: new THREE.Color(0xff0000), intensity: 0.9 });
    setEmissiveHighlight(mat, null);

    expect(mat.emissive.getHex()).toBe(0x00ff88);
    expect(mat.emissiveIntensity).toBe(1);
  });

  it('leaves a material whose own emissive is black exactly where it was', () => {
    // The common case, and the one the old code got right by accident: restoring black
    // to a material that had black is indistinguishable from writing black over it.
    const mat = material(0x000000, 0);
    setEmissiveHighlight(mat, GLOW);
    setEmissiveHighlight(mat, null);
    expect(mat.emissive.getHex()).toBe(0x000000);
    expect(mat.emissiveIntensity).toBe(0);
  });

  it('shares one remembered original between the meshes that share a material', () => {
    const mat = material(0xff6600, 0.8);
    const first = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    const second = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);

    setEmissiveHighlight(first.material, GLOW);
    setEmissiveHighlight(second.material, null);

    // One material, one original: the second mesh restoring it while the first is still
    // selected is what a shared material does, and it is why the remembered value has to
    // be stamped once rather than read from whatever the material looks like now.
    expect(mat.emissive.getHex()).toBe(0xff6600);
    expect(originalEmissiveOf(mat)?.intensity).toBe(0.8);
  });

  it('stamps the original in userData, once, and never over it', () => {
    const mat = material(0xff6600, 0.8);
    expect(originalEmissiveOf(mat)).toEqual({ color: new THREE.Color(0xff6600), intensity: 0.8 });
    expect(mat.userData.originalEmissive).toBeDefined();

    setEmissiveHighlight(mat, GLOW);
    const second = originalEmissiveOf(mat);
    expect(second?.color.getHex()).toBe(0xff6600);
    expect(second).toBe(mat.userData.originalEmissive);
  });

  it('does not clear an emissiveMap, because no highlight here replaces one', () => {
    const map = new THREE.Texture();
    const mat = material(0xff6600, 0.8);
    mat.emissiveMap = map;

    setEmissiveHighlight(mat, GLOW);
    setEmissiveHighlight(mat, null);

    expect(mat.emissiveMap).toBe(map);
  });

  it('ignores a material with no emissive channel, and nothing at all', () => {
    const basic = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    expect(() => setEmissiveHighlight(basic, GLOW)).not.toThrow();
    expect(() => setEmissiveHighlight(basic, null)).not.toThrow();
    expect(basic.userData.originalEmissive).toBeUndefined();
    expect(originalEmissiveOf(basic)).toBeNull();
    expect(originalEmissiveOf(undefined)).toBeNull();
  });
});

describe('the glow the built-in samples ease back from', () => {
  it('eases towards the material\'s own emissive, not towards black', () => {
    // The samples do not snap a highlight on and off: lib/builtInModelGlow.ts lerps
    // every mesh towards its target every frame, and towards ZERO when there is no
    // target, which is how a laser sweeping across the headphones took the file's own
    // glow off them permanently. Two hundred frames with nobody pointing at anything is
    // what "the highlight has ended" means there.
    const mat = material(0xff6600, 0.8);
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat));
    const scratch = new THREE.Color();

    for (let frame = 0; frame < 200; frame += 1) {
      applyBuiltInGlow(root, 'headphones_0', 'part', {}, scratch);
    }

    expect(mat.emissiveIntensity).toBeCloseTo(0.8, 4);
    // getHex rather than the channels: three manages colour, so a Color built from
    // 0xff6600 holds it in linear-srgb and its green channel is 0.13, not 0.4.
    expect(mat.emissive.getHex()).toBe(0xff6600);
  });

  it('still lights a mesh up while something is pointing at it', () => {
    // The regression this must not cause: remembering the original is not the same as
    // refusing to move off it.
    const mat = material(0xff6600, 0.8);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    mesh.userData.nodeId = 'headphones_1';
    const root = new THREE.Group();
    root.add(mesh);
    const scratch = new THREE.Color();
    const selected = { headphones_1: { id: 'headphones_1', visible: true, selected: true, expanded: true } };

    for (let frame = 0; frame < 200; frame += 1) {
      applyBuiltInGlow(root, 'headphones_0', 'part', selected, scratch);
    }

    expect(mat.emissiveIntensity).toBeCloseTo(0.5, 4);
    expect(mat.emissive.b).toBeGreaterThan(mat.emissive.r);
  });
});
