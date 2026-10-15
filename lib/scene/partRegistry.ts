// Every part of a model, addressed by id and never by Object3D — task 04b stage 1.
//
// WHY THIS FILE EXISTS. Every per-part property the app has — visibility, the
// selection glow, a moved transform, a pin's anchor, a POI an agent inspects — is
// reached today by walking a parsed scene graph and reading `userData.modelId` off
// whatever object the walk landed on. That is a fine index while one part IS one
// THREE.Mesh, and it stops being one the moment a 40 000-part STEP assembly is drawn
// as a handful of BatchedMeshes: a batch has no per-part object to find, no
// `.visible` to set, no `.position` to move and no `.material` to glow.
//
// So the part id — the string buildSceneTree mints from the file's hash, which the
// wire, the store, the pins and the comments already carry — becomes the ONLY handle
// on a part, and this file is the seam between that id and however the part happens
// to be drawn. Nothing above a PartRegistry ever sees a Mesh, an instanceId or a
// batch slot, which is what lets stage 4 swap the renderer underneath without
// touching a pointer handler.
//
// TWO IMPLEMENTATIONS, ONE INTERFACE. `MeshPartRegistry` below is a thin index over
// the parsed hierarchy exactly as it is today: every method is a line or two over the
// Object3D it wraps, and it changes nothing a user can see. `BatchedPartRegistry`
// (stage 4) answers the same calls from `(BatchedMesh, slot)` pairs. Consumers move
// onto the interface now, while the answer is still the object they used to walk, so
// that the batching commit is a renderer change and not a nine-site picking change.
//
// This stage wires up picking only. `bounds`, `setVisibleSubtree` and the
// transform/highlight halves of PartHandle are implemented but not yet called: they
// are the seams stages 2, 3 and 4 hang off, and building them here is what keeps
// those stages to their own consumers.

import {
  Box3,
  Matrix4,
  type Intersection,
  type Material,
  type Mesh,
  type Object3D,
} from 'three';
import type { SceneNode } from '../../types';
import { setEmissiveHighlight, type EmissiveHighlight } from './materialHighlight';
import type { StoredLocalTransform } from './partTransforms';

/**
 * The part of a three.js Intersection a part lookup is allowed to read.
 *
 * Narrowed rather than taking `Intersection` whole because the second
 * implementation answers from `instanceId` and `batchId` and not from the object at
 * all: a BatchedMesh is ONE Object3D for every part in it, so `hit.object` says which
 * batch and the two indices say which part. Naming the three fields keeps that
 * contract visible and stops a caller passing something the registry cannot use.
 */
export type PickHit = Pick<Intersection, 'object' | 'instanceId' | 'batchId'>;

/** One part of one model. Never exposes whether it is a Mesh or a batch slot. */
export interface PartHandle {
  /** The node id: `${sceneModelPrefix(hash)}_${index}`. The id the wire and the store carry. */
  readonly id: string;
  /**
   * What the Model Tree's row for this part says, which is the name a laser label and
   * a pin should show. NOT necessarily the Object3D's own `name`: buildSceneTree
   * promotes a single child through the group that wrapped it and hands it the group's
   * name, so the tree's name is the readable one and the object's is often empty.
   */
  readonly name: string;
  /** This part's transform in its parent's space — the frame a PartTransform is in. */
  getMatrix(out: Matrix4): Matrix4;
  setMatrix(matrix: Matrix4): void;
  /** The three fields the gizmo writes to the wire, in the shape it writes them. */
  getLocalTransform(): StoredLocalTransform;
  setLocalTransform(transform: StoredLocalTransform): void;
  setVisible(visible: boolean): void;
  /**
   * The selection glow, or null to give the part back its own emissive.
   *
   * Per PART, which is the whole of the fix for the audit's D1: the glow is written on
   * a Material today, and materials are shared, so selecting one bolt of a GLB where
   * 400 share a material lights all 400. Stage 2 calls this; nothing calls it yet.
   */
  setHighlight(highlight: EmissiveHighlight | null): void;
  /** This part's box in WORLD space, matching what Box3.setFromObject answers today. */
  getBoundingBox(out: Box3): Box3;
}

