// A live, read-only look at the model a design review would open on.
//
// docs/plan/15-sessions-and-variants.md batch BO. The lobby's preview panel has
// always shown a snapshot: a picture taken the last time somebody was in the room,
// which is no picture at all for a review that has never had one, and a stale one
// for a review whose model was replaced afterwards. "Turn in 3D" swaps that
// picture for this — the same models, standing where they were left, that a room
// opened on this review's own address would start from. The point of the batch is
// that somebody browsing the lobby can see what a design review looks like inside
// without going into it.
//
// The reference implementation is `showReviewScene` in lib/scene/showCurationModel.ts,
// and the scene this viewer builds is deliberately the same answer. THREE things
// differ, and all three follow from being outside a room:
//
//   1. It never touches store.ts. showReviewScene's whole job is to write the
//      shared scene so the room renders it; a lobby that has been scrolled past
//      twelve reviews must not leave twelve scenes behind in the room's global
//      state, and it has no room to leave them in. So the scene is computed into
//      this component's own state and thrown away, and nothing in THIS file reads or
//      writes a store. The one exception is a review whose model is one of the app's
//      three bundled samples, which is drawn by the room's own component for it — see
//      SAMPLE_COMPONENTS below for what those write and why it is safe.
//   2. It draws what the SCENE says is visible — `model.visible === true` — which
//      is store.ts's `sceneModelVisible` with no local overrides. Hiding a model so
//      you can see the one behind it is one participant's business and lives in the
//      room's store, which point 1 has just promised not to read.
//   3. It disposes what it parses. The room's `pruneSceneEntries` drops the
//      reference and stops, which is fine for a canvas that lives as long as the
//      page; this one mounts once per review and a lobby can be scrolled through
//      dozens in a session.
//
// The LOADERS are the room's, not a second set: lib/modelsClient.fetchModelFile
// (the same /api/models download, and the same in-memory cache, so a review the
// lobby has already looked at costs nothing the second time), lib/scene/
// sceneEntries.parseSceneModelFile (the same parse, with the same hash-derived tree
// prefix), and `placeImportedGroup` out of components/Scene/ImportedModel.tsx (the
// room's own centring and scaling). A viewer that parsed the bytes itself would
// agree with the room today and drift from it the first time utils/modelLoader.ts
// changed — and "the lobby shows what the room shows" is the entire claim.
//
// THIS FILE IS A React.lazy TARGET and nothing may import it any other way. It
// pulls in three.js, @react-three/fiber and @react-three/drei, and the lobby's
// first paint must not pay for them.

import React, { Suspense, useEffect, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  ContactShadows,
  Grid,
  OrbitControls,
  PerspectiveCamera,
} from '@react-three/drei';
import * as THREE from 'three';
import { Loader2 } from 'lucide-react';
import { loadCuration } from '../../lib/curationsRepo';
import { fetchModelFile } from '../../lib/modelsClient';
import {
  listModelRevisions,
  revisionsForSession,
  sceneFromRevisions,
} from '../../lib/reviews/revisionsRepo';
import { originRevisionIds } from '../../lib/reviews/linesRepo';
import { curationSceneModel } from '../../lib/scene/curationScene';
import { FRAME_FOV, applyFrame, frameBox } from '../../lib/scene/frameBox';
import { reviewModelBounds } from '../../lib/scene/modelBounds';
import { applyStoredPlacements } from '../../lib/scene/placement';
import { applyPartTransforms } from '../../lib/scene/partTransforms';
import { modelBox } from '../../lib/scene/partRegistry';
import {
  sceneModelLabel,
  sceneModelTransform,
  type BuiltInModel,
  type SceneModel,
} from '../../lib/scene/roomScene';
import { SAMPLE_MODELS } from '../../lib/scene/sampleModels';
import { parseSceneModelFile, type SceneModelEntry } from '../../lib/scene/sceneEntries';
import LightRig, {
  SCENE_TONE_MAPPING,
  SCENE_TONE_MAPPING_EXPOSURE,
} from '../Scene/LightRig';
import { placeImportedGroup } from '../Scene/ImportedModel';

