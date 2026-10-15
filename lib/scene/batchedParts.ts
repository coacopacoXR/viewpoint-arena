// Drawing a large model as a handful of BatchedMeshes instead of one Mesh per part —
// task 04b stage 4, the render audit's §3.2 step 7.
//
// WHY. The perf baseline (perf/results/README.md) measures a 10 000-part assembly at
// 10 002 draw calls and 4.8 frames a second while orbiting. The triangles are not the
// problem — 2.3 M of them is ordinary — the CALLS are: one per part, and again for the
// shadow pass, each one a state change the driver has to accept. `BatchedMesh` is three's
// answer and it is the right one here, because it draws many geometries under one material
// as a single multi-draw call, so the count goes from one-per-part to one-per-material.
//
// WHY NOT IN THE SMALL CASE. Batching costs a merge pass over every geometry at import and
// a second copy of every vertex while that pass runs, so a model that was already drawing
// in a handful of calls pays for nothing. `BATCH_MIN_PARTS` is the line, and below it the
// parse gets a `MeshPartRegistry` and nothing changes at all.
//
// WHAT STAYS TRUE. Every part keeps its id, its name, its own visibility, its own
// transform, its own bounding box and its own highlight — the invariants 00-RULES.md §6
// lists. The ids come from buildSceneTree over the parsed hierarchy BEFORE anything here
// runs, so the tree, the wire, the pins and the "N parts" line all read exactly as they did
// (the audit's R8), and two clients parsing the same bytes get the same ids in the same
// order (R11). What changes is only that a part is now a slot in a buffer rather than an
// Object3D, and nothing above a PartRegistry can tell.
//
// THE FOUR THINGS THAT ARE ACTUALLY HARD:
//
//   • A slot has no parent, so a part's matrix has to be composed by hand from the chain of
//     logical ancestors above it. `PartRecord.matrix` is that composition, kept in the
//     ROOT's space so the placement placeImportedGroup writes onto the root afterwards
//     moves every part with it and no slot has to be touched again, and refreshed for a
//     whole subtree whenever anything in that subtree moves. See `above`.
//   • A batch has one material, so a highlighted part cannot be recoloured in place. It is
//     drawn as an overlay Mesh carrying a clone of the file's material and its slot is
//     turned off underneath — the render audit's decision 1(c), and the same seam
//     MeshPartRegistry uses, so the audit's D1 stays fixed at either size.
//   • A box measured by walking geometry describes the merged buffer, not the parts (the
//     audit's R1), so every box here is composed from the geometry's own box and the part's
//     matrix instead.
//   • Batching copies every geometry, so the sources are freed once the copy is made (R6)
//     and the batches themselves are freed with the registry (R10).
//
// WHAT IS DELIBERATELY NOT HERE: multi-material parts. A material array is geometry groups
// and a batch draws one material, so batching one would put the draw calls back inside the
// batch and buy nothing. Those parts keep their Object3D and are counted by
// `unbatchedParts` (the audit's R5). Same for a SkinnedMesh, an InstancedMesh and a
// geometry carrying morph targets, none of which BatchedMesh can represent.

import {
  BatchedMesh,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Euler,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  Sphere,
  Vector3,
  type EulerOrder,
  type Material,
} from 'three';
import type { SceneNode } from '../../types';
import {
  HighlightMaterials,
  MeshPartRegistry,
  MotionCullIndex,
  MovedParts,
  PartGraph,
  isIgnorable,
  treeNames,
  type MotionCullView,
  type PartHandle,
  type PartRegistry,
  type PartState,
  type PickHit,
} from './partRegistry';
import type { EmissiveHighlight } from './materialHighlight';
import type { StoredLocalTransform } from './partTransforms';

/**
 * The part count at which a parsed model starts being drawn as batches.
 *
 * 512, and the number is the render audit's rather than a measurement: it sits just above
 * MAX_SCENE_PARTS (lib/scene/roomScene.ts, 500), which is how many parts the wire allows an
 * override for. Below that ceiling a model is small enough that the merge pass costs more
 * than the draw calls it saves, and above it the overrides are still bounded while the parts
 * are not — which is the regime this whole refactor exists for. Task 02's benchmark is what
 * tunes it; this is the placeholder it tunes.
 */
export const BATCH_MIN_PARTS = 512;

/**
 * How many parts one model may draw as highlight overlays at the same time.
 *
 * The overlay is the right answer for a selection and the wrong one for a big one. A
 * selection is normally one part, or a handful; but visibility and selection both inherit
 * DOWNWARD, so clicking the top row of the Model Tree selects every part of the model, and
 * one overlay Mesh per part would put the draw calls straight back where batching found them
 * — ten thousand parts selected is ten thousand draw calls again, plus ten thousand objects
 * the scene graph has to walk.
 *
 * Past the cap a part is simply left drawing normally rather than glowing. Bounded and
 * predictable, and it cannot regress the audit's D1: the alternative way to draw a large
 * selection cheaply is to write the emissive onto the batch's own material, which is exactly
 * the shared-material glow that lit four hundred bolts when one was selected.
 *
 * KNOWN LIMITATION, and the honest fix is not free: a batch whose parts are ALL highlighted
 * — the whole-model selection, which is the case that hits this cap — looks identical whether
 * the glow is on the material or on ten thousand overlays, so that case could glow the
 * material with no leak at all. Doing it properly needs the registry to know when a batch is
 * fully covered and to move between the two representations as coverage changes, which is
 * more state than stage 4 should quietly add. Until then a whole-model selection glows the
 * first MAX_OVERLAY_PARTS parts and the selection itself — the tree row, the strip's name for
 * it, the gizmo attached to it — is unaffected.
 */
export const MAX_OVERLAY_PARTS = 64;

const copyTriple = (value: readonly [number, number, number]): [number, number, number] => [
  value[0],
  value[1],
  value[2],
];

const copyTransform = (value: StoredLocalTransform): StoredLocalTransform => ({
  position: copyTriple(value.position),
  rotation: copyTriple(value.rotation),
  scale: copyTriple(value.scale),
});

const localOf = (object: Object3D): StoredLocalTransform => ({
  position: [object.position.x, object.position.y, object.position.z],
  rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
  scale: [object.scale.x, object.scale.y, object.scale.z],
});

const writeLocal = (object: Object3D, local: StoredLocalTransform): void => {
  object.position.set(local.position[0], local.position[1], local.position[2]);
  // `Euler.set` with no order keeps the one the object already had, which is the order
  // `localOf` read these three numbers in.
  object.rotation.set(local.rotation[0], local.rotation[1], local.rotation[2]);
  object.scale.set(local.scale[0], local.scale[1], local.scale[2]);
};

/**
 * Whether a matrix is an identity, to within what a compose-and-invert round trip leaves.
 *
 * An epsilon rather than `Matrix4.equals`, which compares element by element for exact
 * equality: `above` is computed as `inverse(parent) × part × inverse(local)`, and that is
 * mathematically an identity for the ordinary case but numerically a product of three
 * float matrices. Testing it exactly would keep a Matrix4 per part to store 1e-16 of noise,
 * and would then feed that noise back into every instance matrix composed from it.
 */