/** One per parsed model, owned by the parse and disposed with it. */
export interface PartRegistry {
  /** The part this id names, or null when the id is not this model's. */
  get(id: string): PartHandle | null;
  /** Every part, in tree order — the order buildSceneTree minted the ids in. */
  parts(): readonly PartHandle[];
  /** The union box of the whole model. Replaces every `Box3().setFromObject(group)`. */
  bounds(out: Box3): Box3;
  /**
   * The part ids a raycast hit names in this registry, nearest first, or NULL when the
   * hit is not this registry's at all.
   *
   * An EMPTY array is a different answer from null and the difference is the point:
   * empty means the hit IS inside this model and must be ignored, because it or an
   * ancestor carries `userData.skipRaycast`. That flag is how the laser's own dot, the
   * gizmo's picker meshes and an avatar standing in front of the product stay
   * unpickable, and a caller that could not tell "not mine" from "mine, refused" would
   * go on to ask the next registry — and then the legacy walk — about a question this
   * model has already answered no.
   */
  partChainForHit(hit: PickHit): string[] | null;
  /** `partChainForHit`'s nearest id, or null for either of its non-answers. */
  partIdForHit(hit: PickHit): string | null;
  /**
   * Hide or show a part and everything below it.
   *
   * A subtree call rather than a per-part one because visibility inherits downward
   * today (components/Scene/ImportedModel.tsx threads `parentVisible` through its
   * recursion): hiding an assembly hides every bolt in it, and a registry that could
   * only set one part would leave every caller re-walking the tree to find the rest.
   */
  setVisibleSubtree(rootId: string, visible: boolean): void;
  /** Drop what this registry owns. Stage 4's implementation owns GPU buffers. */
  dispose(): void;
}

/** What one raycast hit resolved to, before the Model Tree is consulted. */
export interface HitParts {
  /**
   * Nearest first: the part the ray hit, then each of its ancestors that has an id.
   * A chain and not one id because the two switches in the amber strip want different
   * ends of it, and because an id in the chain is not always a row in the tree —
   * collapseSingleChildGroups promotes a group's only child and drops the group's row,
   * while the group keeps its id. Empty means nothing tagged was hit.
   */
  chain: string[];
  /** The model the hit belongs to. Null when the hit names no model. */
  modelId: string | null;
  /**
   * The part the ray hit, when a registry owns it — the source of its readable name
   * and, later, of its box and its transform. Null for the React-built bundled sample,
   * whose parts are components rather than a parsed model and so have no registry.
   */
  handle: PartHandle | null;
}

/** The answer for a hit that names nothing. Fresh object per call: `chain` is mutable. */
const noParts = (): HitParts => ({ chain: [], modelId: null, handle: null });

/**
 * Whether an object is something this app points THROUGH rather than AT.
 *
 * One predicate because five call sites had their own copy of it and the copies had
 * drifted: components/Scene/SpatialComments.tsx filtered avatars and beams but not
 * `skipRaycast`, so a pin could be dropped on the gizmo's own picker mesh. An agent's
 * avatar, a laser beam and a point cloud are not the product, and neither is anything
 * the renderer was told to leave out of the raycast.
 */
function isPointedThrough(object: Object3D): boolean {
  return Boolean(object.userData?.skipRaycast) || isIgnorable(object);
}

/** An avatar, a laser beam or a point cloud: in the scene, but not the product. */
function isIgnorable(object: Object3D): boolean {
  return Boolean(object.name?.startsWith?.('Agent')) || object.type === 'Line' || object.type === 'Points';
}

/**
 * Whether a ray may land on this hit at all.
 *
 * The OBJECT-level half of the filter, and a separate function from `hitParts` because
 * the two answers mean different things to a caller: this one says "look at the next
 * hit behind it", which is what the laser and the pin drop both do, while an empty
 * chain out of `hitParts` says "this hit was inside a model that refused it". Keeping
 * them apart is what preserves the legacy walk's behaviour for a Line or an avatar —
 * those are pointed through, and the walk still resolves whatever they are in front of.
 */
export function isPointableHit(hit: PickHit): boolean {
  return !isPointedThrough(hit.object);
}

/**
 * The legacy resolution, for the objects no registry owns.
 *
 * Which is one thing today: components/Scene/Product.tsx, the bundled twelve-part
 * sample, whose parts are React components that stamp `userData.modelId` and
 * `userData.nodeId` on their own groups and are never parsed into a
 * SceneModelEntry. It has no registry, so it keeps the walk it has always had — and
 * the walk is what `clickedNodeId`'s "no SceneModel behind it" branch answers from.
 *
 * Moved here from lib/scene/clickSelection.ts verbatim rather than left there so that
 * there is exactly ONE parent walk in the codebase: it used to have five copies
 * (clickSelection, lib/pickSelectionId, UserLaser's dwell check, UserLaser's pick,
 * MobileLaser, SpatialComments twice) and the audit's R9 is that porting some of them
 * and not others recreates the bug this file's header was written about — the laser and
 * the tree disagreeing about what was selected.
 */
