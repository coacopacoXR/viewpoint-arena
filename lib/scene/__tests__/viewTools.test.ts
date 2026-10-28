// The room's view tools as a value — task 08a.
//
// ONE reader, used by both ends of the wire: the room server validates what a browser
// sends and the browser validates what the room server relays, and two readers of one
// payload is two chances to disagree about what a cut's position means. So these are the
// claims about the reader rather than about either end of it.
//
// The three that matter most are the ones with a silent failure mode:
//
//   • a position that is not a finite number is REFUSED, not clamped. `Number.NaN` clamped
//     by `Math.min/Math.max` is still NaN, and a NaN in a THREE.Plane's constant makes
//     every fragment of every model compare false — a room with no product in it, on every
//     screen, from one browser that measured a model with no geometry.
//   • an unreadable payload is refused WHOLE rather than rescued field by field. A cut is
//     one statement about where the room is looking; an axis that arrived readable and a
//     position that did not would put the plane somewhere nobody asked for it.
//   • ABSENT is not the same as JUNK. `explode` missing reads as 0 and `cut` missing reads
//     as no cut, which is what lets a client that only knew about one of them still say
//     what it meant — and it is what makes the message safe to grow.

import { describe, it, expect } from 'vitest';
import {
  asCutPlane,
  asUnit,
  asViewTools,
  CUT_AXES,
  DEFAULT_VIEW_TOOLS,
  sameViewTools,
  type ViewTools,
} from '../viewTools';

describe('asUnit', () => {
  it('clamps a fraction that overshoots either end', () => {
    expect(asUnit(-0.4)).toBe(0);
    expect(asUnit(0)).toBe(0);
    expect(asUnit(0.5)).toBe(0.5);
    expect(asUnit(1)).toBe(1);
    expect(asUnit(1.6)).toBe(1);
  });

  it.each([
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a numeric string', '0.5'],
    ['a boolean', true],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
  ])('refuses %s rather than clamping it', (_label, value) => {
    expect(asUnit(value)).toBeNull();
  });
});

describe('asCutPlane', () => {
  it('reads axis, position and flip', () => {
    expect(asCutPlane({ axis: 'x', position: 0.25, flip: true })).toEqual({
      axis: 'x',
      position: 0.25,
      flip: true,
    });
  });

  it('accepts every axis the control offers', () => {
    for (const axis of CUT_AXES) {
      expect(asCutPlane({ axis, position: 0.5, flip: false })?.axis).toBe(axis);
    }
  });

  it('reads a missing flip as false, and anything that is not `true` as false', () => {
    expect(asCutPlane({ axis: 'y', position: 0 })?.flip).toBe(false);
    expect(asCutPlane({ axis: 'y', position: 0, flip: 'yes' })?.flip).toBe(false);
    expect(asCutPlane({ axis: 'y', position: 0, flip: 1 })?.flip).toBe(false);
  });

  it('clamps a position past either end of the model', () => {
    expect(asCutPlane({ axis: 'z', position: -3, flip: false })?.position).toBe(0);
    expect(asCutPlane({ axis: 'z', position: 42, flip: false })?.position).toBe(1);
  });

  it.each([
    ['an axis that is not one', { axis: 'w', position: 0.5, flip: false }],
    ['a missing axis', { position: 0.5, flip: false }],
    ['an uppercase axis', { axis: 'X', position: 0.5, flip: false }],
    ['a position that is NaN', { axis: 'x', position: Number.NaN, flip: false }],
    ['a position that is a string', { axis: 'x', position: 'half', flip: false }],
    ['a missing position', { axis: 'x', flip: false }],
    ['a string', 'x=0.5'],
    ['an array', [{ axis: 'x' }]],
    ['null', null],
    ['undefined', undefined],
  ])('refuses %s whole', (_label, value) => {
    expect(asCutPlane(value)).toBeNull();
  });

  it('strips a field nobody wrote', () => {
    const read = asCutPlane({ axis: 'x', position: 0.5, flip: false, normal: [0, 1, 0], secret: 's' });
    expect(Object.keys(read ?? {}).sort()).toEqual(['axis', 'flip', 'position']);
  });
});

