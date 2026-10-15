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
// Stage 1 wired up picking, and built the transform half of a handle for the stage that
// would call it.
//
// STAGE 2 hangs three more off it. `bounds`/`visibleBounds` replace every
// `Box3().setFromObject(group)` that runs AFTER the parse, which is the audit's R1: a
// batch's geometry is its concatenated buffer in the batch's own space, so a box
// measured by walking it describes geometry nobody is drawing. `syncStates` replaces
// the recursive walk components/Scene/ImportedModel.tsx used to run over every object
// of every model on every change to the tree's states anywhere in the scene. And
// `PartHandle.setHighlight` now draws a highlighted part from its own clone of the
// file's material, which is the fix for the audit's D1 — the glow used to be written
// onto a Material, and materials are shared, so selecting one bolt of an assembly whose
// 400 bolts share one lit all 400.
//
// STAGE 3 hands the transform half over. `bindPose` is the transform the FILE gave a
// part, and it replaces the `userData.originalLocalTransform` stamp
// lib/scene/partTransforms.ts used to write lazily onto whichever Object3D it was about
// to move: an override REPLACES the file's transform rather than adding to it, so the
// file's own numbers have to be knowable after the part has moved, and the only safe
// moment to take them is the moment before something writes. That moment is now inside
// the handle's own write path, so no caller has to remember it — the gizmo used to have
// to stamp at pointer-down and not at pointer-up, and getting the moment wrong made
// "Reset part" put a part where the drag happened to end. `movedPartIds` is the index
// that makes resetting O(moved) rather than O(parts), and `gizmoProxyFor` answers the
// one Object3D drei's TransformControls still needs, in the frame a PartTransform is in.

import {
  Box3,
  Matrix4,
  Object3D,
  type Intersection,
  type Material,
  type Mesh,
} from 'three';
import type { SceneNode } from '../../types';
import { highlightClone, setEmissiveHighlight, type EmissiveHighlight } from './materialHighlight';
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
  /**
   * The transform the FILE gave this part, in the same space `getLocalTransform` answers
   * in. A copy, so nothing can write through it.
   *
   * The number an override is measured against and the one "Reset part" restores. An
   * override REPLACES the file's transform rather than adding to it (the ONE RULE at the
   * head of lib/scene/partTransforms.ts), which is only possible if the file's own numbers
   * survive the part being moved — and only correct if they were taken BEFORE it was.
   * Every write through a handle takes them first, so no caller has to know that.
   *
   * For a part nothing has written yet this is the same answer as `getLocalTransform`,
   * which is exactly right: a part that has never been moved is still standing where its
   * file put it. The one exception is a model's own root, whose local transform belongs to
   * `placeImportedGroup` — it is the centring and the baseScale — and which
   * `applyPartTransforms` therefore never writes to and never reads a bind pose from.
   */
  bindPose(): StoredLocalTransform;
  setVisible(visible: boolean): void;
  /**
   * The selection glow, or null to give the part back its own emissive.
   *
   * Per PART, which is the whole of the fix for the audit's D1: the glow used to be
   * written on a Material, and materials are shared, so selecting one bolt of a GLB
   * where 400 share a material lit all 400. This draws the part from a private clone of
   * its material instead (lib/scene/materialHighlight's `highlightClone`), so nothing
   * else that shares it moves.
   */
  setHighlight(highlight: EmissiveHighlight | null): void;
  /** This part's box in WORLD space, matching what Box3.setFromObject answers today. */
  getBoundingBox(out: Box3): Box3;
}

/**
 * The two of the Model Tree's per-node fields that reach the renderer.
 *
 * A structural type rather than the store's `ObjectState` because that also carries `id`
 * and `expanded`, and `expanded` is a chevron: components/UI/SceneTree.tsx reads it and
 * nothing under components/Scene/ ever has. Narrowing is what lets a caller hand over
 * the whole `objectStates` map — `ObjectState` satisfies this — without this module
 * importing a store type it has no other business knowing.
 */
