import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { placeImportedGroup } from '../ImportedModel';
import { MeshPartRegistry } from '../../../lib/scene/partRegistry';
import { buildSceneTree } from '../../../utils/modelLoader';

/** What centerModel computes for a 10 mm model, and where that model's centre was. */
const SCALE = 2 / 10;
const CENTRE = new THREE.Vector3(100, 5, 0);

/**
 * A 10 mm cube whose centre is 100 mm out along x, tagged and indexed the way a parse
 * tags and indexes one — buildSceneTree does the tagging, so the registry is built from
 * the same thing lib/scene/sceneEntries.ts builds it from.
 */
function fixture() {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10));
  mesh.position.copy(CENTRE);
  group.add(mesh);
  const tree = buildSceneTree(group, { value: 0 }, 'cube');
  return { group, registry: new MeshPartRegistry(group, tree) };
}

describe('placeImportedGroup', () => {
  it('centres a model that sits far from its own origin (a CAD part in mm)', () => {
    const { group, registry } = fixture();

    placeImportedGroup(group, SCALE, CENTRE.clone().negate(), registry);

    const box = new THREE.Box3().setFromObject(group);
    const c = box.getCenter(new THREE.Vector3());
    expect(c.x).toBeCloseTo(0, 5);
    expect(c.z).toBeCloseTo(0, 5);
    expect(box.min.y).toBeCloseTo(0, 5); // resting on the floor
    expect(box.getSize(new THREE.Vector3()).x).toBeCloseTo(2, 5);
  });

  it('finds the same floor from the registry as from the group it indexes', () => {
    // The seam the render audit's R1 is about: the floor is measured, and a measurement
    // taken by walking geometry is the wrong one once a part is a slot in a batch. Both
    // readings have to agree now, or the model would drop through the floor the moment
    // the renderer changed underneath them.
    const viaRegistry = fixture();
    const viaGroup = fixture();

    placeImportedGroup(viaRegistry.group, SCALE, CENTRE.clone().negate(), viaRegistry.registry);
    placeImportedGroup(viaGroup.group, SCALE, CENTRE.clone().negate(), null);

    expect(viaRegistry.group.position.y).toBeCloseTo(viaGroup.group.position.y, 10);
  });

  it('finds the same floor with the model hidden, so hiding a part cannot move the rest', () => {
    // `placeImportedGroup` measures with `bounds`, not `visibleBounds`, and the difference
    // is the point: placement re-runs on every entry change, so a model that dropped or
    // slid when somebody turned a bolt off in the Model Tree would look like the file had
    // changed. Hiding the root is the strongest form of the case — nothing is being drawn
    // at all, and the floor is still where the geometry is.
    const shown = fixture();
    const hidden = fixture();
    hidden.registry.setVisibleSubtree(hidden.registry.parts()[0].id, false);

    placeImportedGroup(shown.group, SCALE, CENTRE.clone().negate(), shown.registry);
    placeImportedGroup(hidden.group, SCALE, CENTRE.clone().negate(), hidden.registry);

    expect(hidden.group.position.y).toBeCloseTo(shown.group.position.y, 10);
    expect(hidden.registry.visibleBounds(new THREE.Box3()).isEmpty()).toBe(true);
  });
});