function isIdentity(matrix: Matrix4): boolean {
  const e = matrix.elements;
  for (let at = 0; at < 16; at += 1) {
    const expected = at % 5 === 0 ? 1 : 0;
    if (Math.abs(e[at] - expected) > 1e-9) return false;
  }
  return true;
}

// Scratch, because a pass over ten thousand parts that allocated a Matrix4 each would spend
// more time in the allocator than in the maths. None of these is ever returned, and none is
// held across a call that could use the same one.
const scratchMatrix = new Matrix4();
const scratchCompose = new Matrix4();
const scratchBox = new Box3();
const scratchPosition = new Vector3();
const scratchQuaternion = new Quaternion();
const scratchScale = new Vector3();
const scratchEuler = new Euler();
const IDENTITY = new Matrix4();

/** One BatchedMesh, and the private bookkeeping that says which part is in which slot. */
interface Batch {
  mesh: BatchedMesh;
  /**
   * Slot → part index. The indirection the audit's R11 asks for, and the reason no slot ever
   * leaves this file: a slot is a local, mutable number, while a node id is shared across
   * clients and persisted in pins and comments.
   *
   * Nothing here reorders slots. The audit assumed a hide would need a swap-and-pop to keep
   * a hidden part out of the raycast, and on three r181 it does not: `setVisibleAt` clears a
   * flag that both the draw list (`BatchedMesh.onBeforeRender`) and `BatchedMesh.raycast`
   * read, so a hidden part is neither drawn nor pickable where it stands. Keeping the map
   * private anyway is what lets that change without anything on the wire having meant a
   * slot.
   */
  partAtSlot: number[];
  /** Overlay geometry per batch geometry id, built the first time one of its parts glows. */
  overlays: Map<number, BufferGeometry>;
}

/** One part. Everything the Object3D used to carry, minus the Object3D. */
interface PartRecord {
  index: number;
  id: string;
  name: string;
  /**
   * The Object3D this part is still drawn through, or null once batching took it.
   *
   * Null for a batched part, and null too for a group whose branches batching emptied: those
   * are pruned so that a 40 000-part file does not leave 40 000 empty Object3Ds behind
   * costing a matrixWorld update a frame, which is the CPU half of the problem the audit says
   * a placeholder hierarchy would not solve. The part survives as data — its id, its name,
   * its row in the tree and its place in the hierarchy are all still here.
   */
  object: Object3D | null;
  batch: Batch | null;
  /** This part's slot in its batch, or -1. Private to this file — see Batch.partAtSlot. */
  slot: number;
  /** Its batch's geometry id, or -1. Says which slice of the merged buffer an overlay reads. */
  geometryId: number;
  /** The geometry this part was built from, needed until the batch has copied it. */
  geometry: BufferGeometry | null;
  /** The file's own material, which is what a highlight clones. Null for a group. */
  source: Material | Material[] | null;
  /**
   * This geometry's box in the part's OWN space, shared with every other part built from the
   * same BufferGeometry. Null for a part with no geometry of its own.
   *
   * Shared rather than copied because a file that repeats one bolt four thousand times has
   * one box, not four thousand — and because the world box is this one transformed, so there
   * is nothing per part left to remember.
   */
  localBox: Box3 | null;
  /** The transform the FILE gave this part. Immutable: a bind pose is a fact, not state. */
  readonly bind: StoredLocalTransform;
  /** The transform it has now. Starts as a copy of `bind`. */
  local: StoredLocalTransform;
  /** The Euler order `bind`'s three rotation numbers are in. */
  readonly order: EulerOrder;
  /**
   * Everything strictly above this part, in the root's space, as the file had it — or null,
   * which means an identity and is the answer for nearly every part.
   *
   * A part's matrix is composed as `parent × above × local`, and for a part whose Object3D
   * parent IS its nearest tagged ancestor the middle term cancels exactly: buildSceneTree
   * only tags an object when something renderable is inside it, so an untagged object cannot
   * sit between two tagged ones. That case is detected structurally rather than by doing the
   * multiplication, which is what keeps ten thousand parts from costing ten thousand
   * Matrix4s.
   *
   * What `above` covers is the case where the reasoning does not apply — a hand-built
   * fixture whose root is untagged, a loader that leaves an untagged node in the chain — and
   * it is measured from the real matrices at build so the composition is exact rather than
   * assumed.
   */
  above: Matrix4 | null;
  /** This part's matrix in the ROOT's space. Kept current; every box and slot reads it. */
  readonly matrix: Matrix4;
  /** Whether the tree currently has this part shown. What a slot goes back to on unhighlight. */
  visible: boolean;
  /**
   * Whether a motion cull is hiding this part, which is a RENDER-ONLY flag and not this one's
   * business: `visible` is what the Model Tree says and stays what it says while the camera
   * moves. Kept apart so that restoring the culled parts when the camera settles can never
   * un-hide a part somebody turned off — see PartRegistry.motionCull.
   */
  culled: boolean;
  /** The overlay drawing this part's highlight, or null while it is not highlighted. */
  overlay: Mesh | null;
  /** Whether a part batching left alone is currently on its clone rather than the file's. */
  glowing: boolean;
}

/** What one material-and-flags combination is going to cost, before the batch is built. */
interface BatchPlan {
  material: Material;
  castShadow: boolean;
  receiveShadow: boolean;
  /** Part indexes, in tree order, so the slots are too. */
  parts: number[];
  /** Unique source geometries, in first-seen order. */
  geometries: BufferGeometry[];
  /** Membership test for `geometries`, which for four thousand repeats cannot be a scan. */
  seen: Set<BufferGeometry>;
  vertexCount: number;
  indexCount: number;
}

/**
 * The signature BatchedMesh's own validation is going to demand.
 *
 * R4 keys a batch on (material, side, shadow flags), and that is necessary but not
 * sufficient: `addGeometry` THROWS on a geometry whose index-ness differs from the first one
 * added, that is missing an attribute the first one had, or whose itemSize or `normalized`
 * disagrees. One file is usually consistent and a mixed one is not — a vertex-coloured
 * primitive beside a plain one, a compressed attribute beside an uncompressed one — and the
 * failure would be a thrown import rather than a wrong picture. So the attributes go in the
 * key as well, and a file that mixes them gets two batches and one extra draw call instead
 * of an error.
 *
 * The array constructor is in there too. That one cannot throw — three falls back to a
 * per-component copy — but the fallback is a loop over every vertex of every geometry at
 * import, and separating an Int8 colour attribute from a Float32 position costs one string.
 */