export interface PartState {
  visible: boolean;
  selected: boolean;
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
   * The box of the model as it is being DRAWN, which is `bounds` unless the model itself
   * has been turned off.
   *
   * The two are separate because the callers want different answers: framing a picture
   * of a room must leave out a model somebody hid in the tree (lib/scene/modelBounds),
   * while dropping a model onto the floor must measure the whole file or a hidden part
   * would slide the visible ones off their own origin (components/Scene/ImportedModel's
   * `placeImportedGroup`, and the lobby's `measure`).
   */
  visibleBounds(out: Box3): Box3;
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
  /**
   * Apply the tree's state to this model's parts, and answer how many parts it wrote.
   *
   * BOTH halves of what a state change means are in here rather than in the caller,
   * because both need the part hierarchy and only the registry has it:
   *
   *   • visibility and selection inherit DOWNWARD — hiding an assembly hides every bolt
   *     in it, and selecting one selects everything inside it. So a change to a group is
   *     a change to its whole subtree.
   *   • a part that was hidden on its own stays hidden when the group above it is shown
   *     again. `setVisibleSubtree` cannot express that, and a caller that reached for it
   *     per changed id would un-hide exactly the parts somebody had turned off.
   *
   * The registry keeps the state it last applied, diffs the tree's own values against
   * it, and writes only the parts whose EFFECTIVE value moved. That is what makes the
   * cost of a click proportional to the click: `selectNode` (store.ts) rewrites every
   * entry in `objectStates` to clear the old selection, so a diff on object identity
   * would see the whole scene as changed, while a diff on the two booleans sees the two
   * ids that actually moved. The returned count is what the "a selection change touches
   * O(changed) parts" test asserts on.
   *
   * `highlight` is the glow a selected part is drawn with, or null for none. Passed in
   * rather than owned here because the colour is the app's, not the renderer's.
   */
  syncStates(
    states: Record<string, PartState | undefined>,
    highlight: EmissiveHighlight | null,
  ): number;
  /**
   * The ids of the parts this registry has written a transform to, in the order they were
   * first moved.
   *
   * One caller needs it and it is `applyPartTransforms`: an override REPLACES the file's
   * transform, so deleting one has to put the part back where the file had it, and finding
   * which parts those are by walking all of them is the O(parts) cost this whole refactor
   * exists to remove. A part that has never been written is by definition still at its bind
   * pose and has nothing to be put back to.
   *
   * Bounded by MAX_SCENE_PARTS (lib/scene/roomScene.ts) plus whatever a gizmo drag touched,
   * which is the same bound the wire already puts on the overrides themselves. A part put
   * back where it started stays in the list — dropping it would need a second write path
   * knowing when a part has landed exactly on its bind pose, and re-writing a part that is
   * already there costs nothing.
   */
  movedPartIds(): readonly string[];
  /**
   * The Object3D drei's `TransformControls` drags on this part's behalf, positioned in the
   * part's own frame and parented so that its local transform IS the part's — or null when
   * this model has no such part.
   *
   * The one place the "nothing above a registry ever sees an Object3D" rule is deliberately
   * broken, and the render audit is explicit about why: three's gizmo needs a real object
   * to attach to, it needs exactly one, and it needs it for the selected part only. So the
   * registry owns ONE proxy per model and moves it to whichever part is selected, rather
   * than every part keeping an object of its own just in case a handle lands on it.
   *
   * Reading the proxy's local transform gives the numbers a `PartTransform` carries, and
   * writing them back through `setLocalTransform` moves the part — the two are the same
   * frame because the proxy shares the part's parent. Under batching the parent is the
   * batch rather than a group, and the frame is still the one `getMatrix`/`setMatrix` use.
   *
   * Idempotent, so a render that runs twice attaches the same proxy to the same parent
   * twice and answers the same object.
   */
  gizmoProxyFor(id: string): Object3D | null;
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

/**
 * An avatar, a laser beam or a point cloud: in the scene, but not the product.
 *
 * Exported for lib/scene/batchedParts.ts, which walks the same chain for a hit that
 * landed on one of the parts it left un-batched and must refuse the same objects: two
 * answers to "is this the product" is the disagreement this file's header exists about.
 */
export function isIgnorable(object: Object3D): boolean {
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

/**
 * The box of one parsed model, from its registry when it has one.
 *
 * The fallback is for an entry built without a registry — a hand-made fixture, or a
 * caller holding a group and nothing else — and it is exactly the measurement the
 * audit's R1 warns about: `Box3.setFromObject` walks geometry, and a BatchedMesh's
 * geometry is the concatenated buffer in the batch's own space, so it would answer a box
 * of parts nobody is drawing where they are not. Every real parse builds a registry
 * (lib/scene/sceneEntries.ts), so in the app the fallback is never reached.
 */
export function modelBox(
  group: Object3D,
  registry: PartRegistry | null | undefined,
  out: Box3,
): Box3 {
  return registry ? registry.bounds(out) : out.setFromObject(group);
}

/**
 * The names buildSceneTree gave each node, so a handle's name is the tree row's.
 *
 * Exported for lib/scene/batchedParts.ts, which indexes the same ids and has to answer
 * the same name for the same part: a laser label and a pin must not read differently
 * because the model they came from happened to be big enough to be batched.
 */
export function treeNames(node: SceneNode, out: Map<string, string>): void {
  out.set(node.id, node.name);
  for (const child of node.children ?? []) treeNames(child, out);
}

/**
 * The private materials a highlight draws with, one per SOURCE material.
 *
 * Keyed on the source rather than on the part because a selection is a handful of parts
 * while a GROUP selection inherits downward and can name every part of an assembly: one
 * clone per part would allocate forty thousand materials to draw a glow that is the same
 * colour on all of them. One clone per material bounds it by the file, which is the same
 * bound the shared material it replaces had — with the difference that a part nobody
 * selected keeps the file's own material, and that is the fix for the audit's D1.
 *
 * Kept for the registry's lifetime rather than freed when the last highlighted part
 * gives it back: the next selection wants the same clone, and `dispose` frees the lot.
 *
 * ONE CLONE PER SOURCE MATERIAL also means two parts sharing a material share a colour.
 * The app has one selection colour, so that is invisible; a second highlight — the laser's
 * pointer colour, say — would need this keyed on the colour as well, and the comment on
 * `of` below is where that would bite.
 *
 * Exported because lib/scene/batchedParts.ts draws a highlighted part through the same
 * seam — one clone per source material, freed with the registry — and a second copy of
 * this is exactly how the two implementations would drift apart on the one thing the
 * audit's D1 was about.
 */
export class HighlightMaterials {
  private readonly clones = new Map<Material, Material>();

  /** The glowing stand-in for `source`, built the first time it is asked for. */
  of(source: Material, highlight: EmissiveHighlight): Material {
    let clone = this.clones.get(source);
    if (!clone) {
      clone = highlightClone(source, highlight);
      this.clones.set(source, clone);
      return clone;
    }
    // Re-applied rather than assumed: the app has one selection colour today, and a
    // second caller with another would otherwise get the first caller's glow.
    setEmissiveHighlight(clone, highlight);
    return clone;
  }

  dispose(): void {
    for (const clone of this.clones.values()) clone.dispose();
    this.clones.clear();
  }
}

/** A copy of three numbers, so a stored pose cannot be written to through the copy. */
const triple = (value: readonly [number, number, number]): [number, number, number] => [
  value[0],
  value[1],
  value[2],
];

/** A part that is still one Object3D, which in stage 3 is every part. */
class MeshPartHandle implements PartHandle {
  /**
   * The file's own material, held only while a highlight is on.
   *
   * Swapping it back is what "unselect" means now, and it is why the shared material
   * never learns it was highlighted: nothing is written to it, so nothing has to be
   * remembered off it either.
   */
  private ownMaterial: Material | Material[] | undefined;

  /**
   * Where the file had this part, taken the first time anything wrote to it and never
   * written again. Undefined while the part is still standing where the file put it,
   * because then its own transform IS the answer and copying it would only allocate.
   */
  private bind: StoredLocalTransform | undefined;

  constructor(
    readonly id: string,
    readonly name: string,
    /** Package-private on purpose: the registry walks subtrees through it. */
    readonly object: Object3D,
    private readonly highlighted: HighlightMaterials,
    /** Package-private too: the registry's index of which parts have been moved. */
    private readonly moved: Set<string>,
  ) {}

  // Composed from position/quaternion/scale rather than copied from `.matrix`, because
  // `.matrix` is only current after an updateMatrixWorld and a handle has to answer
  // correctly in the middle of a gizmo drag, before the next render.
  getMatrix(out: Matrix4): Matrix4 {
    return out.compose(this.object.position, this.object.quaternion, this.object.scale);
  }

  setMatrix(matrix: Matrix4): void {
    this.rememberBind();
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
    this.rememberBind();
    this.object.position.set(...transform.position);
    this.object.rotation.set(...transform.rotation);
    this.object.scale.set(...transform.scale);
  }

  bindPose(): StoredLocalTransform {
    const bind = this.bind ?? this.getLocalTransform();
    return {
      position: triple(bind.position),
      rotation: triple(bind.rotation),
      scale: triple(bind.scale),
    };
  }

  /**
   * Take the file's own numbers before this write replaces them, and say the part moved.
   *
   * In the write path rather than in a caller's hands, which is what the function it
   * replaces got wrong by being easy to forget: `rememberOriginalLocalTransform` had to be
   * called at pointer-DOWN and not at pointer-up, because TransformControls moves the
   * object on the pointer-move that follows, and an original taken after that was the
   * dragged value. Nothing can move a part without coming through here now.
   *
   * Still lazy, and for the reason lib/scene/partTransforms.ts's header used to give: a
   * STEP assembly can have tens of thousands of parts and at most MAX_SCENE_PARTS of them
   * can ever be overridden, so a buffer filled for all of them would allocate for parts
   * nobody will move. Stage 4's batched registry is the one that fills its bind buffer at
   * build, because building the batches touches every part once anyway.
   */
  private rememberBind(): void {
    if (!this.bind) this.bind = this.getLocalTransform();
    this.moved.add(this.id);
  }

  setVisible(visible: boolean): void {
    this.object.visible = visible;
  }

  // A swap of the material rather than a write to it, which is the audit's D1: the
  // glow used to be written onto whatever Material the mesh carried, and a file whose
  // 400 bolts share one material has ONE Material, so selecting a bolt lit all 400.
  // The part is now drawn from a private clone that carries the glow, and every other
  // part keeps the file's own — the same look, one part at a time.
  setHighlight(highlight: EmissiveHighlight | null): void {
    const mesh = this.object as Mesh;
    if (!mesh.isMesh) return;
    if (highlight === null) {
      if (this.ownMaterial === undefined) return;
      mesh.material = this.ownMaterial;
      this.ownMaterial = undefined;
      return;
    }
    if (this.ownMaterial === undefined) this.ownMaterial = mesh.material;
    const own = this.ownMaterial;
    // A multi-material part becomes several clones, one per group of its geometry: the
    // CAD reader splits a solid whose faces differ in colour into a material each, and a
    // highlight that only replaced the first would leave half a part glowing.
    mesh.material = Array.isArray(own)
      ? own.map((one) => this.highlighted.of(one, highlight))
      : this.highlighted.of(own, highlight);
  }

  getBoundingBox(out: Box3): Box3 {
    return out.setFromObject(this.object);
  }
}

/**
 * What one part was last drawn as, so a pass can skip the parts nothing moved.
 *
 * Two pairs rather than one because they answer different questions. The RAW pair is the
 * tree's own value for this id, and diffing it is how a pass finds the ids that changed;
 * the EFFECTIVE pair is what was written to the handle after this part's ancestors were
 * folded in, and diffing THAT is how a descent knows it can stop.
 */
interface AppliedState {
  rawVisible: boolean;
  rawSelected: boolean;
  effVisible: boolean;
  effSelected: boolean;
}

/**
 * A part nobody has touched: drawn, and not glowing.
 *
 * Which is also what a freshly parsed group IS — every Object3D comes out of a loader
 * visible and on the file's own material — so seeding the registry with this is what
 * lets the first `syncStates` write only the parts the tree has actually turned off or
 * selected, instead of needing a separate "apply everything" first pass.
 */
const untouched = (): AppliedState => ({
  rawVisible: true,
  rawSelected: false,
  effVisible: true,
  effSelected: false,
});

/**
 * The part hierarchy as DATA: every id, its nearest tagged ancestor, its tagged children,
 * and the state last applied to it.
 *
 * Shared by both registries rather than copied, and it is `syncStates` that makes sharing
 * worth the indirection. The algorithm in `sync` is the subtle half of stage 2 — diff the
 * tree's own two booleans rather than object identity, fold in what a part inherits from
 * above it, descend only from what moved, and stop the descent where the effective value
 * did not — and the render audit's R9 is precisely that two copies of one resolution
 * drift until the laser and the tree disagree about what is selected. A batched model and
 * an un-batched one are the same model at two sizes, so they answer a state change the
 * same way or the app behaves differently depending on how many parts a file happened to
 * have.
 *
 * What it does NOT know is how a part is drawn. `sync` answers the parts whose effective
 * value moved and hands each one to a `write` callback, which is where the two
 * implementations differ: one sets `Object3D.visible` and swaps a material, the other sets
 * a batch slot's visibility and raises an overlay mesh.
 */
export class PartGraph {
  private readonly applied = new Map<string, AppliedState>();

  /**
   * Tagged children per id, in tree order.
   *
   * A DATA descent and not `object.children`, because a batched part has no object to
   * descend into: its geometry is a range inside a buffer and its slot is a number. Both
   * registries answer from this, which is also what makes them agree — a MeshPartRegistry
   * walking `object.children` would visit untagged objects on the way and a batched one
   * could not.
   */
  readonly childrenOf = new Map<string, string[]>();

  constructor(
    /** Every id, pre-order: the order buildSceneTree minted them in. */
    readonly ids: readonly string[],
    /** Nearest tagged ancestor, so what a part inherits is a walk UP and not a descent. */
    readonly parentOf: ReadonlyMap<string, string | null>,
  ) {
    for (const id of ids) {
      this.childrenOf.set(id, []);
      this.applied.set(id, untouched());
    }
    for (const id of ids) {
      const parent = parentOf.get(id) ?? null;
      if (parent !== null) this.childrenOf.get(parent)?.push(id);
    }
  }

  /** Whether this id is one of the graph's parts. */
  has(id: string): boolean {
    return this.applied.has(id);
  }

  /** The tagged ids below this one, this one excluded, in tree order. */
  subtreeOf(id: string, out: string[] = []): string[] {
    for (const child of this.childrenOf.get(id) ?? []) {
      out.push(child);
      this.subtreeOf(child, out);
    }
    return out;
  }

  /**
   * What a part inherits from the ids above it, before its own value is folded in.
   *
   * A walk UP rather than a descent from the root, because a pass starts at whichever
   * part changed and the root may be forty thousand parts away: depth is a handful of
   * steps, the model is not.
   */
  inheritedFrom(id: string): { visible: boolean; selected: boolean } {
    let visible = true;
    let selected = false;
    for (let parent = this.parentOf.get(id) ?? null; parent; parent = this.parentOf.get(parent) ?? null) {
      const applied = this.applied.get(parent);
      if (!applied) break;
      visible = visible && applied.rawVisible;
      selected = selected || applied.rawSelected;
    }
    return { visible, selected };
  }

  /**
   * Diff the tree's state against what was last applied, and write the parts whose
   * EFFECTIVE value moved. Answers how many that was.
   *
   * Both halves of what a state change means live here rather than in the caller, because
   * both need the part hierarchy:
   *
   *   • visibility and selection inherit DOWNWARD — hiding an assembly hides every bolt
   *     in it, and selecting one selects everything inside it. So a change to a group is
   *     a change to its whole subtree.
   *   • a part that was hidden on its own stays hidden when the group above it is shown
   *     again. `setVisibleSubtree` cannot express that, and a caller that reached for it
   *     per changed id would un-hide exactly the parts somebody had turned off.
   *
   * That is what makes the cost of a click proportional to the click: `selectNode`
   * (store.ts) rewrites every entry in `objectStates` to clear the old selection, so a
   * diff on object identity would see the whole scene as changed, while a diff on the two
   * booleans sees the two ids that actually moved.
   */
  sync(
    states: Record<string, PartState | undefined>,
    write: (id: string, visible: boolean, selected: boolean) => void,
  ): number {
    // Pass 1: find the ids whose OWN value moved, and record the new value before any
    // descent reads it — a descent folds in its ancestors, and an ancestor later in the
    // list would otherwise be folded in with its old value.
    const changed: string[] = [];
    for (const id of this.ids) {
      const applied = this.applied.get(id);
      if (!applied) continue;
      const state = states[id];
      const rawVisible = state?.visible ?? true;
      const rawSelected = state?.selected ?? false;
      if (applied.rawVisible === rawVisible && applied.rawSelected === rawSelected) continue;
      applied.rawVisible = rawVisible;
      applied.rawSelected = rawSelected;
      changed.push(id);
    }

    // Pass 2: descend from each of them. Only a changed id can change its descendants'
    // effective value, so nothing else is visited at all.
    let touched = 0;
    for (const id of changed) {
      const { visible, selected } = this.inheritedFrom(id);
      touched += this.applyDown(id, visible, selected, write);
    }
    return touched;
  }

  clear(): void {
    this.applied.clear();
    this.childrenOf.clear();
  }

  /**
   * Write this part and everything below it, stopping where nothing moved.
   *
   * Stopping is safe and is the whole of the O(changed): a subtree is only re-entered
   * when the part above it changed, and a part whose OWN value changed is in pass 1's
   * list and gets a descent of its own. So a node whose effective value is the same as
   * last time can only have descendants whose effective value is also the same, unless
   * one of them changed on its own account — and that one is already scheduled.
   */
  private applyDown(
    id: string,
    inheritedVisible: boolean,
    inheritedSelected: boolean,
    write: (id: string, visible: boolean, selected: boolean) => void,
  ): number {
    const applied = this.applied.get(id);
    if (!applied) return 0;
    const visible = inheritedVisible && applied.rawVisible;
    const selected = inheritedSelected || applied.rawSelected;
    if (applied.effVisible === visible && applied.effSelected === selected) return 0;
    applied.effVisible = visible;
    applied.effSelected = selected;
    write(id, visible, selected);

    let touched = 1;
    for (const child of this.childrenOf.get(id) ?? []) {
      touched += this.applyDown(child, visible, selected, write);
    }
    return touched;
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
 * Owns the highlight clones, the one gizmo proxy and the index of moved parts — and
 * nothing else: the geometry and the file's materials belong to the parsed group. So
 * `dispose` frees the clones, takes the proxy back out of the group it was attached to,
 * and drops the maps. Stage 4's batched implementation is the one that allocates buffers.
 */
export class MeshPartRegistry implements PartRegistry {
  private readonly root: Object3D;
  private readonly handles: MeshPartHandle[] = [];
  private readonly byId = new Map<string, MeshPartHandle>();
  private readonly idByObject = new Map<Object3D, string>();
  /** The part hierarchy as data: parents, children, and the state last applied to each. */
  private readonly graph: PartGraph;
  private readonly highlighted = new HighlightMaterials();
  /** Written by the handles themselves, in the one place a transform can be written. */
  private readonly moved = new Set<string>();
  /** Built the first time a part is selected in Part mode, and reused for every one after. */
  private proxy: Object3D | null = null;

  constructor(root: Object3D, tree?: SceneNode | null) {
    this.root = root;
    const names = new Map<string, string>();
    if (tree) treeNames(tree, names);
    const ids: string[] = [];
    const parentOf = new Map<string, string | null>();
    root.traverse((object) => {
      const id = object.userData?.modelId;
      // buildSceneTree writes that key onto every object it keeps and prunes the
      // branches with no mesh in them before writing it, so "tagged" and "is a node of
      // this model's tree" are the same test — including for the groups that
      // collapseSingleChildGroups dropped a row for, which stay pickable ancestors.
      if (typeof id !== 'string') return;
      const ownName = object.name?.trim() ?? '';
      const handle = new MeshPartHandle(
        id,
        names.get(id) ?? (ownName || id),
        object,
        this.highlighted,
        this.moved,
      );
      this.handles.push(handle);
      this.byId.set(id, handle);
      this.idByObject.set(object, id);
      // Pre-order, so every ancestor of this object has already been indexed.
      ids.push(id);
      parentOf.set(id, this.taggedAncestorId(object));
    });
    this.graph = new PartGraph(ids, parentOf);
  }

  get(id: string): PartHandle | null {
    return this.byId.get(id) ?? null;
  }

  parts(): readonly PartHandle[] {
    return this.handles;
  }

  // On demand rather than precomputed, and stage 2 settled it there: every caller runs
  // AFTER something moved the geometry. placeImportedGroup scales the group and then
  // measures it to find the floor, a variant moves individual parts, and the lobby
  // measures a group it has just placed — so a box captured at build would be the box
  // of a model nobody is looking at yet. A cache here would have to be invalidated by
  // every transform write and every visibility change, which is more bookkeeping than
  // the measurement.
  bounds(out: Box3): Box3 {
    return out.setFromObject(this.root);
  }

  // The model's own `visible` and nothing finer, which is what
  // lib/scene/modelBounds has always answered: it measured the OUTERMOST tagged object
  // with Box3.expandByObject, and expandByObject walks every child whether it is
  // visible or not — so a part hidden inside a model that is still shown has never come
  // out of that box. What hiding the model's own row does is stop `traverseVisible`
  // descending into it at all, and that is the behaviour reproduced here. Stage 4 can
  // answer per part, because a batch that swaps a hidden part out really is not drawing
  // it; until then, changing this would re-frame every thumbnail of a room somebody had
  // hidden a bolt in.
  visibleBounds(out: Box3): Box3 {
    return this.root.visible ? out.setFromObject(this.root) : out.makeEmpty();
  }

  partChainForHit(hit: PickHit): string[] | null {
    if (!this.ownsObject(hit.object)) return null;
    const chain: string[] = [];
    let current: Object3D | null = hit.object;
    while (current) {
      if (current.userData?.skipRaycast) return [];
      // A part somebody turned off in the Model Tree is not there to point at, and this
      // is the one place that can say so: three's Raycaster never looks at `visible` —
      // `intersectObject` tests layers and calls `raycast`, and neither reads the flag —
      // so hiding a mesh has never taken it out of a pick on its own. What hid a whole
      // MODEL was React unmounting it (components/Scene/ImportedModel.tsx), which is why
      // the invariant at the foot of that file held while this one did not. It matters
      // more now than it did: a batched part is hidden by clearing a slot flag, which
      // three's BatchedMesh raycast DOES honour, so without this line the same click would
      // answer differently on either side of the batching threshold.
      if (current.visible === false) return [];
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

  // The diff, the downward inheritance and the "a part hidden on its own stays hidden"
  // rule all live in PartGraph, shared with the batched registry: see its comment for why
  // one copy of this algorithm is the point.
  syncStates(
    states: Record<string, PartState | undefined>,
    highlight: EmissiveHighlight | null,
  ): number {
    return this.graph.sync(states, (id, visible, selected) => {
      const handle = this.byId.get(id);
      if (!handle) return;
      handle.setVisible(visible);
      handle.setHighlight(selected ? highlight : null);
    });
  }

  movedPartIds(): readonly string[] {
    return [...this.moved];
  }

  gizmoProxyFor(id: string): Object3D | null {
    const handle = this.byId.get(id);
    if (!handle) return null;
    if (!this.proxy) {
      const proxy = new Object3D();
      proxy.name = 'PartGizmoProxy';
      // Never a target of its own: it stands in for a part, and a ray that landed on the
      // stand-in would resolve to nothing. It has no geometry so it cannot be hit today,
      // and the flag is what keeps that true if it ever grows one.
      proxy.userData.skipRaycast = true;
      this.proxy = proxy;
    }
    const proxy = this.proxy;
    // The part's own parent, so the proxy's LOCAL transform is in the frame a
    // PartTransform carries. Attaching it to the model's root instead would read root-space
    // numbers off a part nested three groups deep and then write them back as parent-space
    // ones, which is the same mistake twice over.
    const parent = handle.object.parent ?? this.root;
    if (proxy.parent !== parent) parent.add(proxy);
    proxy.position.copy(handle.object.position);
    // The Euler and not the quaternion, and the order with it: `Euler.setFromQuaternion`
    // goes through a rotation matrix, and `atan2` on an identity matrix answers -0 for some
    // of its terms. Nothing could see the difference in a rendered frame — JSON serialises
    // -0 as 0, so the wire never carried it either — but the override applied locally does
    // hold it, and "applying an override replaces the file's transform" is a rule about
    // numbers, so a drag that turned nothing should not be a drag that turned -0.
    proxy.rotation.copy(handle.object.rotation);
    proxy.scale.copy(handle.object.scale);
    return proxy;
  }

  dispose(): void {
    this.handles.length = 0;
    this.byId.clear();
    this.idByObject.clear();
    this.graph.clear();
    this.moved.clear();
    this.highlighted.dispose();
    // Taken back out of the group it was attached to: the parsed group outlives the
    // registry when a lobby viewer disposes one and keeps drawing the other.
    this.proxy?.removeFromParent();
    this.proxy = null;
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

  /** The nearest ancestor with an id of its own, or null at the top of the model. */
  private taggedAncestorId(object: Object3D): string | null {
    for (let current = object.parent; current; current = current.parent) {
      const id = this.idByObject.get(current);
      if (id !== undefined) return id;
    }
    return null;
  }
}
