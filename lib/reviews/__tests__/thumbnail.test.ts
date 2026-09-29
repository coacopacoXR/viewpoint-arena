// Tests for lib/reviews/thumbnail.ts — the picture the lobby shows of a design
// review: how big it is allowed to be, what a capture that will not fit does,
// the order the room's frame is rendered and read in, and what the write to the
// review's row looks like (docs/plan/15-sessions-and-variants.md batch BO).
//
// No canvas here is a real one. jsdom ships NO canvas 2D implementation — a
// `document.createElement('canvas').getContext('2d')` answers null — which is
// exactly why the helper takes its offscreen canvas from a `CanvasFactory`
// argument instead of calling createElement itself. Everything below is therefore
// plain objects standing in for a canvas, a 2D context and a WebGLRenderer, and
// what gets pinned is the arithmetic, the refusals and the order of the calls.
//
// Supabase is faked the way lib/reviews/__tests__/revisionsRepo.test.ts fakes it,
// and for the same reason: what is worth knowing about the write is its SHAPE —
// one update, of one column, filtered to one row — and what the module answers
// when the database says no, or when there is no database at all.

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Answer {
  data: unknown;
  error: { code?: string; message?: string } | null;
  throws?: Error;
}

const { calls, froms, answers, configured } = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; op: string; args: unknown[] }>,
  froms: [] as string[],
  answers: new Map<string, Answer>(),
  // A getter in the mock below reads this, so one file can cover both an install
  // with a database and the default self-hosted one that has none.
  configured: { value: true },
}));

interface QueryChain extends Promise<Answer> {
  update: (...args: unknown[]) => QueryChain;
  eq: (...args: unknown[]) => QueryChain;
  select: (...args: unknown[]) => QueryChain;
}

function queryChain(table: string): QueryChain {
  const step =
    (op: string) =>
    (...args: unknown[]): QueryChain => {
      calls.push({ table, op, args });
      const configuredAnswer = answers.get(table);
      if (configuredAnswer?.throws) throw configuredAnswer.throws;
      return queryChain(table);
    };
  const answer = answers.get(table) ?? { data: null, error: null };
  return Object.assign(Promise.resolve(answer), {
    update: step('update'),
    eq: step('eq'),
    select: step('select'),
  });
}

vi.mock('../../supabase', () => ({
  supabase: {
    from: (table: string) => {
      froms.push(table);
      return queryChain(table);
    },
  },
  get supabaseConfigured() {
    return configured.value;
  },
}));

import * as THREE from 'three';
import { FRAME_FOV } from '../../scene/frameBox';
import {
  THUMBNAIL_MAX_BYTES,
  THUMBNAIL_MAX_HEIGHT,
  THUMBNAIL_MAX_WIDTH,
  THUMBNAIL_QUALITY,
  captureCameraFor,
  captureRoomThumbnail,
  downscaleJpeg,
  fitsThumbnailBudget,
  saveReviewThumbnail,
  thumbnailSize,
  type CanvasFactory,
  type ThumbnailCanvas,
  type ThumbnailContext,
  type ThumbnailRenderer,
} from '../thumbnail';

const REVIEW = 'review-1';

/** A capture that fits, the way a real 480x270 JPEG at quality 0.7 does. */
const JPEG = `data:image/jpeg;base64,${'A'.repeat(1000)}`;

/** One character over the budget, in the payload rather than in the envelope. */
const TOO_BIG = `data:image/jpeg;base64,${'A'.repeat(THUMBNAIL_MAX_BYTES + 1)}`;

/** Exactly at the budget, which still fits. */
const AT_THE_LIMIT = `data:image/jpeg;base64,${'A'.repeat(THUMBNAIL_MAX_BYTES)}`;

interface FactoryStub {
  factory: CanvasFactory;
  /** The [width, height] of every canvas the helper asked for. */
  sizes: number[][];
  /** Every drawImage call, as the arguments it was handed. */
  draws: unknown[][];
  /** Every toDataURL call, as [type, quality]. */
  encodes: Array<[string, number]>;
}

/**
 * A stand-in for `document.createElement('canvas')` and its 2D context, recording
 * what the helper did with both. `context: null` is the browser being out of
 * contexts; `throws` is a canvas that will not give up its pixels.
 */