describe('asViewTools', () => {
  it('reads both halves', () => {
    expect(asViewTools({ cut: { axis: 'y', position: 0.75, flip: true }, explode: 0.25 })).toEqual({
      cut: { axis: 'y', position: 0.75, flip: true },
      explode: 0.25,
    });
  });

  it('reads an absent cut as no cut and an absent explode as assembled', () => {
    expect(asViewTools({})).toEqual(DEFAULT_VIEW_TOOLS);
    expect(asViewTools({ cut: null })).toEqual({ cut: null, explode: 0 });
    expect(asViewTools({ explode: 0.5 })).toEqual({ cut: null, explode: 0.5 });
  });

  it('reads an explicit null cut as no cut, which is how the room turns one off', () => {
    expect(asViewTools({ cut: null, explode: 0 })).toEqual({ cut: null, explode: 0 });
  });

  it('clamps an explode past either end', () => {
    expect(asViewTools({ explode: -1 })?.explode).toBe(0);
    expect(asViewTools({ explode: 9 })?.explode).toBe(1);
  });

  it.each([
    ['a cut that is junk', { cut: { axis: 'q', position: 0.5, flip: false }, explode: 0 }],
    ['a cut that is a string', { cut: 'x' }],
    ['an explode that is NaN', { cut: null, explode: Number.NaN }],
    ['an explode that is a string', { cut: null, explode: 'lots' }],
    ['a payload that is not an object', 'view tools please'],
    ['a payload that is an array', []],
    ['null', null],
    ['undefined', undefined],
  ])('refuses %s whole', (_label, value) => {
    expect(asViewTools(value)).toBeNull();
  });

  it('strips a field nobody wrote, so it cannot ride into room state', () => {
    const read = asViewTools({ cut: null, explode: 0, andMyHouseKeys: { secret: 's' } });
    expect(Object.keys(read ?? {}).sort()).toEqual(['cut', 'explode']);
    expect(JSON.stringify(read)).not.toContain('secret');
  });

  it('hands back a value that survives a trip through JSON unchanged', () => {
    // The claim the wire depends on: what the server stores is what a client reads back, so
    // a second relay or a reload cannot drift.
    const original = { cut: { axis: 'z', position: 0.125, flip: true }, explode: 0.875 };
    const once = asViewTools(original);
    const twice = asViewTools(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });
});

describe('sameViewTools', () => {
  it('answers true for two objects that say the same thing', () => {
    expect(
      sameViewTools(
        { cut: { axis: 'x', position: 0.5, flip: false }, explode: 0 },
        { cut: { axis: 'x', position: 0.5, flip: false }, explode: 0 },
      ),
    ).toBe(true);
  });

  it.each<[string, ViewTools]>([
    ['the axis', { cut: { axis: 'y', position: 0.5, flip: false }, explode: 0 }],
    ['the position', { cut: { axis: 'x', position: 0.6, flip: false }, explode: 0 }],
    ['the flip', { cut: { axis: 'x', position: 0.5, flip: true }, explode: 0 }],
    ['the explode', { cut: { axis: 'x', position: 0.5, flip: false }, explode: 0.2 }],
  ])('answers false when %s moved', (_label, other) => {
    const base: ViewTools = { cut: { axis: 'x', position: 0.5, flip: false }, explode: 0 };
    expect(sameViewTools(base, other)).toBe(false);
  });

  it('tells a cut from no cut in both directions', () => {
    const none: ViewTools = { cut: null, explode: 0 };
    const some: ViewTools = { cut: { axis: 'x', position: 0.5, flip: false }, explode: 0 };
    expect(sameViewTools(none, some)).toBe(false);
    expect(sameViewTools(some, none)).toBe(false);
    expect(sameViewTools(none, { cut: null, explode: 0 })).toBe(true);
  });
});

describe('DEFAULT_VIEW_TOOLS', () => {
  it('is no cut and nothing exploded, which is what an untouched room draws', () => {
    expect(DEFAULT_VIEW_TOOLS).toEqual({ cut: null, explode: 0 });
  });

  it('reads back as itself, so a room that resets and a room that never started agree', () => {
    expect(asViewTools(DEFAULT_VIEW_TOOLS)).toEqual(DEFAULT_VIEW_TOOLS);
  });
});
