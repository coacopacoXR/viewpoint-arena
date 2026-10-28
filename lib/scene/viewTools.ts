// The room's view tools — a shared cut plane, and the explode that task 08b renders.
//
// ONE small pure module, and it is pure for the reason lib/scene/sceneWire.ts is: the
// room server validates what a browser sends and the browser validates what the room
// server relays, and two readers of one payload is two chances to disagree about what a
// number means. Nothing here imports three or party, so both sides can use it.
//
// WHY THE CUT IS SHARED RATHER THAN LOCAL. The user's decision, and it is the one the
// rest of the room's state already follows: a cut is something a meeting is looking at
// together. Somebody turns it on to show the flange inside a housing, and everybody in
// the room sees the same section — including whoever joins three minutes later, who is
// handed the current value the way they are handed the recording state.
//
// WHY `position` IS 0..1 AND NOT A WORLD COORDINATE. Two browsers can be looking at the
// same room with different models loaded, a model can be moved or resized while the cut
// is on, and a number in scene units would then mean something different on each screen
// — or would sit outside the model altogether and cut nothing. Normalised to the bounds
// of the models each client can actually see, "half way along X" is the same statement
// everywhere and survives the model moving. Each client resolves it with the bounds it
// already has (lib/scene/modelBounds.ts over the part registries), unexploded.

/** The world axis a cut plane is perpendicular to. */
export type CutAxis = 'x' | 'y' | 'z';

/** Every axis, in the order the control offers them. */
export const CUT_AXES: readonly CutAxis[] = ['x', 'y', 'z'];

/** One cut plane, as the room shares it. */
export interface CutPlane {
  /** World axis the plane is perpendicular to. */
  axis: CutAxis;
  /** 0..1 across the room's visible model bounds on `axis`. 0.5 is the middle of them. */
  position: number;
  /** Which side is cut away. False cuts the positive side, true the negative one. */
  flip: boolean;
}

/**
 * What the room is doing to its view.
 *
 * `explode` is wired all the way through the wire, the server and the store from task
 * 08a and rendered by task 08b, so that adding the rendering is a renderer change and
 * not a protocol one: a room with one client on 08b and one on 08a still agrees about
 * the cut, and the slider 08b adds needs no new message.
 */
export interface ViewTools {
  /** The cut, or null for no cut. */
  cut: CutPlane | null;
  /** 0..1, 0 = assembled. */
  explode: number;
}

/** What a room with nobody touching the view tools holds, and what it resets to. */
export const DEFAULT_VIEW_TOOLS: ViewTools = { cut: null, explode: 0 };

/** A fraction, clamped — or null for anything that is not a finite number. */
export function asUnit(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function asCutAxis(value: unknown): CutAxis | null {
  return typeof value === 'string' && (CUT_AXES as readonly string[]).includes(value)
    ? (value as CutAxis)
    : null;
}

/**
 * One cut plane, rebuilt — or null for anything this reader cannot use.
 *
 * Refused whole rather than field by field, which is the asymmetry
 * lib/scene/sceneWire.ts's `asSceneModel` uses for a model and `asPartTransform` for an
 * override: a cut is one statement about where the room is looking, and a payload whose
 * axis was readable but whose position was not would put the plane somewhere nobody
 * asked for it. The sender is still there to be told nothing happened.
 *
 * `position` is clamped and NaN is refused rather than clamped, because the two are
 * different failures: 1.4 is a slider somebody dragged past its end, while NaN is a
 * client that computed a bound from a model with no geometry in it — and a NaN that
 * reached a THREE.Plane's constant would make every fragment of every model compare
 * false and draw the room with no product in it.
 */
export function asCutPlane(value: unknown): CutPlane | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const axis = asCutAxis(record.axis);
  if (!axis) return null;
  const position = asUnit(record.position);
  if (position === null) return null;
  return { axis, position, flip: record.flip === true };
}

/**
 * The room's view tools, rebuilt — or null for anything this reader cannot use.
 *
 * Rebuilt rather than returned as received, so a field nobody wrote cannot ride into
 * room state or out to every other connection. `cut` and `explode` both fall back
 * rather than fail when they are simply ABSENT, which is what makes a payload from a
 * client that only knew about the cut still mean what it said, and a payload from one
 * that only knew about the explode still mean what IT said.
 */
export function asViewTools(value: unknown): ViewTools | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  // Absent and explicit null both read as "no cut"; anything else has to parse.
  const rawCut = record.cut;
  const cut = rawCut === undefined || rawCut === null ? null : asCutPlane(rawCut);
  if (cut === null && rawCut !== undefined && rawCut !== null) return null;
  const rawExplode = record.explode;
  const explode = rawExplode === undefined ? 0 : asUnit(rawExplode);
  if (explode === null) return null;
  return { cut, explode };
}

/**
 * Whether two view-tool states say the same thing.
 *
 * Field by field rather than by reference, because the store writes a fresh object for
 * every message it applies and a drag broadcasts a fresh one for every step of it: a
 * comparison on identity would have every relayed value look like a change, and
 * components/Scene/MotionQuality.tsx's `StoreDrivenFrames` asks for a frame on every
 * store write. Under `frameloop="demand"` that is the difference between a room that
 * redraws when somebody moves the cut and one that redraws when somebody sends the
 * value it already had.
 */
export function sameViewTools(a: ViewTools, b: ViewTools): boolean {
  if (a.explode !== b.explode) return false;
  if (a.cut === null || b.cut === null) return a.cut === b.cut;
  return a.cut.axis === b.cut.axis && a.cut.position === b.cut.position && a.cut.flip === b.cut.flip;
}