function stubFactory(
  options: { dataUrl?: string; context?: ThumbnailContext | null; throws?: Error } = {},
): FactoryStub {
  const sizes: number[][] = [];
  const draws: unknown[][] = [];
  const encodes: Array<[string, number]> = [];
  const dataUrl = options.dataUrl ?? JPEG;

  const recording: ThumbnailContext = {
    drawImage: (image, dx, dy, dw, dh) => {
      draws.push([image, dx, dy, dw, dh]);
    },
  };
  const context = options.context === null ? null : (options.context ?? recording);

  const factory: CanvasFactory = (width, height) => {
    sizes.push([width, height]);
    const canvas: ThumbnailCanvas = {
      width,
      height,
      toDataURL: (type: string, quality: number) => {
        encodes.push([type, quality]);
        if (options.throws) throw options.throws;
        return dataUrl;
      },
    };
    return { canvas, context };
  };

  return { factory, sizes, draws, encodes };
}

/** The room's canvas, as a WebGLRenderer's domElement looks to this file. */
function source(width: number, height: number): ThumbnailCanvas {
  return { width, height, toDataURL: () => JPEG };
}

/**
 * A room's scene as the capture has to see it.
 *
 * Real three.js objects and no WebGL, because what is under test is the framing
 * arithmetic and the refusals. One part carries `userData.modelId` — the room's own
 * marker for the product, stamped by utils/modelLoader on everything it parses and by
 * components/Scene/Product.tsx on each of the synth's part groups — and sits on a floor
 * forty times its width that does not. A 2x1x1 box at the origin, so the answer has a
 * known size and a known middle to aim at.
 */
function roomScene(): THREE.Scene {
  const scene = new THREE.Scene();

  const model = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1), new THREE.MeshBasicMaterial());
  model.userData.modelId = 'bracket';
  scene.add(model);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial());
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.5;
  scene.add(floor);

  return scene;
}

beforeEach(() => {
  calls.length = 0;
  froms.length = 0;
  answers.clear();
  configured.value = true;
  vi.restoreAllMocks();
});

// ─── thumbnailSize ──────────────────────────────────────────────────────────

describe('thumbnailSize', () => {
  it('pins the limits the lobby reads its cards at', () => {
    expect(THUMBNAIL_MAX_WIDTH).toBe(480);
    expect(THUMBNAIL_MAX_HEIGHT).toBe(270);
    expect(THUMBNAIL_QUALITY).toBe(0.7);
    expect(THUMBNAIL_MAX_BYTES).toBe(60 * 1024);
  });

  it('scales a room-sized canvas down to the maximum, keeping 16:9', () => {
    expect(thumbnailSize(1920, 1080)).toEqual({ width: 480, height: 270 });
  });

  it('keeps the aspect ratio of a canvas that is not 16:9', () => {
    // A square window is limited by the HEIGHT, so the width comes down with it
    // rather than filling 480 and cropping the scene.
    expect(thumbnailSize(1000, 1000)).toEqual({ width: 270, height: 270 });
    // A tall one is limited by the width.
    expect(thumbnailSize(800, 1600)).toEqual({ width: 135, height: 270 });
  });

  it('never upscales, because a small canvas has no more pixels to give', () => {
    expect(thumbnailSize(200, 100)).toEqual({ width: 200, height: 100 });
    expect(thumbnailSize(1, 1)).toEqual({ width: 1, height: 1 });
    // Exactly at the maximum is copied, not enlarged or shrunk.
    expect(thumbnailSize(480, 270)).toEqual({ width: 480, height: 270 });
  });

  it('answers 0x0 for a canvas with no area, so the caller writes nothing', () => {
    expect(thumbnailSize(0, 1080)).toEqual({ width: 0, height: 0 });
    expect(thumbnailSize(1920, 0)).toEqual({ width: 0, height: 0 });
    expect(thumbnailSize(-4, -4)).toEqual({ width: 0, height: 0 });
    // A renderer read before it sized itself hands over NaN, not 0.
    expect(thumbnailSize(Number.NaN, 1080)).toEqual({ width: 0, height: 0 });
    expect(thumbnailSize(1920, Number.NaN)).toEqual({ width: 0, height: 0 });
    expect(thumbnailSize(Number.POSITIVE_INFINITY, 1080)).toEqual({ width: 0, height: 0 });
  });

  it('answers 0x0 for a maximum that cannot be used', () => {
    expect(thumbnailSize(1920, 1080, 0, 270)).toEqual({ width: 0, height: 0 });
    expect(thumbnailSize(1920, 1080, 480, Number.NaN)).toEqual({ width: 0, height: 0 });
  });

  it('honours a smaller maximum, so a caller can ask for a tinier picture', () => {
    expect(thumbnailSize(1920, 1080, 240, 135)).toEqual({ width: 240, height: 135 });
  });

  it('keeps at least one pixel on an extreme aspect ratio', () => {
    // A 1000x1 sliver still has a picture in it, and a 0 would read to the caller
    // as "there is no thumbnail at all".
    expect(thumbnailSize(1000, 1)).toEqual({ width: 480, height: 1 });
  });
});

