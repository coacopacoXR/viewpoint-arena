// The light rig, and the two canvases that have to share it — batch BT.
//
// A lighting change cannot be asserted from a picture in a unit test, so what is pinned
// here is the two things that CAN rot silently: the tone mapping (a constant in a
// renderer, which is exactly the kind of choice that gets "temporarily" changed and left)
// and the fact that there is ONE rig. Before this batch the room had ambient 0.7 plus a
// point light plus a studio environment blurred to nothing, and the lobby's "Turn in 3D"
// had a different arrangement of its own, so the same bracket looked different in the
// preview and in the meeting it was a preview of.
//
// The rig is read as the element tree its component returns rather than rendered: R3F's
// intrinsic elements (`ambientLight`, `directionalLight`) mean nothing to a DOM renderer,
// and a WebGL context is not a thing a test here can have. Walking the tree asserts the
// same numbers a render would, without one.

import React from 'react';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import LightRig, { SCENE_TONE_MAPPING, SCENE_TONE_MAPPING_EXPOSURE } from '../LightRig';

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

/** The tag or component name of a React element, unwrapping memo and forwardRef. */
function nameOf(type: unknown): string {
  if (typeof type === 'string') return type;
  if (typeof type === 'function') return type.name;
  const record = type as { render?: unknown; type?: unknown } | null;
  if (typeof record?.render === 'function') return nameOf(record.render);
  if (record?.type) return nameOf(record.type);
  return '';
}

/** Every element in a tree, flattened, with the name it answers to. */
function flatten(element: unknown, into: Array<{ name: string; props: Record<string, unknown> }> = []) {
  if (!React.isValidElement(element)) return into;
  const props = element.props as { children?: React.ReactNode } & Record<string, unknown>;
  into.push({ name: nameOf(element.type), props });
  React.Children.forEach(props.children, (child) => flatten(child, into));
  return into;
}

const rig = flatten(LightRig({}));
const named = (name: string) => rig.filter((one) => one.name === name);
/**
 * Found by what it is given rather than by what it is called: drei's Environment reaches
 * this tree through a memo of a forwardRef, and a name that depends on how a dependency
 * happens to wrap its export is a test that breaks on a version bump.
 */
const withProp = (key: string, value: unknown) => rig.filter((one) => one.props[key] === value);

describe('the tone mapping every canvas uses', () => {
  it('is the neutral curve, at exposure 1', () => {
    // ACES filmic is a grading curve: it desaturates towards white as it rolls off, so
    // a bright red anodised part or a yellow safety guard comes out washed out. Neutral
    // is the one made for product colour, which is what a design review is looking at.
    expect(SCENE_TONE_MAPPING).toBe(THREE.NeutralToneMapping);
    expect(SCENE_TONE_MAPPING).not.toBe(THREE.ACESFilmicToneMapping);
    expect(SCENE_TONE_MAPPING_EXPOSURE).toBe(1);
  });

  it('is what the room\'s canvas asks its renderer for', () => {
    const canvas = source('../ViewpointCanvas.tsx');
    expect(canvas).toContain('toneMapping: SCENE_TONE_MAPPING');
    expect(canvas).toContain('toneMappingExposure: SCENE_TONE_MAPPING_EXPOSURE');
    expect(canvas).not.toContain('ACESFilmicToneMapping');
  });

  it('is what the lobby\'s preview asks its renderer for, from the same constant', () => {
    const viewer = source('../../lobby/ReviewModelViewer.tsx');
    expect(viewer).toContain('toneMapping: SCENE_TONE_MAPPING');
    expect(viewer).not.toContain('ACESFilmicToneMapping');
  });
});

describe('the rig itself', () => {
  it('makes the studio environment the main light, blurred less than it was', () => {
    const environment = withProp('preset', 'studio');
    expect(environment).toHaveLength(1);
    // 0.4 rather than 1: a fully blurred environment gives a curved surface a gradient
    // but a polished chamfer nothing to reflect.
    expect(environment[0].props.blur).toBe(0.4);
    expect(environment[0].props.environmentIntensity).toBe(0.9);
    // And it is fenced, so an install with no route to the HDR's CDN shows a flat-lit
    // model rather than an empty canvas.
    expect(named('EnvErrorBoundary')).toHaveLength(1);
  });

  it('lifts the shadows with a little ambient rather than flattening them with a lot', () => {
    const ambient = named('ambientLight');
    expect(ambient).toHaveLength(1);
    expect(ambient[0].props.intensity).toBe(0.25);
  });

  it('has one shadow-casting key from above and in front, and a weak fill opposite it', () => {
    const keys = named('directionalLight');
    expect(keys).toHaveLength(2);

    const key = keys.find((one) => one.props.castShadow === true);
    const fill = keys.find((one) => one.props.castShadow !== true);
    expect(key).toBeDefined();
    expect(fill).toBeDefined();

    const position = key?.props.position as number[];
    // Above and in front: both coordinates positive, and the height the largest of the
    // three, which is what makes a fillet read as a fillet.
    expect(position[1]).toBeGreaterThan(position[0]);
    expect(position[2]).toBeGreaterThan(0);
    expect(Number(key?.props.intensity)).toBeGreaterThan(Number(fill?.props.intensity));
  });

  it('is mounted by the room and by the lobby\'s preview, and neither keeps its own lights', () => {
    const world = source('../World.tsx');
    expect(world).toContain('<LightRig />');
    expect(world).not.toContain('ambientLight');
    expect(world).not.toContain('pointLight');
    expect(world).not.toContain('<Environment');

    const viewer = source('../../lobby/ReviewModelViewer.tsx');
    expect(viewer).toContain('<LightRig />');
    expect(viewer).not.toContain('ambientLight');
    expect(viewer).not.toContain('<Environment');
  });
});