function taggedChainFromObject(object: Object3D): HitParts {
  const chain: string[] = [];
  let modelId: string | null = null;
  let current: Object3D | null = object;
  while (current) {
    if (current.userData?.skipRaycast) return noParts();
    if (!isIgnorable(current)) {
      const tagged = current.userData?.modelId;
      if (typeof tagged === 'string' && modelId === null) modelId = tagged;
      // `nodeId` first, then `modelId`: an imported model writes the same string to
      // both, but the bundled samples used to stamp the model's root as every mesh's
      // `modelId` and the mesh's own id as its `nodeId`, and the two ids are still the
      // two ends of the amber strip's switch.
      const id = current.userData?.nodeId ?? tagged;
      if (typeof id === 'string' && !chain.includes(id)) chain.push(id);
    }
    current = current.parent ?? null;
  }
  return { chain, modelId, handle: null };
}

/**
 * Resolve one raycast hit to the parts it names.
 *
 * Every registry is asked in turn and the first one that claims the hit answers, which
 * is what makes this the single seam stage 4 swaps: a `MeshPartRegistry` claims a hit
 * by recognising the object, a `BatchedPartRegistry` will claim it by recognising the
 * BatchedMesh and reading `hit.batchId`/`hit.instanceId` off it. Callers do not know
 * which they got.
 */
export function hitParts(hit: PickHit | null, registries: Iterable<PartRegistry>): HitParts {
  if (!hit) return noParts();
  for (const registry of registries) {
    const chain = registry.partChainForHit(hit);
    // Not this registry's hit: ask the next one.
    if (chain === null) continue;
    if (chain.length === 0) return noParts();
    return { chain, modelId: chain[0], handle: registry.get(chain[0]) };
  }
  return taggedChainFromObject(hit.object);
}

/**
 * The registries of every parsed model in the store, in insertion order.
 *
 * Takes a structural type rather than importing SceneModelEntry because
 * lib/scene/sceneEntries.ts imports this module to build one, and the alternative is a
 * cycle for no gain. Entries with no registry are skipped: hand-built fixtures have
 * none, and `hitParts` answers those from the legacy walk, which for a
 * MeshPartRegistry is the same answer.
 */
export function partRegistries(
  entries: Record<string, { partRegistry?: PartRegistry } | undefined>,
): PartRegistry[] {
  const found: PartRegistry[] = [];
  for (const key of Object.keys(entries)) {
    const registry = entries[key]?.partRegistry;
    if (registry) found.push(registry);
  }
  return found;
}

/** The names buildSceneTree gave each node, so a handle's name is the tree row's. */
function treeNames(node: SceneNode, out: Map<string, string>): void {
  out.set(node.id, node.name);
  for (const child of node.children ?? []) treeNames(child, out);
}

function materialsOf(object: Object3D): Material[] {
  if (!(object as Mesh).isMesh) return [];
  const material = (object as Mesh).material;
  return Array.isArray(material) ? material : [material];
}

/** A part that is still one Object3D, which in stage 1 is every part. */
class MeshPartHandle implements PartHandle {
  constructor(
    readonly id: string,
    readonly name: string,
    /** Package-private on purpose: the registry walks subtrees through it. */
    readonly object: Object3D,
  ) {}

  // Composed from position/quaternion/scale rather than copied from `.matrix`, because
  // `.matrix` is only current after an updateMatrixWorld and a handle has to answer
  // correctly in the middle of a gizmo drag, before the next render.
  getMatrix(out: Matrix4): Matrix4 {
    return out.compose(this.object.position, this.object.quaternion, this.object.scale);
  }

  setMatrix(matrix: Matrix4): void {
    matrix.decompose(this.object.position, this.object.quaternion, this.object.scale);
  }

  getLocalTransform(): StoredLocalTransform {
    const { position, rotation, scale } = this.object;
    return {
      position: [position.x, position.y, position.z],
      rotation: [rotation.x, rotation.y, rotation.z],
      scale: [scale.x, scale.y, scale.z],
    };
  }