// ─── fitsThumbnailBudget ────────────────────────────────────────────────────

describe('fitsThumbnailBudget', () => {
  it('counts the base64 payload and not the envelope around it', () => {
    // 23 characters of `data:image/jpeg;base64,` on top of a payload that is
    // exactly at the budget: still fits, because the envelope is not picture.
    expect(fitsThumbnailBudget(AT_THE_LIMIT)).toBe(true);
    expect(AT_THE_LIMIT.length).toBeGreaterThan(THUMBNAIL_MAX_BYTES);
  });

  it('refuses a payload one character over', () => {
    expect(fitsThumbnailBudget(TOO_BIG)).toBe(false);
    expect(fitsThumbnailBudget(JPEG)).toBe(true);
  });

  it('honours a maximum the caller chose', () => {
    expect(fitsThumbnailBudget(JPEG, 10)).toBe(false);
    expect(fitsThumbnailBudget(JPEG, 1000)).toBe(true);
    // A nonsense maximum falls back to the real one rather than refusing
    // everything or accepting everything.
    expect(fitsThumbnailBudget(JPEG, Number.NaN)).toBe(true);
    expect(fitsThumbnailBudget(TOO_BIG, 0)).toBe(false);
  });

  it('refuses what a browser answers for a canvas it could not encode', () => {
    expect(fitsThumbnailBudget('')).toBe(false);
    expect(fitsThumbnailBudget('data:,')).toBe(false);
    expect(fitsThumbnailBudget('data:image/jpeg;base64,')).toBe(false);
  });

  it('refuses a string that is not a data URL at all', () => {
    expect(fitsThumbnailBudget('/thumbnails/review-1.jpg')).toBe(false);
    expect(fitsThumbnailBudget('https://example.com/a.jpg')).toBe(false);
    // A caller reading a column of an older row can hand over anything, and this
    // tsconfig has no strictNullChecks so nothing stops it at the type level.
    expect(fitsThumbnailBudget(undefined)).toBe(false);
    expect(fitsThumbnailBudget(null)).toBe(false);
  });
});

// ─── downscaleJpeg ──────────────────────────────────────────────────────────