function batchKeyOf(mesh: Mesh): string {
  const geometry = mesh.geometry;
  const attributes = Object.keys(geometry.attributes)
    .sort()
    .map((name) => {
      const attribute = geometry.attributes[name];
      return `${name}/${attribute.itemSize}/${attribute.normalized ? 1 : 0}/${attribute.array.constructor.name}`;
    })
    .join(',');
  const material = mesh.material as Material;
  const index = geometry.getIndex();
  return [
    material.uuid,
    // Redundant with the material's identity today, and kept because `ensureMeshMaterial`
    // mutates `.side` in place on a material several meshes share: the day anything sets a
    // per-mesh side, a key without it would batch two parts that face different ways.
    material.side,
    mesh.castShadow ? 1 : 0,
    mesh.receiveShadow ? 1 : 0,
    index ? `i/${index.array.constructor.name}` : 'n',
    attributes,
  ].join('|');
}

/**
 * Whether a mesh can go into a batch at all.
 *
 * Every refusal is "BatchedMesh cannot represent this" rather than "this would be slower": a
 * material array is geometry groups and a batch draws one material (R5), and a skinned,
 * instanced or morphing mesh is animated by state three keeps per Object3D and has no slot
 * for. Each of these keeps the Object3D it was parsed as and is counted by `unbatchedParts`,
 * so a file made entirely of them gets a MeshPartRegistry's behaviour at a
 * BatchedPartRegistry's cost — which is exactly why the count is worth answering.
 */
function batchable(mesh: Mesh): boolean {
  const geometry = mesh.geometry;
  if (!geometry || geometry.getAttribute('position')?.count === 0) return false;
  if (!mesh.material || Array.isArray(mesh.material)) return false;
  const animated = mesh as unknown as { isSkinnedMesh?: boolean; isInstancedMesh?: boolean };
  if (animated.isSkinnedMesh || animated.isInstancedMesh) return false;
  return Object.keys(geometry.morphAttributes ?? {}).length === 0;
}

/**
 * One geometry's slice of a batch's merged buffer, as a geometry of its own.
 *
 * What a highlighted part is drawn from. The source geometry was freed when the batch was
 * built (R6), so the only copy of these vertices left is the range inside the merged
 * attribute arrays — and reading it back is a subarray copy of one part's worth of data, a
 * few kilobytes for a selection of one part.
 *
 * Cached per geometry id on the batch, because selecting a group selects every part in it
 * and four hundred bolts of one template are one slice, not four hundred.
 */
function sliceGeometry(batch: BatchedMesh, geometryId: number): BufferGeometry | null {
  const range = batch.getGeometryRangeAt(geometryId);
  if (!range || range.vertexCount === 0) return null;
  const merged = batch.geometry;
  const out = new BufferGeometry();

  for (const name of Object.keys(merged.attributes)) {
    const source = merged.getAttribute(name);
    const from = range.vertexStart * source.itemSize;
    // `slice` rather than a fresh typed array and a `set`: it answers the SAME constructor
    // the merged attribute uses, so an Int8 colour attribute stays Int8 and a Float32
    // position stays Float32 without this having to enumerate what three might have used.
    const array = source.array.slice(from, from + range.vertexCount * source.itemSize);
    out.setAttribute(name, new BufferAttribute(array, source.itemSize, source.normalized));
  }

  const index = merged.getIndex();
  if (index && range.indexCount > 0) {
    // Rebased to the slice's own first vertex. The merged index counts from the start of the
    // whole buffer, and a slice whose indices point forty thousand vertices up its own
    // buffer draws nothing at all.
    const rebased = new Uint32Array(range.indexCount);
    for (let at = 0; at < range.indexCount; at += 1) {
      rebased[at] = index.getX(range.indexStart + at) - range.vertexStart;
    }
    out.setIndex(new BufferAttribute(rebased, 1));
  }

  return out;
}

/** A part addressed through a record, which is what a BatchedPartRegistry owns. */
class BatchedPartHandle implements PartHandle {
  constructor(
    readonly id: string,
    readonly name: string,
    private readonly record: PartRecord,
    // Package-private on purpose: every write goes through the registry, because a slot, an
    // overlay and the subtree under a group are things only the registry has the index for.
    private readonly registry: BatchedPartRegistry,
  ) {}

  // Composed from the stored local transform rather than read off a matrix, so the answer is
  // in the same frame `setLocalTransform` writes in: this part's PARENT's space, which is
  // the frame a PartTransform carries on the wire.
  getMatrix(out: Matrix4): Matrix4 {
    const local = this.record.local;
    scratchEuler.set(local.rotation[0], local.rotation[1], local.rotation[2], this.record.order);
    scratchQuaternion.setFromEuler(scratchEuler);
    scratchPosition.set(local.position[0], local.position[1], local.position[2]);
    scratchScale.set(local.scale[0], local.scale[1], local.scale[2]);
    return out.compose(scratchPosition, scratchQuaternion, scratchScale);
  }

  setMatrix(matrix: Matrix4): void {
    matrix.decompose(scratchPosition, scratchQuaternion, scratchScale);
    scratchEuler.setFromQuaternion(scratchQuaternion, this.record.order);
    this.setLocalTransform({
      position: [scratchPosition.x, scratchPosition.y, scratchPosition.z],
      rotation: [scratchEuler.x, scratchEuler.y, scratchEuler.z],
      scale: [scratchScale.x, scratchScale.y, scratchScale.z],
    });
  }

  getLocalTransform(): StoredLocalTransform {
    return copyTransform(this.record.local);
  }

  setLocalTransform(transform: StoredLocalTransform): void {
    this.registry.writeTransform(this.record.index, transform);
  }

  bindPose(): StoredLocalTransform {
    return copyTransform(this.record.bind);
  }

  setVisible(visible: boolean): void {
    // The subtree and not just this part, because that is what `Object3D.visible = false`
    // means: hiding an assembly hides every bolt in it, and a batched bolt is no longer
    // inside the assembly's object to inherit anything from. `syncStates` does not come
    // through here — it descends the graph itself and writes one part at a time.
    this.registry.writeVisibleSubtree(this.record.index, visible);
  }

  setHighlight(highlight: EmissiveHighlight | null): void {
    this.registry.writeHighlight(this.record.index, highlight);
  }

  getBoundingBox(out: Box3): Box3 {
    return this.registry.boxOfSubtree(this.record.index, out);
  }
}

/**
 * The registry for a model big enough to be worth drawing as batches.
 *
 * Built once, at parse time, from the same group and the same tree a MeshPartRegistry is
 * built from — and it indexes the same ids in the same order, because that order comes from
 * a pre-order traverse of the parsed hierarchy and the traverse happens before anything here
 * moves.
 *
 * Owns the batches, their merged buffers and instance textures, the overlay geometries and
 * the highlight clones. It does NOT own the file's materials: those came with the parse and
 * leave with it, through components/lobby/ReviewModelViewer's `disposeGroup` in the lobby and
 * not at all in the room, exactly as they did before this file existed.
 */