// ─── The words ──────────────────────────────────────────────────────────────
//
// Exported for the same reason lib/modelsClient exports its messages: the preview
// panel and its tests have to be able to ask for the exact sentence rather than
// retype it, and a string two files spell separately is a string that eventually
// disagrees with itself.

/** While the review's scene is being read and its models downloaded and parsed. */
export const LOADING_MESSAGE = 'Loading the model…';
/** Nothing to draw: neither an imported model nor one of the app's bundled samples. */
export const NO_MODEL_MESSAGE = 'This design review has no model to show yet.';
/** The read threw, or every model this review named failed to load. */
export const LOAD_FAILED_MESSAGE = 'The model could not be loaded.';

/**
 * The camera's field of view. The fit rule itself — how far back to sit for a box to
 * fill a frame, and from what angle — is lib/scene/frameBox.ts's, shared with the
 * capture that takes the snapshot this button replaces. Two framings that differ would
 * make the live view and the picture of it two different compositions of one model.
 */
const CAMERA_FOV = FRAME_FOV;

/**
 * The room's own component for each of the app's three bundled samples, each behind a
 * React.lazy of its own.
 *
 * The room's and not a second copy: "the lobby shows what the room shows" is the whole
 * claim of this panel, and a sample redrawn here would agree with components/Scene/
 * Bicycle.tsx today and drift from it the first time that file changed. Lazy because a
 * sample fetches a GLB — the bicycle's is 3.3 MB — and the review being looked at has
 * either one sample or none of them. Importing the three statically would have every
 * "Turn in 3D" press in the lobby download all three, including for a review whose
 * model is an uploaded STEP file that has no use for any of them.
 *
 * These are the only files in the lobby's graph that DO reach store.ts, which point 1
 * of this file's header promises nothing here does: Product.tsx registers its knobs as
 * points of interest and the two GLB samples install their scene trees. Every one of
 * those writes is the one the room makes for the same sample, and all of them are
 * derived state a room recomputes from its own scene on open — none of them is a scene.
 * So the promise that matters, that looking at a review in the lobby cannot leave a
 * scene behind in the room, still holds; duplicating the presets to keep the import
 * graph pure would have been the worse trade.
 */
const SAMPLE_COMPONENTS: Partial<Record<BuiltInModel, React.LazyExoticComponent<React.ComponentType>>> = {
  synth: React.lazy(() => import('../Scene/Product')),
};

/** What a sample is called, from the one list that names them. */
function sampleLabel(sample: BuiltInModel): string {
  return SAMPLE_MODELS.find((one) => one.builtIn === sample)?.label ?? sample;
}

/**
 * Which of the app's three bundled samples a review's model type names, or null.
 *
 * Read off `SAMPLE_MODELS` rather than a literal list of three strings so the samples
 * this viewer can draw and the samples the room's menu offers cannot come apart.
 */
function sampleOf(modelType: string | null | undefined): BuiltInModel | null {
  const found = SAMPLE_MODELS.find((one) => one.builtIn === modelType);
  return found ? found.builtIn : null;
}

// ─── State ──────────────────────────────────────────────────────────────────

/** One model of the review's scene, parsed, placed, and measured. */
interface LoadedModel {
  model: SceneModel;
  entry: SceneModelEntry;
  /**
   * This model's box in WORLD space — its own geometry after placeImportedGroup,
   * with the wrapper transform the JSX below applies composed onto it.
   *
   * Measured here, in the load, and not by a component inside the canvas: by the
   * time anything renders, the group has a parent, and three's Box3.setFromObject
   * reads world matrices, so a box measured then would count the wrapper's offset
   * twice or not at all depending on whether R3F had put the wrapper in the scene
   * graph yet. Detached, the answer is exact and has no timing in it.
   */
  box: THREE.Box3;
}

/**
 * The five things the panel can be showing.
 *
 * One value rather than a `loading` flag beside a list, because the failure this
 * exists to prevent is the two disagreeing — a spinner over a canvas that has
 * nothing in it, or a "no model" message over one that has.
 *
 * `sample` is its own state and not a `ready` with an empty list: a bundled sample has
 * nothing this viewer parsed, placed or measured, so it has no box to frame with and no
 * group to dispose. What it has is the name of a component the room owns, which arrives
 * with its own geometry and its own loading.
 */