describe('downscaleJpeg', () => {
  it('draws the source into a canvas of the downscaled size and asks for a JPEG', () => {
    const stub = stubFactory();
    const canvas = source(1920, 1080);

    const result = downscaleJpeg(canvas, stub.factory);

    // The factory is asked for the scaled size, not for the source's own —
    // allocating a 1920x1080 canvas to throw most of it away is the expensive
    // version of this.
    expect(stub.sizes).toEqual([[480, 270]]);
    expect(stub.draws).toEqual([[canvas, 0, 0, 480, 270]]);
    expect(stub.encodes).toEqual([['image/jpeg', THUMBNAIL_QUALITY]]);
    expect(result).toBe(JPEG);
  });

  it('passes a quality the caller chose through to the encoder', () => {
    const stub = stubFactory();

    expect(downscaleJpeg(source(1920, 1080), stub.factory, 0.4)).toBe(JPEG);
    expect(stub.encodes).toEqual([['image/jpeg', 0.4]]);
  });

  it('asks for a canvas of the source size when the source is already small', () => {
    const stub = stubFactory();

    downscaleJpeg(source(200, 100), stub.factory);

    expect(stub.sizes).toEqual([[200, 100]]);
    expect(stub.draws).toEqual([
      [expect.objectContaining({ width: 200, height: 100 }), 0, 0, 200, 100],
    ]);
  });

  it('returns null for a source with no area, without asking for a canvas', () => {
    const stub = stubFactory();

    expect(downscaleJpeg(source(0, 0), stub.factory)).toBeNull();
    expect(downscaleJpeg(source(1920, 0), stub.factory)).toBeNull();

    // No allocation, no draw, no encode: a degenerate source is refused before
    // any of it is attempted.
    expect(stub.sizes).toEqual([]);
    expect(stub.draws).toEqual([]);
    expect(stub.encodes).toEqual([]);
  });

  it('returns null when the browser gives no 2D context', () => {
    const stub = stubFactory({ context: null });

    expect(downscaleJpeg(source(1920, 1080), stub.factory)).toBeNull();
    // The canvas was allocated and then could not be drawn into, so nothing is
    // encoded and nothing is returned.
    expect(stub.encodes).toEqual([]);
  });

  it('returns null for an empty or unencoded answer rather than storing it', () => {
    expect(downscaleJpeg(source(1920, 1080), stubFactory({ dataUrl: '' }).factory)).toBeNull();
    expect(downscaleJpeg(source(1920, 1080), stubFactory({ dataUrl: 'data:,' }).factory)).toBeNull();
  });

  it('returns null for a capture that came out over the budget', () => {
    const stub = stubFactory({ dataUrl: TOO_BIG });

    expect(downscaleJpeg(source(1920, 1080), stub.factory)).toBeNull();
    expect(stub.encodes).toEqual([['image/jpeg', THUMBNAIL_QUALITY]]);
  });

  it('returns null instead of throwing when the canvas refuses its pixels', () => {
    // A tainted canvas throws on toDataURL; a very large one can throw on the
    // allocation. The room stays open either way.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub = stubFactory({ throws: new Error('tainted canvases may not be exported') });

    expect(downscaleJpeg(source(1920, 1080), stub.factory)).toBeNull();
    expect(error).toHaveBeenCalled();
  });

  it('returns null instead of throwing when drawImage itself throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const throwing: ThumbnailContext = {
      drawImage: () => {
        throw new Error('InvalidStateError');
      },
    };

    expect(downscaleJpeg(source(1920, 1080), stubFactory({ context: throwing }).factory)).toBeNull();
    expect(error).toHaveBeenCalled();
  });

  it('returns null for no source at all, which a caller can hand over from a ref', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(downscaleJpeg(null, stubFactory().factory)).toBeNull();
  });
});

// ─── captureRoomThumbnail ───────────────────────────────────────────────────