export class BatchedPartRegistry implements PartRegistry {
  private readonly root: Object3D;
  private readonly records: PartRecord[] = [];
  private readonly handles: BatchedPartHandle[] = [];
  private readonly byId = new Map<string, BatchedPartHandle>();
  private readonly indexOf = new Map<string, number>();
  /** Only the parts batching left alone are still objects, so only they are still keyed. */
  private readonly idByObject = new Map<Object3D, string>();
  private readonly graph: PartGraph;
  private readonly batches: Batch[] = [];
  private readonly batchOf = new Map<Object3D, Batch>();
  private readonly highlighted = new HighlightMaterials();
  private readonly moved = new MovedParts();
  /** How many parts batching could not take. Answered, not fixed — see `batchable`. */
  private unbatched = 0;
  /** Which part each highlight overlay stands in for, so a hit on one resolves to it. */
  private readonly overlayIndex = new Map<Object3D, number>();
  /** How many overlays are up, against MAX_OVERLAY_PARTS. See `writeHighlight`. */
  private overlayCount = 0;
  /** The parts' spheres, in the root's space, sorted by radius. Built at the first cull. */
  private readonly cullIndex: MotionCullIndex;
  /** How many parts had been moved when `cullIndex` was built. See `motionCull`. */
  private cullBuiltAt = -1;
  /**
   * A geometry's own sphere, keyed on the box it was measured from.
   *
   * `localBox` is shared by every part built from the same BufferGeometry, so a file that
   * repeats one bolt four thousand times measures one sphere and not four thousand — the same
   * sharing the box already has, and the reason a cull build is per TEMPLATE plus a matrix
   * apply per part rather than a box-to-sphere per part.
   */
  private readonly cullSpheres = new Map<Box3, Sphere>();
  /** Scratch for the cull, so neither a build nor a frame allocates. */
  private readonly cullEye = new Vector3();
  private readonly cullInverse = new Matrix4();
  private proxy: Object3D | null = null;
  private anchor: Object3D | null = null;

  constructor(root: Object3D, tree?: SceneNode | null) {
    this.root = root;
    // Current before anything is measured off it: every matrix below is relative to the
    // root's, and a root a caller has moved without updating would bake the old pose in.
    root.updateMatrixWorld(true);

    const names = new Map<string, string>();
    if (tree) treeNames(tree, names);

    const tagged: Object3D[] = [];
    root.traverse((object) => {
      // The same test MeshPartRegistry makes: buildSceneTree writes that key onto every
      // object it keeps, and prunes the branches with no mesh in them before writing it.
      if (typeof object.userData?.modelId === 'string') tagged.push(object);
    });

    const ids: string[] = [];
    const parentOf = new Map<string, string | null>();
    const rootInverse = scratchMatrix.copy(root.matrixWorld).invert().clone();

    for (const object of tagged) {
      const id = object.userData.modelId as string;
      const bind = localOf(object);
      const ownName = object.name?.trim() ?? '';
      const isMesh = (object as Mesh).isMesh === true;
      const record: PartRecord = {
        index: this.records.length,
        id,
        name: names.get(id) ?? (ownName || id),
        object,
        batch: null,
        slot: -1,
        geometryId: -1,
        geometry: isMesh ? (object as Mesh).geometry : null,
        source: isMesh ? ((object as Mesh).material as Material | Material[]) : null,
        localBox: null,
        bind,
        local: copyTransform(bind),
        order: object.rotation.order,
        above: null,
        // Root-relative, and not world: the batches hang off the root, so the placement
        // placeImportedGroup writes onto it afterwards moves every part with it and no
        // instance matrix ever has to be touched again.
        matrix: new Matrix4().multiplyMatrices(rootInverse, object.matrixWorld),
        visible: true,
        culled: false,
        overlay: null,
        glowing: false,
      };

      const parentId = this.taggedAncestorId(object);
      parentOf.set(id, parentId);
      ids.push(id);
      this.records.push(record);
      this.indexOf.set(id, record.index);
      this.idByObject.set(object, id);

      // `above` is what makes `parent × above × local` land on the matrix just measured,
      // whatever sits between the two. The ordinary case is detected structurally rather
      // than by multiplying three matrices and hoping the answer looks like an identity:
      // see PartRecord.above.
      if (parentId === null) {
        record.above = object.parent === this.root ? null : this.measureAbove(record, null);
      } else {
        const parent = this.records[this.indexOf.get(parentId)!];
        record.above = parent.object === object.parent ? null : this.measureAbove(record, parent);
      }
    }

    for (const record of this.records) {
      const handle = new BatchedPartHandle(record.id, record.name, record, this);
      this.handles.push(handle);
      this.byId.set(record.id, handle);
    }

    this.graph = new PartGraph(ids, parentOf);
    this.buildBatches();
    this.pruneEmptied();
    // Sized here rather than as a field initialiser, because the records it indexes are the
    // ones the traverse above just built.
    this.cullIndex = new MotionCullIndex(this.records.length);
  }

  /**
   * How many parts batching could not take and left as the Object3Ds they were.
   *
   * Answered rather than logged because the number is the interesting thing about a file: a
   * CAD assembly answers 0 and draws in one call per material, while a glTF whose every
   * primitive carries a material array answers "all of them" and batching bought nothing but
   * the merge pass. Nothing in the app acts on it yet.
   */
  unbatchedParts(): number {
    return this.unbatched;
  }

  get(id: string): PartHandle | null {
    return this.byId.get(id) ?? null;
  }

  parts(): readonly PartHandle[] {
    return this.handles;
  }

  /**
   * The box of the whole model.
   *
   * Composed from each part's own geometry box and its matrix rather than measured off the
   * graph, and that is the audit's R1: `Box3.setFromObject` walks geometry, and a batch's
   * geometry is the merged buffer in the batch's own space, so every part would be measured
   * at the origin and the model would frame as a blob centred on nothing. No caller throws
   * on that — they all read a wrong or an empty box as "there is nothing to frame", so it
   * fails as a blank thumbnail rather than as an error.
   *
   * What is still in the graph is measured the old way and unioned in, because batching does
   * not take everything: a part it refused keeps its own Object3D, and so does any
   * LineSegments or Points a loader left behind in a branch buildSceneTree pruned. Leaving
   * those out would shrink the box under a model that has them.
   */
  bounds(out: Box3): Box3 {
    out.makeEmpty();
    for (const record of this.records) {
      if (record.slot < 0 || !record.localBox) continue;
      this.worldMatrixOf(record, scratchMatrix);
      out.union(scratchBox.copy(record.localBox).applyMatrix4(scratchMatrix));
    }
    for (const child of this.root.children) {
      if (this.batchOf.has(child)) continue;
      out.expandByObject(child);
    }
    return out;
  }

  // The model's own `visible` and nothing finer, which is what MeshPartRegistry answers and
  // what lib/scene/modelBounds has always meant: a part hidden inside a model that is still
  // shown has never come out of that box. A batch COULD answer per part now — a slot turned
  // off really is not drawn — and deliberately does not, because then the two registries
  // would frame a thumbnail differently and the difference would depend on nothing but how
  // many parts the file happened to have.
  visibleBounds(out: Box3): Box3 {
    return this.root.visible ? this.bounds(out) : out.makeEmpty();
  }

