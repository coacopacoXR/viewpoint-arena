// What the lobby's picture of a room must not contain — batch BV.
//
// The report was a review whose card in the lobby showed the move gizmo's arrows: the
// capture is armed by a model arriving or moving and fires three seconds later, which is
// exactly when the gizmo is still attached to the model somebody had just dragged. So the
// picture of the review on every card was a picture of one person mid-edit in it.
//
// These tests use real three.js objects and no WebGL: what is being pinned is which
// objects are hidden, which materials are calmed, and that everything is put back — the
// render itself is a fake that answers whether the tools were out of the frame while it
// ran.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  EDITING_HELPER_KEY,
  hideEditingHelpers,
  isEditingHelper,
  markEditingHelper,
} from '../captureClean';
import { setEmissiveHighlight } from '../materialHighlight';
import { captureRoomThumbnail, type CanvasFactory, type ThumbnailRenderer } from '../../reviews/thumbnail';

/**
 * An object that claims to be three's transform gizmo.
 *
 * `Object3D.type` is read-only in the typings, and constructing a real
 * `TransformControls` needs a DOM element and a camera that a jsdom test has no business
 * building, so the type name is defined onto an ordinary object. That is all
 * `isEditingHelper` reads, and all the real gizmo would have shown here.
 */
function gizmo(type = 'TransformControls'): THREE.Object3D {
  const object = new THREE.Object3D();
  Object.defineProperty(object, 'type', { value: type, configurable: true, writable: true });
  return object;
}

/** A model, tagged the way utils/modelLoader and components/Scene/Product tag one. */
function product(id = 'bracket'): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x999999 }),
  );
  mesh.userData.modelId = id;
  return mesh;
}

function scene(...children: THREE.Object3D[]): THREE.Scene {
  const world = new THREE.Scene();
  for (const child of children) world.add(child);
  world.updateMatrixWorld(true);
  return world;
}

describe('isEditingHelper — what counts as a tool', () => {
  it('is the tag this repo sets', () => {
    const group = new THREE.Group();
    expect(isEditingHelper(group)).toBe(false);
    group.userData[EDITING_HELPER_KEY] = true;
    expect(isEditingHelper(group)).toBe(true);
  });

  it('is three’s own gizmo, by name, whether or not anything tagged it', () => {
    // The gizmo is created by a library this app does not own, so its own type name is a
    // second mechanism and not the only thing between a card and an arrow.
    for (const type of ['TransformControls', 'TransformControlsGizmo', 'TransformControlsPlane']) {
      expect(isEditingHelper(gizmo(type)), type).toBe(true);
    }
    expect(isEditingHelper(gizmo('Mesh'))).toBe(false);
    expect(isEditingHelper(new THREE.Object3D())).toBe(false);
  });

  it('is set by the ref callback the gizmo is handed', () => {
    const controls = new THREE.Object3D();
    markEditingHelper(controls);
    expect(isEditingHelper(controls)).toBe(true);
    // And a ref that has been released hands over null, which must not throw.
    expect(() => markEditingHelper(null)).not.toThrow();
    expect(() => markEditingHelper(undefined)).not.toThrow();
  });
});