type ViewerState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'failed' }
  | { status: 'sample'; sample: BuiltInModel }
  | { status: 'ready'; loaded: LoadedModel[]; box: THREE.Box3 };

// ─── Disposal ───────────────────────────────────────────────────────────────

/**
 * A node in a parsed model's graph that owns something on the GPU.
 *
 * Read by shape rather than with `instanceof THREE.Mesh`, for two reasons: the
 * loaders answer LineSegments and Points as well as meshes and both hold a geometry
 * that has to be freed, and a test can hand back a plain object shaped like one
 * without dragging three's constructors into the assertion.
 */
interface DisposableNode extends THREE.Object3D {
  geometry?: { dispose?: () => void };
  material?: { dispose?: () => void } | Array<{ dispose?: () => void } | undefined>;
}

/**
 * Free the GPU memory one parsed model holds.
 *
 * `parseSceneModelFile` builds fresh three.js objects on every call — a group, and
 * a geometry and a material per mesh in it — and after this viewer unmounts nothing
 * else in the app owns any of them. The room gets away without this because its
 * canvas lives as long as the page and its store's prune is just a dropped
 * reference; the lobby mounts a viewer per review, so a session spent scrolling the
 * lobby would otherwise hold every model it looked at.
 *
 * Textures are deliberately NOT disposed. utils/modelLoader's convertToStandardMaterial
 * copies `map`, `normalMap` and `alphaMap` across by reference, so one texture can
 * be sampled by two materials in the same file — and freeing a texture something is
 * still sampling shows up as black geometry far away from the code that caused it.
 */
function disposeGroup(group: THREE.Object3D): void {
  group.traverse((child) => {
    const node = child as DisposableNode;
    node.geometry?.dispose?.();
    const material = node.material;
    if (Array.isArray(material)) {
      for (const one of material) one?.dispose?.();
    } else {
      material?.dispose?.();
    }
  });
}

// ─── Which models, and where ────────────────────────────────────────────────

/**
 * The scene this review would open a room on.
 *
 * showReviewScene's arithmetic, transplanted: the review's whole stored history,
 * narrowed to the revisions its MAIN LINE was last looking at, plus the curation's
 * own model when history has never recorded it (every review created before the
 * model_revisions table existed), with the review's stored placements applied over
 * the beside-each-other default the history computes.
 *
 * The line id is null and always will be here: the lobby has no line to be on, and
 * a room opened on the review's own address starts from the main line, which is
 * exactly what `originRevisionIds(reviewId, null)` answers.
 *
 * With no stored history at all this reduces to the one-model scene
 * `curationScene` builds — sceneFromRevisions([], unrecorded) keeps the unrecorded
 * model as its line's Rev A — so there is no second code path for a review that has
 * never had a meeting.
 *
 * ONE PLACE THIS IS NOT showReviewScene, and it is on purpose. showReviewScene is
 * only ever called for an asset whose `modelType` is 'imported' — see syncMainModel
 * in lib/activeReviewStore.ts, which returns early for 'none' and for a preset — so
 * it never has to ask what the other model types mean. This viewer does, and the
 * answer it must not give is "nothing": since batch BI every review the lobby
 * creates carries modelType 'none', including one whose meeting imported four
 * models and recorded all four. Gating on modelType the way the room's caller does
 * would have shown an empty panel for exactly the reviews worth looking into. So
 * the gate here is whether the review has any imported model to draw at all, from
 * its history or from its asset, and `modelType` is not read as a gate.
 *
 * IT IS READ AS A SAMPLE, though, and that is the second half of the room's rule. A
 * room opens a review by handing the asset to showCurationModel, which answers false
 * for anything but 'imported'; lib/activeReviewStore's syncMainModel then calls
 * setActiveModelType(asset.modelType), and the store turns that into `scene.builtIn`,
 * which is what World.tsx draws one of its three presets from. So for a review whose
 * model IS a sample, `modelType` is the whole of the answer and the scene record has
 * nothing to say — sceneFromRevisions always answers `builtIn: null`, because a
 * sample has no revisions and no row in model_revisions. Hence `sampleOf` below,
 * reading the same field the room reads, and `scene.builtIn` kept as the first answer
 * so a history that ever did record a sample is honoured too.
 */