  partChainForHit(hit: PickHit): string[] | null {
    if (!this.ownsObject(hit.object)) return null;

    // A batch answers from its indices and not from the object: one BatchedMesh IS every part
    // in it, so `hit.object` says which batch and `hit.batchId` says which slot. That is the
    // whole reason PickHit carries both, and it is also why three skipping a cleared slot in
    // its own raycast is enough for the audit's R2 — a hidden part produces no hit to
    // resolve in the first place, so pointing at where it was points at whatever is behind
    // it, which is why somebody hid it.
    // An overlay is the highlighted part itself, drawn on top of a slot that is switched off.
    const overlaid = this.overlayIndex.get(hit.object);
    if (overlaid !== undefined) return this.chainFrom(overlaid);

    const batch = this.batchOf.get(hit.object);
    if (batch) {
      const index = typeof hit.batchId === 'number' ? batch.partAtSlot[hit.batchId] : undefined;
      return index === undefined ? [] : this.chainFrom(index);
    }

    // Everything else is an object still in the graph: a part batching refused, the model's
    // own root, an overlay standing in for a highlighted part, or a mesh the file gave no id
    // of its own, which resolves to the tagged ancestor above it exactly as it always has.
    const chain: string[] = [];
    let current: Object3D | null = hit.object;
    while (current) {
      if (current.userData?.skipRaycast) return [];
      // The rule MeshPartRegistry applies, for the same reason: three's Raycaster never reads
      // `visible`, so without this a part hidden in the tree would still answer a click here
      // while its batched neighbour would not.
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
    const index = this.indexOf.get(rootId);
    if (index === undefined) return;
    this.writeVisibleSubtree(index, visible);
  }

  syncStates(
    states: Record<string, PartState | undefined>,
    highlight: EmissiveHighlight | null,
  ): number {
    // One copy of the diff, the downward inheritance and the "a part hidden on its own stays
    // hidden" rule, shared with MeshPartRegistry through PartGraph. What differs is only the
    // write at the bottom of it: a slot's visibility flag and an overlay, rather than
    // `Object3D.visible` and a swapped material.
    return this.graph.sync(states, (id, visible, selected) => {
      const index = this.indexOf.get(id);
      if (index === undefined) return;
      this.writeVisible(index, visible);
      this.writeHighlight(index, selected ? highlight : null);
    });
  }

  // The spheres are in the ROOT's space and so is the eye, which is what makes a model that has
  // been placed, dragged or scaled cost nothing here: `record.matrix` is already the root-relative
  // matrix every box and slot reads. Only a part that MOVED stales a sphere, and a part moves
  // through `writeTransform`, which is the one place `moved` grows — so comparing its size is a
  // complete dirtiness test with no bookkeeping at the write site.
  motionCull(view: MotionCullView | null): number {
    if (view === null) {
      return this.cullIndex.restore((part) => this.writeCulled(this.records[part], false));
    }
    if (this.cullBuiltAt !== this.moved.version) this.buildCullIndex();
    this.root.updateWorldMatrix(true, false);
    this.cullInverse.copy(this.root.matrixWorld).invert();
    this.cullEye.copy(view.eye).applyMatrix4(this.cullInverse);
    return this.cullIndex.apply(
      this.cullEye,
      view.k,
      // A part drawing from an overlay — a batched one — or from a swapped material — one
      // batching left alone — is a part somebody is looking at, and is the one part that must
      // not vanish for being small.
      (part) => this.records[part].overlay !== null || this.records[part].glowing,
      (part, culled) => this.writeCulled(this.records[part], culled),
    );
  }

  /** The cull's own write, which is the composition `applyPart` exists to keep in one place. */
  private writeCulled(record: PartRecord, culled: boolean): void {
    record.culled = culled;
    this.applyPart(record);
  }

  /**
   * Measure every candidate part's sphere once, in the root's space, and sort them by radius.
   *
   * Cheap here in a way it is not in MeshPartRegistry: `localBox` was already measured per
   * GEOMETRY when the batches were built, and a box to a sphere is a centre and a diagonal with
   * no vertices in it. So a build is one sphere per template plus one matrix apply per part —
   * a few hundred spheres and ten thousand multiplies — rather than a walk of the file's geometry.
   */
  private buildCullIndex(): void {
    this.cullIndex.begin();
    for (const record of this.records) {
      // A part with no geometry of its own — a group, or the model's root — is not a candidate:
      // see MotionCullIndex.begin. Skipping it here is what stops the root from being measured as
      // a point at its own origin, which is the smallest sphere in the file and would have been
      // the first thing a cull hid, taking the whole model with it.
      if (!record.localBox) continue;
      let sphere = this.cullSpheres.get(record.localBox);
      if (!sphere) {
        sphere = record.localBox.getBoundingSphere(new Sphere());
        this.cullSpheres.set(record.localBox, sphere);
      }
      scratchPosition.copy(sphere.center).applyMatrix4(record.matrix);
      // The part's own scale, which is the only thing between its geometry's space and the
      // root's. Largest axis, so a non-uniform one under-culls rather than hides something big.
      scratchScale.setFromMatrixScale(record.matrix);
      const scale = Math.max(scratchScale.x, scratchScale.y, scratchScale.z) || 1;
      this.cullIndex.push(
        record.index,
        scratchPosition.x,
        scratchPosition.y,
        scratchPosition.z,
        sphere.radius * scale,
      );
    }
    this.cullIndex.finish();
    this.cullBuiltAt = this.moved.version;
  }

  movedPartIds(): readonly string[] {
    return [...this.moved];
  }

  /**
   * The Object3D drei's TransformControls drags on this part's behalf.
   *
   * The same contract MeshPartRegistry answers, and the part of stage 4 easiest to get
   * quietly wrong: components/Scene/ReviewModelGizmo re-parks the proxy EVERY FRAME between
   * drags, so this has to be cheap, idempotent, and leave the proxy's LOCAL frame equal to
   * the one `getLocalTransform` and `setLocalTransform` use — or an undo, a "Reset part" or a
   * colleague's edit landing while a part is selected would park the handles somewhere the
   * part is not, and the next drag would push that stale pose onto it.
   *
   * A batched part has no parent object to hang the proxy from, so the registry keeps one
   * ANCHOR per model and stands it on the logical parent's matrix. The anchor carries that
   * matrix whole rather than decomposed into position/rotation/scale, because a chain of
   * transforms is not always decomposable: a non-uniform scale under a rotation is a shear,
   * and a CAD assembly tipped from Z-up by its loader is exactly a rotation applied above
   * whatever the file did. drei then reads a parent frame that is the part's own to the last
   * decimal, so what comes off the proxy is what goes on the wire.
   */
  gizmoProxyFor(id: string): Object3D | null {
    const index = this.indexOf.get(id);
    if (index === undefined) return null;
    if (!this.proxy) {
      const proxy = new Object3D();
      proxy.name = 'PartGizmoProxy';
      // Never a target of its own: it stands in for a part, and a ray that landed on the
      // stand-in would resolve to nothing. It has no geometry so it cannot be hit today, and
      // the flag is what keeps that true if it ever grows one.
      proxy.userData.skipRaycast = true;
      this.proxy = proxy;
    }
    if (!this.anchor) {
      const anchor = new Object3D();
      anchor.name = 'PartGizmoAnchor';
      anchor.userData.skipRaycast = true;
      // The matrix IS the parent frame and is written whole, so composing it from
      // position/rotation/scale would throw away exactly the shear it may be carrying.
      anchor.matrixAutoUpdate = false;
      this.root.add(anchor);
      this.anchor = anchor;
    }
    const anchor = this.anchor;
    const proxy = this.proxy;
    const record = this.records[index];

    const parentId = this.graph.parentOf.get(id) ?? null;
    anchor.matrix.copy(parentId === null ? IDENTITY : this.records[this.indexOf.get(parentId)!].matrix);
    anchor.matrixWorld.multiplyMatrices(this.root.matrixWorld, anchor.matrix);

    if (proxy.parent !== anchor) anchor.add(proxy);
    proxy.position.set(record.local.position[0], record.local.position[1], record.local.position[2]);
    // The Euler and its order, and not the quaternion: `Euler.setFromQuaternion` goes through
    // a rotation matrix and `atan2` answers -0 for some terms of an identity one. Nothing
    // could see that in a rendered frame — JSON serialises -0 as 0, so the wire never carried
    // it either — but "applying an override replaces the file's transform" is a rule about
    // numbers, and a drag that turned nothing should not be a drag that turned -0.
    proxy.rotation.set(
      record.local.rotation[0],
      record.local.rotation[1],
      record.local.rotation[2],
      record.order,
    );
    proxy.scale.set(record.local.scale[0], record.local.scale[1], record.local.scale[2]);
    proxy.updateMatrix();
    return proxy;
  }

  dispose(): void {
    for (const batch of this.batches) {
      for (const geometry of batch.overlays.values()) geometry.dispose();
      batch.overlays.clear();
      batch.partAtSlot.length = 0;
      // Out of the graph first, so a `disposeGroup` run afterwards does not find the batch and
      // free its merged buffer a second time.
      batch.mesh.removeFromParent();
      // Frees the merged attribute buffers AND the instance-matrix and indirect-draw
      // DataTextures three allocates in the BatchedMesh constructor. Neither is reachable
      // from `.geometry` or `.material`, which is why `disposeGroup` on its own leaked them.
      batch.mesh.dispose();
    }
    this.batches.length = 0;
    this.batchOf.clear();
    for (const record of this.records) {
      record.overlay?.removeFromParent();
      record.overlay = null;
      record.object = null;
      record.geometry = null;
    }
    this.overlayCount = 0;
    this.overlayIndex.clear();
    // The spheres a cull build measured, which are keyed on the boxes those records carried.
    this.cullSpheres.clear();
    this.records.length = 0;
    this.handles.length = 0;
    this.byId.clear();
    this.indexOf.clear();
    this.idByObject.clear();
    this.graph.clear();
    this.moved.clear();
    this.highlighted.dispose();
    // Taken back out of the group they were attached to: the parsed group outlives the
    // registry when a lobby viewer disposes one and keeps drawing the other.
    this.proxy?.removeFromParent();
    this.proxy = null;
    this.anchor?.removeFromParent();
    this.anchor = null;
  }

  // ─── build ────────────────────────────────────────────────────────────────────

  /**
   * Group the batchable meshes by material-and-flags, merge each group, and take the sources
   * out of the graph.
   *
   * Two passes and not one, because a BatchedMesh has to be told its vertex and index budget
   * in its constructor and cannot grow afterwards: the first finds the unique geometries per
   * batch and adds up what they cost, the second allocates and fills.
   */
  private buildBatches(): void {
    const plans = new Map<string, BatchPlan>();
    const boxes = new Map<BufferGeometry, Box3>();

    for (const record of this.records) {
      const object = record.object;
      if (!object) continue;
      const geometry = record.geometry;
      if (geometry) record.localBox = boxOf(geometry, boxes);

      const mesh = object as Mesh;
      if (mesh.isMesh !== true) continue;
      if (!batchable(mesh)) {
        this.unbatched += 1;
        continue;
      }

      const key = batchKeyOf(mesh);
      let plan = plans.get(key);
      if (!plan) {
        plan = {
          material: mesh.material as Material,
          castShadow: mesh.castShadow,
          receiveShadow: mesh.receiveShadow,
          parts: [],
          geometries: [],
          seen: new Set(),
          vertexCount: 0,
          indexCount: 0,
        };
        plans.set(key, plan);
      }
      plan.parts.push(record.index);
      // A shared geometry is added ONCE and instanced per part — task 04b decision 3. The
      // convert-service GLB, and any file that repeats one template across an assembly, share
      // a single BufferGeometry between many meshes, and merging it per part would copy the
      // same vertices four thousand times for the same one draw call either way.
      if (!plan.seen.has(geometry!)) {
        plan.seen.add(geometry!);
        plan.geometries.push(geometry!);
        plan.vertexCount += geometry!.getAttribute('position').count;
        plan.indexCount += geometry!.getIndex()?.count ?? 0;
      }
    }

    for (const plan of plans.values()) {
      this.batches.push(this.buildBatch(plan));
      // R6: batching copied every one of these into a merged buffer, so without this the peak
      // is twice the file's geometry — on a file already large enough to need the 100 MB slow
      // import warning in utils/modelLoader.ts. Freed here rather than in `dispose`, because
      // `dispose` runs when the model goes away and this has to run before it is ever drawn.
      for (const geometry of plan.geometries) geometry.dispose();
      plan.seen.clear();
    }
  }

  private buildBatch(plan: BatchPlan): Batch {
    const mesh = new BatchedMesh(plan.parts.length, plan.vertexCount, plan.indexCount, plan.material);
    mesh.name = `BatchedParts ${this.batches.length}`;
    // Shadows and culling are per mesh, and a batch is now the mesh: the flags its parts
    // carried are the flags it draws with, which is why they are half the batch key.
    mesh.castShadow = plan.castShadow;
    mesh.receiveShadow = plan.receiveShadow;
    this.root.add(mesh);

    const batch: Batch = { mesh, partAtSlot: [], overlays: new Map() };
    this.batchOf.set(mesh, batch);

    const geometryIdOf = new Map<BufferGeometry, number>();
    for (const geometry of plan.geometries) geometryIdOf.set(geometry, mesh.addGeometry(geometry));

    for (const index of plan.parts) {
      const record = this.records[index];
      const geometryId = geometryIdOf.get(record.geometry!)!;
      // `addInstance` leaves the new slot on an identity matrix, so the pose is written
      // explicitly — and from the record rather than recomposed, so a batch stands its parts
      // exactly where the file had them.
      const slot = mesh.addInstance(geometryId);
      mesh.setMatrixAt(slot, record.matrix);
      record.batch = batch;
      record.slot = slot;
      record.geometryId = geometryId;
      batch.partAtSlot[slot] = index;
      // Out of the graph, and off the object index. Both matter: left in the graph the part
      // would be drawn twice — once as the mesh it was and once as the slot it became — and
      // left in the index a ray that somehow landed on the detached mesh would resolve to a
      // part nothing is drawing. A hit on a batch answers from `partAtSlot` instead.
      record.object!.removeFromParent();
      this.idByObject.delete(record.object!);
      record.object = null;
      record.geometry = null;
    }
    return batch;
  }

  /**
   * Take the branches batching emptied out of the graph.
   *
   * Batching removes the meshes; what is left is a skeleton of groups with nothing in them,
   * and leaving it standing would keep the cost the audit says a placeholder hierarchy does
   * not solve — one matrixWorld update per empty Object3D per frame, forty thousand of them
   * for a big STEP. A group goes only once it is genuinely empty, so every part batching
   * could not take keeps its whole ancestor chain and its own Object3D semantics.
   */
  private pruneEmptied(): void {
    const prune = (object: Object3D): void => {
      for (const child of [...object.children]) prune(child);
      if (object === this.root || this.batchOf.has(object)) return;
      if (object.children.length > 0 || (object as Mesh).geometry) return;
      const id = this.idByObject.get(object);
      if (id !== undefined) {
        const index = this.indexOf.get(id);
        if (index !== undefined) this.records[index].object = null;
        this.idByObject.delete(object);
      }
      object.removeFromParent();
    };
    prune(this.root);
  }

  // ─── per-part writes ──────────────────────────────────────────────────────────

  /**
   * Put one part where its local transform says, and everything below it with it.
   *
   * The subtree and not just the part, because a slot has no parent to inherit from: moving
   * an assembly has to move every bolt in it by hand. Bounded in practice by MAX_SCENE_PARTS
   * — 500 overrides is all the wire will carry — plus whatever one gizmo drag is holding, and
   * the alternative of walking every part to find which are under the one that moved is the
   * cost this whole refactor exists to remove.
   */
  writeTransform(index: number, transform: StoredLocalTransform): void {
    const record = this.records[index];
    // Taken here and not by a caller, for the reason MeshPartHandle gives: an override
    // REPLACES the file's transform, so the file's own numbers have to be knowable after the
    // part has moved, and the only safe moment to have taken them is the moment before
    // something writes. Under batching they are also filled at build, so this can only ever
    // confirm what is already there.
    this.moved.add(record.id);
    record.local = copyTransform(transform);
    const parentId = this.graph.parentOf.get(record.id) ?? null;
    const parentMatrix = parentId === null ? IDENTITY : this.records[this.indexOf.get(parentId)!].matrix;
    this.refreshFrom(index, parentMatrix);
  }

  private refreshFrom(index: number, parentMatrix: Matrix4): void {
    const record = this.records[index];
    record.matrix.multiplyMatrices(parentMatrix, record.above ?? IDENTITY);
    composeLocal(record, scratchCompose);
    record.matrix.multiply(scratchCompose);

    if (record.batch && record.slot >= 0) {
      record.batch.mesh.setMatrixAt(record.slot, record.matrix);
      // The batch's own bounding sphere is cached over its instances and `setMatrixAt` does
      // not invalidate it. Left stale, a part dragged well outside the model would be frustum
      // culled along with the whole batch and vanish out of somebody's hand mid-drag.
      record.batch.mesh.boundingSphere = null;
      record.batch.mesh.boundingBox = null;
      if (record.overlay) record.overlay.matrix.copy(record.matrix);
    }
    if (record.object) writeLocal(record.object, record.local);

    for (const childId of this.graph.childrenOf.get(record.id) ?? []) {
      const child = this.indexOf.get(childId);
      if (child !== undefined) this.refreshFrom(child, record.matrix);
    }
  }

  /** This part alone, which is what a descent writes; the subtree is the descent's own job. */
  writeVisible(index: number, visible: boolean): void {
    const record = this.records[index];
    record.visible = visible;
    this.applyPart(record);
  }

  /**
   * Write what a part is drawn as, from the three flags that decide it.
   *
   * ONE place rather than one per flag, because they compose and a caller writing its own would
   * be a fourth answer to "is this part on the screen": the tree's visibility, the motion cull's,
   * and whether a highlight overlay is standing in for the slot. A part is drawn iff the tree has
   * it visible AND the motion cull has not taken it; its SLOT is off whenever an overlay is up
   * whatever those two say, because the overlay IS the part being drawn (see `writeHighlight`).
   *
   * The overlay follows the tree alone and not the cull, and that is safe rather than a hole: a
   * part with an overlay is never culled, because raising one clears the flag and `motionCull`
   * refuses to set it again.
   */
  private applyPart(record: PartRecord): void {
    const drawn = record.visible && !record.culled;
    if (record.batch && record.slot >= 0) {
      record.batch.mesh.setVisibleAt(record.slot, drawn && record.overlay === null);
    }
    if (record.object) record.object.visible = drawn;
    if (record.overlay) record.overlay.visible = record.visible;
  }

  writeVisibleSubtree(index: number, visible: boolean): void {
    this.writeVisible(index, visible);
    for (const childId of this.graph.subtreeOf(this.records[index].id)) {
      const child = this.indexOf.get(childId);
      if (child !== undefined) this.writeVisible(child, visible);
    }
  }

  /**
   * Draw this part glowing, or give it back to its batch.
   *
   * The overlay of the render audit's decision 1(c): a batch has one material between every
   * part in it, so a glow cannot be written per part the way it used to be written per
   * material. The part's slot is turned off and an un-batched Mesh is stood exactly on it
   * carrying a clone of the file's own material with the emissive on — the same colour at the
   * same intensity over the same textures, and because the clone is the PART's and not the
   * material's the audit's D1 stays fixed: selecting one bolt of four hundred that share a
   * material lights one bolt.
   *
   * The overlay is pickable and answers as the part it stands on (see `overlayIndex`). It
   * cannot be `skipRaycast`: the slot underneath is off, so a ray that looked through the
   * overlay would find nothing of this part at all, and the selected part — the one people
   * point the laser at and drop pins on — would be the one part nobody could hit.
   */
  writeHighlight(index: number, highlight: EmissiveHighlight | null): void {
    const record = this.records[index];

    // A part batching left alone is still a Mesh, so it takes the material swap
    // MeshPartHandle does rather than paying for an overlay it does not need.
    if (record.slot < 0) {
      const mesh = record.object as Mesh | null;
      if (!mesh?.isMesh || record.source === null) return;
      if (highlight === null) {
        if (!record.glowing) return;
        mesh.material = record.source;
        record.glowing = false;
        return;
      }
      if (!record.glowing) record.glowing = true;
      mesh.material = cloneMaterial(record.source, this.highlighted, highlight);
      return;
    }

    const batch = record.batch!;
    if (highlight === null) {
      if (!record.overlay) return;
      record.overlay.removeFromParent();
      this.overlayIndex.delete(record.overlay);
      record.overlay = null;
      this.overlayCount -= 1;
      // Back to whatever the tree says about this part, which is not necessarily "shown": a
      // selection can be cleared while the part it was on is hidden — or while a motion cull is
      // holding it, which `applyPart` composes in rather than this call having to know about.
      this.applyPart(record);
      return;
    }

    if (record.overlay || record.source === null || Array.isArray(record.source)) return;
    // The cap, and what happens at it: see MAX_OVERLAY_PARTS. Checked before the slice so a
    // selection that is over the budget does not pay for geometry it will not draw.
    if (this.overlayCount >= MAX_OVERLAY_PARTS) return;
    let geometry = batch.overlays.get(record.geometryId);
    if (!geometry) {
      geometry = sliceGeometry(batch.mesh, record.geometryId) ?? undefined;
      if (!geometry) return;
      batch.overlays.set(record.geometryId, geometry);
    }
    const overlay = new Mesh(geometry, this.highlighted.of(record.source, highlight));
    overlay.name = 'PartHighlight';
    overlay.castShadow = batch.mesh.castShadow;
    overlay.receiveShadow = batch.mesh.receiveShadow;
    // Positioned by an explicit matrix rather than by position/rotation/scale, for the same
    // reason the gizmo's anchor is: the instance matrix is a chain and may be a shear.
    overlay.matrixAutoUpdate = false;
    overlay.matrix.copy(record.matrix);
    batch.mesh.add(overlay);
    record.overlay = overlay;
    this.overlayIndex.set(overlay, index);
    this.overlayCount += 1;
    // The slot goes off because the overlay is up. Through `applyPart` rather than a write of
    // its own so that this does not have to know what else is hiding the part.
    this.applyPart(record);
  }

  // ─── reads ────────────────────────────────────────────────────────────────────

  /** This part's box and every part below it, in world space. */
  boxOfSubtree(index: number, out: Box3): Box3 {
    out.makeEmpty();
    this.expandOwn(index, out);
    for (const childId of this.graph.subtreeOf(this.records[index].id)) {
      const child = this.indexOf.get(childId);
      if (child !== undefined) this.expandOwn(child, out);
    }
    return out;
  }

  /**
   * `above` measured rather than assumed, for the part whose Object3D parent is not its
   * nearest tagged ancestor. See PartRecord.above for why that is nearly never.
   */
  private measureAbove(record: PartRecord, parent: PartRecord | null): Matrix4 | null {
    scratchCompose.copy(parent ? parent.matrix : IDENTITY).invert().multiply(record.matrix);
    composeLocalFrom(record.bind, record.order, scratchMatrix);
    scratchCompose.multiply(scratchMatrix.invert());
    return isIdentity(scratchCompose) ? null : scratchCompose.clone();
  }

  /** One part's own geometry box, in world space, unioned into `out`. */
  private expandOwn(index: number, out: Box3): void {
    const record = this.records[index];
    if (!record.localBox) return;
    if (record.slot >= 0) {
      this.worldMatrixOf(record, scratchMatrix);
      out.union(scratchBox.copy(record.localBox).applyMatrix4(scratchMatrix));
      return;
    }
    // A part batching left alone is measured from the object it still has. Its subtree is not
    // walked with it: `Box3.setFromObject` would descend the graph, and a batched descendant
    // is no longer in it, so the descent is the logical one `boxOfSubtree` is doing.
    if (!record.object) return;
    record.object.updateWorldMatrix(true, false);
    out.union(scratchBox.copy(record.localBox).applyMatrix4(record.object.matrixWorld));
  }

  /** The part's matrix in WORLD space, which is its root-relative one under the root's. */
  private worldMatrixOf(record: PartRecord, out: Matrix4): Matrix4 {
    const batch = record.batch;
    if (!batch) return out.copy(record.matrix);
    batch.mesh.updateWorldMatrix(true, false);
    return out.multiplyMatrices(batch.mesh.matrixWorld, record.matrix);
  }

  /** This part, then each of its ancestors that has an id. Nearest first. */
  private chainFrom(index: number): string[] {
    const chain: string[] = [];
    for (let id: string | null = this.records[index].id; id; id = this.graph.parentOf.get(id) ?? null) {
      if (!chain.includes(id)) chain.push(id);
    }
    return chain;
  }

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

/**
 * The glowing stand-in for one material, array-aware.
 *
 * A multi-material part is one clone per group of its geometry, because the CAD reader splits
 * a solid whose faces differ in colour into a material each and a highlight that replaced
 * only the first would leave half a part glowing. Only the parts batching refused can get
 * here, and those are exactly the ones with a material array.
 */
function cloneMaterial(
  source: Material | Material[],
  highlighted: HighlightMaterials,
  highlight: EmissiveHighlight,
): Material | Material[] {
  return Array.isArray(source)
    ? source.map((one) => highlighted.of(one, highlight))
    : highlighted.of(source, highlight);
}

/** A geometry's own box, computed once per BufferGeometry however many parts share it. */
function boxOf(geometry: BufferGeometry, cache: Map<BufferGeometry, Box3>): Box3 {
  const cached = cache.get(geometry);
  if (cached) return cached;
  if (geometry.boundingBox === null) geometry.computeBoundingBox();
  const box = geometry.boundingBox ? geometry.boundingBox.clone() : new Box3();
  cache.set(geometry, box);
  return box;
}

/** A part's local transform as a matrix, in the Euler order the file's own object was in. */
function composeLocalFrom(local: StoredLocalTransform, order: EulerOrder, out: Matrix4): Matrix4 {
  scratchEuler.set(local.rotation[0], local.rotation[1], local.rotation[2], order);
  scratchQuaternion.setFromEuler(scratchEuler);
  scratchPosition.set(local.position[0], local.position[1], local.position[2]);
  scratchScale.set(local.scale[0], local.scale[1], local.scale[2]);
  return out.compose(scratchPosition, scratchQuaternion, scratchScale);
}

const composeLocal = (record: PartRecord, out: Matrix4): Matrix4 =>
  composeLocalFrom(record.local, record.order, out);

/** How many objects buildSceneTree tagged, which is the number the threshold is about. */
function countTagged(root: Object3D): number {
  let count = 0;
  root.traverse((object) => {
    if (typeof object.userData?.modelId === 'string') count += 1;
  });
  return count;
}

/**
 * The registry one parsed model gets.
 *
 * The single decision point between the two implementations, and it lives here rather than in
 * lib/scene/sceneEntries.ts so that the threshold and the thing it chooses are in the same
 * file: a model at or above BATCH_MIN_PARTS is drawn as batches, and below it is drawn the
 * way it was parsed, one Object3D per part, with no merge pass and no second copy of its
 * geometry.
 *
 * Both answer the same PartRegistry, so nothing above this knows which it got — which is the
 * point of the seam stages 1 to 3 moved every consumer onto.
 */
export function partRegistryFor(root: Object3D, tree?: SceneNode | null): PartRegistry {
  return countTagged(root) >= BATCH_MIN_PARTS
    ? new BatchedPartRegistry(root, tree)
    : new MeshPartRegistry(root, tree);
}