describe('hideEditingHelpers — for the one render', () => {
  it('hides the tagged helpers and the gizmo, and puts both back', () => {
    const pin = new THREE.Group();
    pin.userData[EDITING_HELPER_KEY] = true;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.03), new THREE.MeshBasicMaterial());
    pin.add(dot);
    const handles = gizmo();
    const model = product();
    const world = scene(model, pin, handles);

    const clean = hideEditingHelpers(world);
    expect(clean.hidden).toBe(2);
    expect(pin.visible).toBe(false);
    expect(handles.visible).toBe(false);
    // What the picture is OF is untouched.
    expect(model.visible).toBe(true);

    clean.restore();
    expect(pin.visible).toBe(true);
    expect(handles.visible).toBe(true);
    // A child inside a hidden helper was never turned off itself, so restoring the
    // parent is the whole of putting it back.
    expect(dot.visible).toBe(true);
  });

  it('leaves alone anything the room had already turned off', () => {
    // A laser dot that is not pointing is `visible = false` in the room. Hiding it and
    // then "restoring" it to true would leave a dot on the model after the capture.
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.03), new THREE.MeshBasicMaterial());
    dot.visible = false;
    dot.userData[EDITING_HELPER_KEY] = true;
    const world = scene(product(), dot);

    const clean = hideEditingHelpers(world);
    expect(clean.hidden).toBe(0);
    clean.restore();
    expect(dot.visible).toBe(false);
  });

  it('takes a selection glow off a material, and gives it back', () => {
    const model = product();
    const material = model.material as THREE.MeshStandardMaterial;
    setEmissiveHighlight(material, { color: new THREE.Color(0x0044aa), intensity: 0.5 });
    expect(material.emissive.getHex()).toBe(0x0044aa);
    const world = scene(model);

    const clean = hideEditingHelpers(world);
    expect(clean.calmed).toBe(1);
    expect(material.emissive.getHex()).toBe(0x000000);
    // three's own default, which is what the material's intensity was before any
    // highlight touched it — the point being that the ORIGINAL is restored rather than a
    // constant, the promise lib/scene/materialHighlight exists to keep.
    expect(material.emissiveIntensity).toBe(1);

    clean.restore();
    expect(material.emissive.getHex()).toBe(0x0044aa);
    expect(material.emissiveIntensity).toBe(0.5);
  });

  it('leaves a material’s own emissive alone, because it is part of the model', () => {
    // A warning stripe a CAD file carried, a lens a glTF author gave a glow. No highlight
    // has ever touched it, so nothing here may either — and nothing may STAMP an original
    // onto it, which is what lib/scene/materialHighlight exists to avoid doing at scale.
    const model = product();
    const material = model.material as THREE.MeshStandardMaterial;
    material.emissive = new THREE.Color(0xff0000);
    material.emissiveIntensity = 0.8;
    const world = scene(model);

    const clean = hideEditingHelpers(world);
    expect(clean.calmed).toBe(0);
    expect(material.emissive.getHex()).toBe(0xff0000);
    clean.restore();
    expect(material.emissive.getHex()).toBe(0xff0000);
    expect(material.userData.originalEmissive).toBeUndefined();
  });

  it('restores once, however many times it is asked', () => {
    const handles = gizmo();
    const world = scene(product(), handles);

    const clean = hideEditingHelpers(world);
    clean.restore();
    // The room turned the gizmo back off for its own reasons; a second restore — a
    // `finally` under a `try` that also returned early — must not show it again.
    handles.visible = false;
    clean.restore();
    expect(handles.visible).toBe(false);
  });

  it('answers nothing to do for a scene with no tools in it, and for no scene at all', () => {
    expect(hideEditingHelpers(scene(product()))).toMatchObject({ hidden: 0, calmed: 0 });
    expect(hideEditingHelpers(null)).toMatchObject({ hidden: 0, calmed: 0 });
    expect(hideEditingHelpers(undefined)).toMatchObject({ hidden: 0, calmed: 0 });
  });
});

describe('captureRoomThumbnail — the picture it takes', () => {
  const makeCanvas: CanvasFactory = (width, height) => ({
    canvas: { width, height, toDataURL: () => 'data:image/jpeg;base64,QUJD' },
    context: { drawImage: () => {} },
  });

  /** A renderer that answers, while it renders, whether the tools were out of frame. */
  function renderer(world: THREE.Scene) {
    const seen: Array<{ pin: boolean; gizmo: boolean; glow: number }> = [];
    const pin = new THREE.Group();
    pin.userData[EDITING_HELPER_KEY] = true;
    const handles = gizmo();
    const model = product();
    const material = model.material as THREE.MeshStandardMaterial;
    setEmissiveHighlight(material, { color: new THREE.Color(0x0044aa), intensity: 0.5 });
    world.add(model, pin, handles);
    world.updateMatrixWorld(true);

    const gl: ThumbnailRenderer = {
      domElement: { width: 1600, height: 900, toDataURL: () => 'data:image/jpeg;base64,QUJD' },
      autoClear: false,
      getPixelRatio: () => 1,
      setViewport: () => {},
      setScissor: () => {},
      setScissorTest: () => {},
      render: () => {
        seen.push({ pin: pin.visible, gizmo: handles.visible, glow: material.emissive.getHex() });
      },
    };
    return { gl, seen, pin, handles, material };
  }

  it('renders with the gizmo, the pins and the selection glow out of the frame', () => {
    const world = new THREE.Scene();
    const { gl, seen } = renderer(world);

    const thumbnail = captureRoomThumbnail(gl, world, makeCanvas);

    expect(thumbnail).toBe('data:image/jpeg;base64,QUJD');
    expect(seen).toHaveLength(1);
    expect(seen[0].pin).toBe(false);
    expect(seen[0].gizmo).toBe(false);
    expect(seen[0].glow).toBe(0x000000);
  });

  it('gives the meeting its tools back', () => {
    const world = new THREE.Scene();
    const { gl, pin, handles, material } = renderer(world);

    captureRoomThumbnail(gl, world, makeCanvas);

    expect(pin.visible).toBe(true);
    expect(handles.visible).toBe(true);
    expect(material.emissive.getHex()).toBe(0x0044aa);
  });

  it('gives them back when the renderer throws, which a lost context does', () => {
    const world = new THREE.Scene();
    const { gl, pin, handles } = renderer(world);
    const throwing: ThumbnailRenderer = {
      ...gl,
      render: () => {
        throw new Error('context lost');
      },
    };

    // captureRoomThumbnail never throws: a thumbnail is a nicety, and a room with an
    // invisible gizmo is a room nobody can move anything in.
    expect(captureRoomThumbnail(throwing, world, makeCanvas)).toBeNull();
    expect(pin.visible).toBe(true);
    expect(handles.visible).toBe(true);
  });
});