  setLocalTransform(transform: StoredLocalTransform): void {
    this.object.position.set(...transform.position);
    this.object.rotation.set(...transform.rotation);
    this.object.scale.set(...transform.scale);
  }

  setVisible(visible: boolean): void {
    this.object.visible = visible;
  }

  setHighlight(highlight: EmissiveHighlight | null): void {
    for (const material of materialsOf(this.object)) setEmissiveHighlight(material, highlight);
  }

  getBoundingBox(out: Box3): Box3 {
    return out.setFromObject(this.object);
  }
}

/**
 * The registry for a model that is still drawn the way it was parsed: one Object3D per
 * part. Built once, at parse time, from the group and the tree buildSceneTree made
 * from it.
 *
 * The index is built in `traverse` order, which is the pre-order walk buildSceneTree
 * mints its counter in, so `parts()` comes out in id order and two registries built
 * from the same bytes agree on both the ids and their order. That agreement is the
 * pin contract in lib/scene/sceneEntries.ts: a pin names the part it was placed on, and
 * every participant derives the same ids from the same file.
 *
 * Owns no GPU resource — it indexes objects the parsed group already owns — so
 * `dispose` only drops the maps. Stage 4's batched implementation is the one that
 * allocates buffers and has something to free.
 */
export class MeshPartRegistry implements PartRegistry {
  private readonly root: Object3D;
  private readonly handles: MeshPartHandle[] = [];
  private readonly byId = new Map<string, MeshPartHandle>();
  private readonly idByObject = new Map<Object3D, string>();

  constructor(root: Object3D, tree?: SceneNode | null) {
    this.root = root;
    const names = new Map<string, string>();
    if (tree) treeNames(tree, names);
    root.traverse((object) => {
      const id = object.userData?.modelId;
      // buildSceneTree writes that key onto every object it keeps and prunes the
      // branches with no mesh in them before writing it, so "tagged" and "is a node of
      // this model's tree" are the same test — including for the groups that
      // collapseSingleChildGroups dropped a row for, which stay pickable ancestors.
      if (typeof id !== 'string') return;
      const ownName = object.name?.trim() ?? '';
      const handle = new MeshPartHandle(id, names.get(id) ?? (ownName || id), object);
      this.handles.push(handle);
      this.byId.set(id, handle);
      this.idByObject.set(object, id);
    });
  }

  get(id: string): PartHandle | null {
    return this.byId.get(id) ?? null;
  }

  parts(): readonly PartHandle[] {
    return this.handles;
  }

  // On demand rather than precomputed: at build time the group has not been scaled,
  // centred or dropped onto the floor yet (placeImportedGroup runs in an effect after
  // the parse), and its parts have not been moved by a variant. Stage 2 decides where
  // the cached copy belongs once the callers it replaces are known.
  bounds(out: Box3): Box3 {
    return out.setFromObject(this.root);
  }

  partChainForHit(hit: PickHit): string[] | null {
    if (!this.ownsObject(hit.object)) return null;
    const chain: string[] = [];
    let current: Object3D | null = hit.object;
    while (current) {
      if (current.userData?.skipRaycast) return [];
      if (!isIgnorable(current)) {
        const id = this.idByObject.get(current);
        if (id !== undefined && !chain.includes(id)) chain.push(id);
      }
      if (current === this.root) break;
      current = current.parent ?? null;
    }
    return chain;
  }

  partIdForHit(hit: PickHit): string | null {
    return this.partChainForHit(hit)?.[0] ?? null;
  }

  setVisibleSubtree(rootId: string, visible: boolean): void {
    const root = this.byId.get(rootId);
    if (!root) return;
    root.object.traverse((object) => {
      const id = this.idByObject.get(object);
      if (id === undefined) return;
      this.byId.get(id)?.setVisible(visible);
    });
  }

  dispose(): void {
    this.handles.length = 0;
    this.byId.clear();
    this.idByObject.clear();
  }

  /**
   * Whether an object is inside this model, tagged or not.
   *
   * An ancestor walk rather than an `idByObject` lookup so that a hit on an untagged
   * object still resolves to the tagged ancestor above it — which is what the walk it
   * replaces did, and what makes a mesh the file gave no id of its own still select the
   * group it sits in.
   */
  private ownsObject(object: Object3D): boolean {
    for (let current: Object3D | null = object; current; current = current.parent) {
      if (current === this.root) return true;
    }
    return false;
  }
}
