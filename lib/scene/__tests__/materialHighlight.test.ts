// A highlight that gives the material back what it took — batch BT.
//
// The bug this pins: components/Scene/ImportedModel.tsx wrote BLACK and zero over a
// material's emissive whenever a mesh stopped being selected, so one trip through the
// model tree took the glow a file had given its own lens off it for good. "Not great at
// keeping the textures" is what that looks like from the outside, and it is invisible in
// a screenshot of a model that never had an emissive — which is every model in the repo.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { highlightClone, originalEmissiveOf, setEmissiveHighlight } from '../materialHighlight';

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

describe('highlightClone — the per-part copy a selection draws from', () => {
  it('leaves the material it was cloned from exactly where it was, which is the fix for D1', () => {
    // The defect this exists for: 400 bolts sharing one material had one Material between
    // them, so `setEmissiveHighlight` on it lit all 400 when one was selected. Nothing is
    // written to the source any more, so nothing else that shares it can move.
    const source = material(0xff6600, 0.8);
    const clone = highlightClone(source, GLOW) as THREE.MeshStandardMaterial;

    expect(clone).not.toBe(source);
    expect(clone.emissive.getHex()).toBe(0x0044aa);
    expect(clone.emissiveIntensity).toBe(0.5);
    expect(source.emissive.getHex()).toBe(0xff6600);
    expect(source.emissiveIntensity).toBe(0.8);
    // And the source was never STAMPED, which matters at scale: the whole point of
    // remembering lazily is that a 40 000-part assembly does not get 40 000 writes.
    expect(source.userData.originalEmissive).toBeUndefined();
  });

  it('remembers the source\'s own emissive on the clone, so the clone can give it back', () => {
    const source = material(0x00ff88, 1);
    const clone = highlightClone(source, GLOW) as THREE.MeshStandardMaterial;

    // A clone starts unstamped even though Material.copy runs `userData` through JSON:
    // a remembered original holds a THREE.Color, which JSON turns into a plain {r,g,b},
    // so the copy is dropped and the clone stamps its own real Color instead.
    const remembered = clone.userData.originalEmissive;
    expect(remembered.color).toBeInstanceOf(THREE.Color);
    expect(remembered.color.getHex()).toBe(0x00ff88);
    expect(remembered.intensity).toBe(1);

    setEmissiveHighlight(clone, null);
    expect(clone.emissive.getHex()).toBe(0x00ff88);
    expect(clone.emissiveIntensity).toBe(1);
  });

  it('carries the source\'s textures across, because the look must not change', () => {
    const map = new THREE.Texture();
    const source = material(0x000000, 0);
    source.map = map;
    source.name = 'bolt-steel';

    const clone = highlightClone(source, GLOW) as THREE.MeshStandardMaterial;

    // By reference, which is what utils/modelLoader's convertToStandardMaterial does too
    // and the reason components/lobby/ReviewModelViewer must not dispose a texture: a
    // highlight that dropped the diffuse map would be a far more visible change than the
    // glow it was asked for.
    expect(clone.map).toBe(map);
    expect(clone.name).toBe('bolt-steel');
  });
});