describe('captureRoomThumbnail', () => {
  /**
   * A fake renderer whose render and whose canvas encode both write into ONE
   * array, so a test can assert the order they happened in. The order is the
   * whole point: without `preserveDrawingBuffer` the buffer is undefined once the
   * frame has been composited, so a read that does not immediately follow the
   * render is a black rectangle.
   *
   * It starts in the state the room's own frame loop leaves a renderer in —
   * `autoClear` off, because components/Scene/ViewpointCanvas.tsx clears by hand so
   * its split-screen view can draw two halves into one buffer — and records what the
   * capture did to it, including what `autoClear` was at the moment of the render.
   */
  function stubRenderer(
    options: { width?: number; height?: number; dataUrl?: string; ratio?: number } = {},
  ) {
    const order: string[] = [];
    const scene = roomScene();
    const renders: unknown[][] = [];
    const viewports: number[][] = [];
    const scissors: number[][] = [];
    const scissorTests: boolean[] = [];
    const clearedDuringRender: boolean[] = [];
    let autoClear = false;
    const stub = stubFactory({ dataUrl: options.dataUrl });

    const domElement: ThumbnailCanvas = {
      width: options.width ?? 1920,
      height: options.height ?? 1080,
      toDataURL: () => JPEG,
    };
    // The helper reads the RENDERER's canvas, not the offscreen one, so the
    // encode it records is the offscreen one's — which is where the read happens.
    const wrapped: CanvasFactory = (width, height) => {
      const made = stub.factory(width, height);
      return {
        canvas: {
          ...made.canvas,
          toDataURL: (type: string, quality: number) => {
            order.push('toDataURL');
            return made.canvas.toDataURL(type, quality);
          },
        },
        context: made.context,
      };
    };

    const gl: ThumbnailRenderer = {
      get autoClear() {
        return autoClear;
      },
      set autoClear(value: boolean) {
        autoClear = value;
      },
      render: (renderedScene: unknown, renderedCamera: unknown) => {
        order.push('render');
        renders.push([renderedScene, renderedCamera]);
        clearedDuringRender.push(autoClear);
      },
      domElement,
      getPixelRatio: () => options.ratio ?? 1,
      setViewport: (x, y, width, height) => {
        viewports.push([x, y, width, height]);
      },
      setScissor: (x, y, width, height) => {
        scissors.push([x, y, width, height]);
      },
      setScissorTest: (enabled) => {
        scissorTests.push(enabled);
      },
    };

    return {
      gl,
      scene,
      order,
      renders,
      stub,
      factory: wrapped,
      domElement,
      viewports,
      scissors,
      scissorTests,
      clearedDuringRender,
    };
  }

  it('renders the frame BEFORE it reads the canvas', () => {
    const room = stubRenderer();

    expect(captureRoomThumbnail(room.gl, room.scene, room.factory)).toBe(JPEG);
    expect(room.order).toEqual(['render', 'toDataURL']);
  });

  it('renders the scene it was handed, through a camera of its own framed on the model', () => {
    const room = stubRenderer();

    captureRoomThumbnail(room.gl, room.scene, room.factory);

    expect(room.renders).toHaveLength(1);
    expect(room.renders[0][0]).toBe(room.scene);

    const camera = room.renders[0][1] as THREE.PerspectiveCamera;
    expect(camera).toBeInstanceOf(THREE.PerspectiveCamera);
    expect(camera.fov).toBe(FRAME_FOV);
    // The canvas's own shape, so a wide room does not produce a squashed card.
    expect(camera.aspect).toBeCloseTo(1920 / 1080, 5);

    // Framed on the MODEL and not on the room. The tagged box is 2x1x1 at the origin;
    // the untagged floor under it is 40x40. A camera far enough back for the floor sits
    // about ninety units out, which is the speck-in-a-grey-floor picture this replaced.
    expect(camera.position.length()).toBeLessThan(10);
    expect(camera.position.length()).toBeGreaterThan(1);

    // From the same three-quarter angle, slightly above, that the lobby's live view
    // arrives from — the snapshot and the "Turn in 3D" it stands in for are one
    // composition, which is the point of lib/scene/frameBox.ts being shared.
    const norm = Math.sqrt(8 * 8 + 6 * 6 + 8 * 8);
    const direction = camera.position.clone().normalize();
    expect(direction.x).toBeCloseTo(8 / norm, 5);
    expect(direction.y).toBeCloseTo(6 / norm, 5);
    expect(direction.z).toBeCloseTo(8 / norm, 5);

    // Clipped to the model rather than left at the canvas defaults, and looking at its
    // middle: a near plane for a 6 m assembly clips a 20 mm fastener into nothing.
    expect(camera.near).toBeGreaterThan(0);
    expect(camera.far).toBeGreaterThan(camera.near);
    // Straight back at the centre of the box, which for this fixture is the origin —
    // the forward vector is the position's own direction reversed.
    expect(camera.getWorldDirection(new THREE.Vector3()).dot(direction)).toBeCloseTo(-1, 5);

    // The room's own camera was never handed over, never added to the scene and never
    // written to: there is nothing to restore because nothing was touched.
    expect(camera.parent).toBeNull();
    expect(room.scene.children).toHaveLength(2);

    // Read from the RENDERER's canvas, at the size it was rendered at.
    expect(room.stub.sizes).toEqual([[480, 270]]);
  });

  it('passes its quality through to the encode', () => {
    const room = stubRenderer();

    captureRoomThumbnail(room.gl, room.scene, room.factory, 0.3);

    expect(room.stub.encodes).toEqual([['image/jpeg', 0.3]]);
  });

  it('takes the renderer off the room\'s own compositing for one frame, and puts it back', () => {
    const room = stubRenderer();
    // What the split-screen branch leaves behind: the test on, over half the canvas.
    room.gl.setScissorTest(true);
    room.gl.setViewport(0, 0, 960, 1080);
    room.scissorTests.length = 0;
    room.viewports.length = 0;

    captureRoomThumbnail(room.gl, room.scene, room.factory);

    // Cleared, so the picture is the model rather than the model over the frame the
    // person was looking at; scissor off and the viewport over the whole canvas, so a
    // capture taken mid-split-screen is not clipped to its left half.
    expect(room.clearedDuringRender).toEqual([true]);
    expect(room.scissorTests).toEqual([false]);
    expect(room.viewports).toEqual([[0, 0, 1920, 1080]]);
    expect(room.scissors).toEqual([[0, 0, 1920, 1080]]);

    // And back again: "Save this view" reads this buffer between frames and expects the
    // room's own frame loop to be in charge of what is in it.
    expect(room.gl.autoClear).toBe(false);
  });

  it('asks for the viewport in CSS pixels, because the renderer multiplies the ratio in', () => {
    const room = stubRenderer({ ratio: 2 });

    captureRoomThumbnail(room.gl, room.scene, room.factory);

    // The drawing buffer is 1920x1080 DEVICE pixels; setViewport takes logical ones and
    // scales them itself, so passing the buffer's numbers back would ask for twice the
    // canvas on a HiDPI screen.
    expect(room.viewports).toEqual([[0, 0, 960, 540]]);
    expect(room.scissors).toEqual([[0, 0, 960, 540]]);
  });

  it('returns null when the renderer has no canvas yet, and renders nothing', () => {
    const room = stubRenderer();
    const gl: ThumbnailRenderer = { ...room.gl, domElement: null };

    expect(captureRoomThumbnail(gl, room.scene, room.factory)).toBeNull();
    expect(room.stub.encodes).toEqual([]);
    // No canvas, no aspect to frame with, so the camera was never built either.
    expect(room.renders).toEqual([]);
  });

  it('returns null for a canvas with no area, so a card gets no picture rather than a black one', () => {
    const zeroWidth = stubRenderer({ width: 0 });
    const zeroHeight = stubRenderer({ height: 0 });

    expect(captureRoomThumbnail(zeroWidth.gl, zeroWidth.scene, zeroWidth.factory)).toBeNull();
    expect(captureRoomThumbnail(zeroHeight.gl, zeroHeight.scene, zeroHeight.factory)).toBeNull();
    expect(zeroWidth.stub.sizes).toEqual([]);
    expect(zeroWidth.renders).toEqual([]);
    expect(zeroHeight.renders).toEqual([]);
  });

  it('renders nothing at all for a room with no model in it', () => {
    const room = stubRenderer();

    // A scene whose only content is the floor: nothing carries the room's marker, so
    // there is nothing to frame on. The review keeps the picture it already had, which
    // is a better card than a grey floor and better than one framed on the grid.
    expect(captureRoomThumbnail(room.gl, new THREE.Scene(), room.factory)).toBeNull();
    expect(room.renders).toEqual([]);
    expect(room.stub.encodes).toEqual([]);
    expect(room.gl.autoClear).toBe(false);
  });

  it('returns null when the capture will not fit the budget', () => {
    const room = stubRenderer({ dataUrl: TOO_BIG });

    expect(captureRoomThumbnail(room.gl, room.scene, room.factory)).toBeNull();
    // It was rendered and read; what came back was simply too big to store.
    expect(room.order).toEqual(['render', 'toDataURL']);
  });

  it('returns null instead of throwing when the renderer has lost its context', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const room = stubRenderer();
    const gl: ThumbnailRenderer = {
      ...room.gl,
      domElement: source(1920, 1080),
      render: () => {
        throw new Error('WebGL context lost');
      },
    };

    expect(captureRoomThumbnail(gl, room.scene, stubFactory().factory)).toBeNull();
    expect(error).toHaveBeenCalled();
    // Even out of a throw, which is what the finally is for.
    expect(gl.autoClear).toBe(false);
  });
});