async function reviewSceneFor(reviewId: string): Promise<{
  models: SceneModel[];
  sample: BuiltInModel | null;
}> {
  const draft = await loadCuration(reviewId);
  const asset = draft?.asset;

  const [revisions, origin] = await Promise.all([
    listModelRevisions(reviewId),
    originRevisionIds(reviewId, null),
  ]);

  const unrecorded =
    asset?.modelHash && asset.importedFileName
      ? curationSceneModel(asset.modelHash, asset.importedFileName)
      : null;

  const scene = applyStoredPlacements(
    sceneFromRevisions(revisionsForSession(revisions, origin), unrecorded),
    asset?.placements,
  );

  return { models: scene.models, sample: scene.builtIn ?? sampleOf(asset?.modelType) };
}

/**
 * This model's world box, measured while its group is still detached.
 *
 * Through the entry's part registry rather than straight off the group, for the reason
 * `modelBox` gives: a box measured by walking geometry is a box of the wrong thing once
 * a part is a slot in a batch.
 *
 * The wrapper matrix is composed by hand from `sceneModelTransform` rather than read
 * off a group in the canvas, so it is the same numbers the JSX below is given: a
 * model written before Move / Rotate / Scale existed has no rotation and no scale
 * field, and sceneModelTransform is the one place that says what absent means.
 */
function measure(model: SceneModel, entry: SceneModelEntry): THREE.Box3 {
  const box = modelBox(entry.group, entry.partRegistry, new THREE.Box3());
  if (box.isEmpty()) return box;
  const transform = sceneModelTransform(model);
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(transform.offset),
    new THREE.Quaternion().setFromEuler(
      new THREE.Euler(transform.rotation[0], transform.rotation[1], transform.rotation[2]),
    ),
    new THREE.Vector3().setScalar(transform.scale),
  );
  return box.applyMatrix4(matrix);
}

/** The box around everything this viewer is about to draw. */
function contentBox(loaded: readonly LoadedModel[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const one of loaded) {
    if (!one.box.isEmpty()) box.union(one.box);
  }
  return box;
}

// ─── Framing ────────────────────────────────────────────────────────────────

/**
 * The part of drei's OrbitControls framing touches.
 *
 * Named rather than imported, which is what components/Scene/ReviewModelGizmo.tsx
 * does for the same reason: R3F types `state.controls` as a bare
 * THREE.EventDispatcher, and all framing needs is where the controls are looking and
 * a nudge to apply it.
 */
interface OrbitLike extends THREE.EventDispatcher {
  target: THREE.Vector3;
  update: () => void;
}

/**
 * Point the controls at `center`, if what R3F handed us has a target to point.
 *
 * Guarded rather than assumed because `makeDefault` publishes the controls a render
 * later than the canvas that asked for them, and a viewer whose model landed before
 * its controls did would otherwise throw inside an effect and take the whole canvas
 * with it.
 */
function retarget(controls: THREE.EventDispatcher | null, center: THREE.Vector3): void {
  const orbit = controls as OrbitLike | null;
  if (!orbit || !orbit.target || typeof orbit.update !== 'function') return;
  orbit.target.copy(center);
  orbit.update();
}

/**
 * Put the camera far enough back that everything drawn fits, looking at its middle.
 *
 * A child of the canvas because it needs R3F's camera and controls, and an effect
 * rather than a component because it has nothing to draw. It runs once per set of
 * models and then leaves the camera alone: this is a read-only view, and a viewer
 * that kept re-framing would fight whoever is dragging it.
 *
 * The box is the one the load measured with the models detached, so it is exact — see
 * LoadedModel.box. How far back to sit for it is lib/scene/frameBox's answer, which is
 * also the thumbnail capture's, so the snapshot and this view are the same composition.
 */
const FrameToContent: React.FC<{ box: THREE.Box3 }> = ({ box }) => {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls);

  useEffect(() => {
    // The only camera this viewer mounts is a perspective one, so anything else is a
    // canvas that has not published its camera yet — the same late-by-a-render case
    // `retarget` guards.
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    const framed = frameBox(box, camera.fov);
    if (!framed) return;
    applyFrame(camera, framed);
    retarget(controls, framed.target);
  }, [box, camera, controls]);

  return null;
};

/**
 * The same framing, for a bundled sample — asked of the canvas rather than computed
 * before it.
 *
 * A sample's geometry is not this viewer's to measure: components/Scene/Bicycle.tsx
 * suspends on a 3.3 MB GLB, scales it to a target size and drops it on the floor once
 * it has landed, and all of that happens inside a component the room owns. So there is
 * no box to hand in, and the honest answer is to wait for the scene graph and measure
 * what the room's own `userData.modelId` marker says is the product — the same
 * measurement lib/reviews/thumbnail.ts frames its snapshot with, which is what makes a
 * sample's snapshot and its live view match.
 *
 * A frame callback that stops after its first success rather than an effect, because
 * there is nothing to be notified by: useGLTF resolves into a Suspense boundary that
 * this component is a sibling of, so no prop or state of this viewer's changes when the
 * bicycle arrives. Polling costs one bounding-box walk per frame until it does, and
 * nothing at all after.
 */
const FrameToSample: React.FC = () => {
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls);
  const framed = useRef(false);

  useFrame(() => {
    if (framed.current) return;
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    const view = frameBox(reviewModelBounds(scene), camera.fov);
    if (!view) return;
    framed.current = true;
    applyFrame(camera, view);
    retarget(controls, view.target);
  });

  return null;
};

/**
 * One of the app's bundled samples, drawn by the room's own component for it.
 *
 * Suspended because the two GLB samples fetch their file, and the fallback is nothing:
 * an empty stage with a grid on it, which is what the room itself shows for the moment
 * a sample takes to arrive.
 */
const SampleModel: React.FC<{ sample: BuiltInModel }> = ({ sample }) => {
  const Component = SAMPLE_COMPONENTS[sample];
  if (!Component) return null;
  return (
    <Suspense fallback={null}>
      <Component />
    </Suspense>
  );
};

// ─── The panel ──────────────────────────────────────────────────────────────

export interface ReviewModelViewerProps {
  /** The design review to look inside. Changing it reloads and frees the last one. */
  reviewId: string;
  /** Extra classes for the panel, so the preview can size it. */
  className?: string;
}

/**
 * The live viewer the lobby's "Turn in 3D" swaps in for the snapshot.
 *
 * Read-only in the strictest sense available: it draws the review's models and
 * changes nothing about them. There is no import, no hide, no gizmo and no socket —
 * somebody who is not even a participant in this design review can look at it, and
 * looking must not be able to move anything.
 */