// ─── captureCameraFor ───────────────────────────────────────────────────────

describe('captureCameraFor', () => {
  it('answers null for a scene with nothing tagged as the product', () => {
    expect(captureCameraFor(new THREE.Scene(), 16 / 9)).toBeNull();
    expect(captureCameraFor(null, 16 / 9)).toBeNull();
    expect(captureCameraFor(undefined, 16 / 9)).toBeNull();
  });

  it('falls back to the stored picture\'s own shape for an aspect it cannot use', () => {
    const camera = captureCameraFor(roomScene(), 0);

    expect(camera).not.toBeNull();
    expect(camera?.aspect).toBeCloseTo(THUMBNAIL_MAX_WIDTH / THUMBNAIL_MAX_HEIGHT, 5);
  });

  it('frames the same scene the same way twice, so a card and its live view agree', () => {
    const first = captureCameraFor(roomScene(), 16 / 9);
    const second = captureCameraFor(roomScene(), 16 / 9);

    expect(first?.position.distanceTo(second!.position)).toBe(0);
    expect(first).not.toBe(second);
  });
});

// ─── saveReviewThumbnail ────────────────────────────────────────────────────

describe('saveReviewThumbnail', () => {
  it('writes the thumbnail onto the review\'s own row, and only that column', async () => {
    answers.set('review_curations', { data: null, error: null });

    await expect(saveReviewThumbnail(REVIEW, JPEG)).resolves.toBe(true);

    expect(froms).toEqual(['review_curations']);
    expect(calls).toEqual([
      { table: 'review_curations', op: 'update', args: [{ thumbnail: JPEG }] },
      { table: 'review_curations', op: 'eq', args: ['id', REVIEW] },
    ]);
  });

  it('refuses a missing review id without touching the database', async () => {
    await expect(saveReviewThumbnail(null, JPEG)).resolves.toBe(false);
    await expect(saveReviewThumbnail(undefined, JPEG)).resolves.toBe(false);
    await expect(saveReviewThumbnail('', JPEG)).resolves.toBe(false);
    // An id of whitespace would update no row and answer success.
    await expect(saveReviewThumbnail('   ', JPEG)).resolves.toBe(false);

    expect(froms).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('refuses a missing thumbnail without touching the database', async () => {
    await expect(saveReviewThumbnail(REVIEW, null)).resolves.toBe(false);
    await expect(saveReviewThumbnail(REVIEW, '')).resolves.toBe(false);

    expect(froms).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('refuses a thumbnail over the budget rather than storing it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(saveReviewThumbnail(REVIEW, TOO_BIG)).resolves.toBe(false);

    expect(froms).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('stores one exactly at the budget, which is the point of counting the payload', async () => {
    answers.set('review_curations', { data: null, error: null });

    await expect(saveReviewThumbnail(REVIEW, AT_THE_LIMIT)).resolves.toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('does nothing at all on an install with no database', async () => {
    // The default self-hosted install: a thumbnail is a nicety there, not a
    // feature that may error on every room open.
    configured.value = false;

    await expect(saveReviewThumbnail(REVIEW, JPEG)).resolves.toBe(false);

    expect(froms).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('answers false and logs when the database refuses the write', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // What an install that has not re-applied docs/supabase-schema.sql answers:
    // PostgREST cannot find the column, and the review keeps working without one.
    answers.set('review_curations', {
      data: null,
      error: { code: 'PGRST204', message: "Could not find the 'thumbnail' column" },
    });

    await expect(saveReviewThumbnail(REVIEW, JPEG)).resolves.toBe(false);
    expect(calls).toHaveLength(2);
    expect(error).toHaveBeenCalled();
  });

  it('answers false rather than throwing when the query itself throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    answers.set('review_curations', {
      data: null,
      error: null,
      throws: new Error('network unreachable'),
    });

    await expect(saveReviewThumbnail(REVIEW, JPEG)).resolves.toBe(false);
  });
});