const ReviewModelViewer: React.FC<ReviewModelViewerProps> = ({ reviewId, className }) => {
  const [state, setState] = useState<ViewerState>({ status: 'loading' });

  useEffect(() => {
    // Set by the teardown below and checked after every await. A load that finishes
    // after this viewer is gone — because the person scrolled to another review, or
    // closed the preview — must not setState on a component React has already
    // unmounted. React 18 stopped warning about that, but the state is dead either
    // way, and the group it parsed would leak: nothing would ever dispose it,
    // because the teardown that would have already ran.
    let cancelled = false;
    // Every group this load has parsed and not yet handed to React. The teardown
    // disposes the lot, and anything parsed AFTER the teardown is disposed at the
    // point it is noticed — between those two, no parsed group can outlive this
    // effect.
    const owned: THREE.Object3D[] = [];

    /**
     * Download and parse one model, and place it the way the room places it.
     *
     * Answers null for a model that failed, so one review whose Rev C was deleted
     * from model storage still shows Rev A and Rev B beside it rather than showing
     * nothing at all.
     */
    const loadOne = async (model: SceneModel): Promise<LoadedModel | null> => {
      try {
        const file = await fetchModelFile(model.hash, model.fileName);
        if (cancelled) return null;
        const entry = await parseSceneModelFile(model, file);
        if (cancelled) {
          // Parsed while the teardown was running. It is ours and nothing will ever
          // render it, so free it here rather than adding it to a list nobody reads.
          disposeGroup(entry.group);
          return null;
        }
        owned.push(entry.group);
        // The room's own centring and scaling, applied once here rather than in an
        // effect like SceneModelView's: that one has to re-run because its entry
        // arrives from a global store into a group R3F may re-parent, and this group
        // is owned by this effect from the moment it is parsed to the moment it is
        // disposed. Doing it before React has seen the object is also what makes
        // `measure` below exact — see LoadedModel.box.
        placeImportedGroup(
          entry.group,
          entry.scale * entry.baseScale,
          entry.basePosition,
          entry.partRegistry ?? null,
        );
        // The parts somebody pulled apart in the room's Edit mode, batch BR. Applied
        // here as well as in SceneModelView because this viewer draws the review's own
        // scene — `reviewSceneFor` above has already put the review's stored placements
        // over it, and `parts` rides inside those — and a preview that showed the
        // assembly closed when the meeting had left it open would be a different
        // product from the one the review is about.
        //
        // Before `measure`, so the frame is composed around the model as it actually
        // stands: a part dragged out to show a clearance is exactly the part that would
        // otherwise be cut off by a box measured on the file's own geometry.
        if (entry.partRegistry) {
          applyPartTransforms(entry.partRegistry, entry.sceneTree.id, model.parts);
        }
        return { model, entry, box: measure(model, entry) };
      } catch (error) {
        console.error(`[lobby] could not load ${model.fileName} (${model.hash}):`, error);
        return null;
      }
    };

    const run = async (): Promise<void> => {
      const { models, sample } = await reviewSceneFor(reviewId);
      if (cancelled) return;

      // A model with no hash has nothing to fetch — that is the legacy marker
      // lib/scene/curationScene.ts mints for a draft whose bytes were never
      // uploaded, and lib/scene/useSceneModelLoader.ts skips it for the same reason.
      const wanted = models.filter((model) => model.visible === true && model.hash !== '');
      if (wanted.length === 0) {
        // Batch BP. A review whose model is one of the app's bundled samples — the
        // synth assembly, the headphones, the bicycle — used to say it had no model to
        // show, because those are React components in the room's scene graph and not a
        // hash in model storage. It now draws the sample, with the room's own component
        // for it, which is the same answer the room gives: store.ts's activeModelTypeFor
        // prefers imported models and falls back to the sample, so a review with both
        // shows its models here exactly as it does there. Only a review with neither
        // gets the sentence.
        setState(sample ? { status: 'sample', sample } : { status: 'empty' });
        return;
      }

      const results = await Promise.all(wanted.map(loadOne));
      if (cancelled) return;
      const loaded = results.filter((one): one is LoadedModel => one !== null);
      if (loaded.length === 0) {
        // Everything it named failed: a storage bucket that is not configured, a
        // deployment whose /api/models is behind a login this session is not through.
        setState({ status: 'failed' });
        return;
      }
      setState({ status: 'ready', loaded, box: contentBox(loaded) });
    };

    run().catch((error) => {
      // The scene read itself threw — loadCuration does not catch, so a database
      // that is unreachable rejects here. A preview panel that crashed the lobby
      // would be worse than one that says it could not load.
      console.error('[lobby] could not read the review to preview:', error);
      if (!cancelled) setState({ status: 'failed' });
    });

    return () => {
      cancelled = true;
      for (const group of owned) disposeGroup(group);
      owned.length = 0;
    };
  }, [reviewId]);

  const names =
    state.status === 'ready'
      ? state.loaded.map(({ model }) => sceneModelLabel(model)).join(', ')
      : state.status === 'sample'
        ? sampleLabel(state.sample)
        : '';

  return (
    <div
      className={`flex flex-col bg-white rounded-lg border border-gray-200 overflow-hidden ${className ?? ''}`}
      data-testid="review-model-viewer"
    >
      <div className="flex-shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-b border-gray-100 bg-gray-50/60">
        <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest">
          Inside this design review
        </p>
        {names && (
          <p className="font-mono text-[9px] text-gray-400 truncate" title={names}>
            {names}
          </p>
        )}
      </div>

      {/* The canvas is mounted only once there is something in it: a review with no
          model gets a sentence, not a WebGL context nobody is going to draw into. */}
      <div className="relative flex-1 min-h-[220px]">
        {state.status === 'loading' && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white"
            role="status"
          >
            <Loader2 size={18} className="animate-spin text-gray-300" />
            <p className="text-[11px] text-gray-500">{LOADING_MESSAGE}</p>
          </div>
        )}

        {state.status === 'empty' && (
          <div className="absolute inset-0 flex items-center justify-center bg-white px-4">
            <p className="text-[11px] font-mono italic text-gray-300 text-center" role="status">
              {NO_MODEL_MESSAGE}
            </p>
          </div>
        )}

        {state.status === 'failed' && (
          <div className="absolute inset-0 flex items-center justify-center bg-white px-4">
            <p className="text-[11px] font-mono italic text-gray-300 text-center" role="status">
              {LOAD_FAILED_MESSAGE}
            </p>
          </div>
        )}

        {(state.status === 'ready' || state.status === 'sample') && (
          <Canvas
            dpr={[1, 2]}
            gl={{
              antialias: true,
              alpha: true,
              // The room's tone mapping, from the one constant the room also uses: a
              // preview that graded its colours differently from the meeting it is a
              // preview of would be two opinions about the same product, and this panel
              // exists to answer "what does that design review look like inside".
              toneMapping: SCENE_TONE_MAPPING,
              toneMappingExposure: SCENE_TONE_MAPPING_EXPOSURE,
            }}
            aria-label="Live view of the model this design review would open on"
          >
            <PerspectiveCamera
              makeDefault
              fov={CAMERA_FOV}
              position={[3.2, 2.4, 3.2]}
              near={0.05}
              far={400}
            />

            {/* The room's own light rig, rather than the second arrangement this panel
                used to have. The grid, the floor shadow and the framing stay this
                file's: they belong to the stage, and this stage is smaller. */}
            <LightRig />

            <Grid
              infiniteGrid
              fadeDistance={12}
              fadeStrength={1.5}
              sectionSize={1}
              cellSize={0.5}
              sectionColor="#cccccc"
              cellColor="#e5e5e5"
              position={[0, -0.01, 0]}
            />

            {state.status === 'ready' &&
              state.loaded.map(({ model, entry }) => {
                // The room's own transform for this model, applied to the WRAPPER and
                // not to the geometry inside it: placeImportedGroup has already scaled
                // and centred that group, and scaling it again would scale the centring
                // with it and slide the model off its own origin.
                const transform = sceneModelTransform(model);
                return (
                  <group
                    key={model.id}
                    position={transform.offset}
                    rotation={transform.rotation}
                    scale={transform.scale}
                  >
                    <primitive object={entry.group} />
                  </group>
                );
              })}

            {/* A review whose model is one of the app's three bundled samples, drawn by
                the room's own component for it. On the same stage as an imported model —
                the same lights, grid, floor shadow and controls — because it is the same
                room seen from outside, and a sample in a bare canvas would be a second
                way of drawing a design review that could drift from the first. */}
            {state.status === 'sample' && <SampleModel sample={state.sample} />}

            <ContactShadows
              opacity={0.35}
              scale={10}
              blur={1.6}
              far={1.2}
              resolution={256}
              color="#000000"
            />

            {/* Orbit and zoom, and nothing else: panning moves the model off the
                stage a fixed frame was composed around, and there is no edit here
                for a drag to be mistaken for. */}
            <OrbitControls makeDefault enablePan={false} enableDamping dampingFactor={0.12} />

            {state.status === 'ready' ? (
              <FrameToContent box={state.box} />
            ) : (
              <FrameToSample />
            )}
          </Canvas>
        )}
      </div>

      <div className="flex-shrink-0 px-3 py-1.5 border-t border-gray-100">
        <p className="font-mono text-[9px] text-gray-400 uppercase tracking-widest">
          Drag to turn it · this preview cannot change the review
        </p>
      </div>
    </div>
  );
};

export default ReviewModelViewer;
