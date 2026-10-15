// The render-on-demand plumbing — task 06 step 1.
//
// `frameloop="demand"` is the change that makes an untouched room cost nothing, and it is also
// the change with the quietest possible failure: a frame nobody asked for is a frame that does
// not happen, and what stops happening is whatever nobody thought to wire up. So what this file
// asserts is the ASKING — who asks, when, and above all who does not.
//
// The one that must NOT ask is the clock. components/Scene/World.tsx writes `store.time` ten
// times a second from inside its own useFrame, so a rule of "a store write means the picture
// changed" would make every frame ask for the next one and settle an idle room at ten frames a
// second forever — which is the number this task exists to remove, wearing a disguise. That is a
// real test and not a documentation note, because the failure mode is a room that still renders
// and looks completely fine.
//
// R3F is faked because there is no WebGL here; what stands in for the render loop is the list of
// useFrame callbacks, which a test steps by hand.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

interface FakePresence {
  userId: string;
  position: [number, number, number];
  lookAt: [number, number, number];
}

/** Everything the mocks read and write, hoisted so the factories below can close over it. */
const h = vi.hoisted(() => {
  const camera = {
    position: { x: 8, y: 6, z: 8 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    fov: 60,
    isPerspectiveCamera: true,
  };
  const holder = {
    camera,
    presenting: false,
    frames: [] as Array<() => void>,
    invalidates: 0,
    regresses: 0,
    /** One entry per `motionCull` call: the view it was given, or null for a restore. */
    culls: [] as Array<unknown>,
    participants: new Map<string, { position: number[]; lookAt: number[] }>(),
    lasers: new Map<string, { position: number[] | null; partName: string | null }>(),
    state: {} as Record<string, unknown>,
    reset() {
      holder.frames.length = 0;
      holder.invalidates = 0;
      holder.regresses = 0;
      holder.culls.length = 0;
      holder.participants.clear();
      holder.lasers.clear();
      holder.presenting = false;
      camera.position = { x: 8, y: 6, z: 8 };
      camera.quaternion = { x: 0, y: 0, z: 0, w: 1 };
    },
  };
  holder.state = {
    camera,
    size: { width: 1600, height: 900 },
    invalidate: () => {
      holder.invalidates += 1;
    },
    performance: {
      current: 1,
      min: 0.5,
      max: 1,
      debounce: 200,
      regress: () => {
        holder.regresses += 1;
      },
    },
    gl: {
      xr: {
        get isPresenting() {
          return holder.presenting;
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    },
  };
  return holder;
});

vi.mock('@react-three/fiber', () => ({
  // Kept rather than run: a test steps a frame by calling these, which is what the real loop does.
  useFrame: (callback: () => void) => {
    h.frames.push(callback);
  },
  useThree: (selector: (state: Record<string, unknown>) => unknown) => selector(h.state),
}));

vi.mock('@react-three/drei', () => ({
  AdaptiveDpr: () => null,
}));

// One registry that records every cull and changes nothing: what a component asks for is the
// question here, and lib/scene/__tests__/motionCull.test.ts is where the answer is checked.
vi.mock('../../../lib/scene/partRegistry', () => ({
  partRegistries: () => [
    {
      motionCull: (view: unknown) => {
        h.culls.push(view);
        return 0;
      },
    },
  ],
}));

vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => ({
    remoteParticipants: { current: h.participants },
    remoteLasers: { current: h.lasers },
  }),
}));

const {
  default: MotionQuality,
  StoreDrivenFrames,
  PresenceDrivenFrames,
  MOTION_CULL_PIXELS,
  MOTION_SETTLE_MS,
} = await import('../MotionQuality');
const { useStore } = await import('../../../store');

/** Step one frame of the render loop, which is all `useFrame` callbacks in mount order. */
const frame = () => {
  for (const callback of h.frames) callback();
};

beforeEach(() => {
  vi.useFakeTimers();
  h.reset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('MotionQuality: a camera that moves', () => {
  it('says nothing about the first frame, which has nothing to compare itself to', () => {
    render(<MotionQuality />);
    act(() => frame());
    // The room's first frame is the one everybody is looking at. Regressing the pixel ratio and
    // hiding parts there would be a visible dip on arrival for a movement that never happened.
    expect(h.invalidates).toBe(0);
    expect(h.regresses).toBe(0);
    expect(h.culls).toHaveLength(0);
  });

  it('asks for frames, drops the resolution and culls while the camera is moving', () => {
    render(<MotionQuality />);
    act(() => frame());

    h.camera.position.x += 0.5;
    act(() => frame());

    expect(h.invalidates).toBe(1);
    expect(h.regresses).toBe(1);
    expect(h.culls).toHaveLength(1);
    // k is the pixel threshold, the fov and the viewport height folded into the one scalar the
    // registries test a radius against: N · 2·tan(fov/2) / heightPx.
    const view = h.culls[0] as { eye: { x: number }; k: number };
    expect(view.k).toBeCloseTo((MOTION_CULL_PIXELS * 2 * Math.tan(Math.PI / 6)) / 900, 12);
    expect(view.eye.x).toBeCloseTo(8.5, 6);

    // And again on the next frame of the same movement: holding the low resolution is what
    // calling R3F's regress per frame buys, since its debounce runs from the last call.
    h.camera.position.x += 0.5;
    act(() => frame());
    expect(h.regresses).toBe(2);
    expect(h.culls).toHaveLength(2);
  });

  it('treats a turn as movement, not only a move', () => {
    render(<MotionQuality />);
    act(() => frame());
    // An orbit at a fixed radius: the position may barely change between two frames and the
    // picture is completely different.
    h.camera.quaternion.y = 0.01;
    act(() => frame());
    expect(h.culls).toHaveLength(1);
    expect(h.invalidates).toBe(1);
  });

  it('ignores movement too small to see, which is what damping leaves behind', () => {
    render(<MotionQuality />);
    act(() => frame());
    // OrbitControls keeps easing long after a drag ends. Without a floor on what counts as
    // movement the tail of that easing would ask for frames — and hold the low resolution — for
    // as long as the floats kept differing.
    h.camera.position.x += 1e-6;
    act(() => frame());
    expect(h.invalidates).toBe(0);
    expect(h.culls).toHaveLength(0);
  });

  it('gives the parts back and asks for one more frame when the camera settles', () => {
    render(<MotionQuality />);
    act(() => frame());
    h.camera.position.x += 0.5;
    act(() => frame());
    expect(h.culls).toHaveLength(1);

    // Still. The settle is a timer rather than a frame count, because under demand mode there is
    // no next frame to count: nothing else is asking.
    act(() => frame());
    expect(h.culls).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(MOTION_SETTLE_MS - 1);
    });
    expect(h.culls).toHaveLength(1);

    const asksBefore = h.invalidates;
    act(() => {
      vi.advanceTimersByTime(1);
    });
    // null is the restore, and the frame after it is the one that shows the parts again.
    expect(h.culls).toHaveLength(2);
    expect(h.culls[1]).toBeNull();
    expect(h.invalidates).toBe(asksBefore + 1);
  });

  it('cancels a settle that had not fired yet when the camera moves again', () => {
    render(<MotionQuality />);
    act(() => frame());
    h.camera.position.x += 0.5;
    act(() => frame());
    act(() => frame()); // still — arms the timer
    h.camera.position.x += 0.5;
    act(() => frame()); // moving — must disarm it
    act(() => {
      vi.advanceTimersByTime(MOTION_SETTLE_MS * 3);
    });
    expect(h.culls.every((one) => one !== null)).toBe(true);
  });

  it('does nothing at all inside a headset', () => {
    h.presenting = true;
    render(<MotionQuality />);
    act(() => frame());
    h.camera.position.x += 0.5;
    act(() => frame());
    // In XR the frame loop is the session's own and every frame is drawn, so there is nothing to
    // save — and a dropped pixel ratio in a headset is the one place the number is visible as
    // screen door. Both halves stay off.
    expect(h.invalidates).toBe(0);
    expect(h.regresses).toBe(0);
    // Mounting already in a headset restores, which is a no-op with nothing culled and is the
    // one call this makes: the same effect that gives the parts back on the way in. What it must
    // never do is CULL, which is the half that would cost a headset its resolution and its parts.
    expect(h.culls.filter((one) => one !== null)).toHaveLength(0);
  });

  it('gives every part back when it unmounts mid-movement', () => {
    const view = render(<MotionQuality />);
    act(() => frame());
    h.camera.position.x += 0.5;
    act(() => frame());
    expect(h.culls).toHaveLength(1);

    view.unmount();
    // Leaving the room while the camera is moving must not leave a model with parts hidden: the
    // registry outlives the canvas that culled it.
    expect(h.culls).toHaveLength(2);
    expect(h.culls[1]).toBeNull();
  });
});

describe('StoreDrivenFrames: what a store write means', () => {
  it('asks for a frame when something the picture depends on changes', () => {
    render(<StoreDrivenFrames />);
    const before = h.invalidates;
    act(() => {
      useStore.getState().toggleHideAgents();
    });
    expect(h.invalidates).toBe(before + 1);
    act(() => {
      useStore.getState().toggleHideAgents();
    });
    expect(h.invalidates).toBe(before + 2);
  });

  it('does NOT ask for a frame when only the clock moved', () => {
    render(<StoreDrivenFrames />);
    const before = h.invalidates;
    // Ten times a second, from inside a useFrame, forever. This is the loop that would keep an
    // idle room rendering: frame → clock → ask → frame.
    act(() => {
      useStore.getState().setTime(1.5);
      useStore.getState().setTime(1.6);
      useStore.getState().setTime(1.7);
    });
    expect(h.invalidates).toBe(before);
  });

  it('does not ask twice for one write, and not at all for a write that changed nothing', () => {
    render(<StoreDrivenFrames />);
    const before = h.invalidates;
    const { setLaserActive } = useStore.getState();
    act(() => {
      setLaserActive(true);
    });
    expect(h.invalidates).toBe(before + 1);
    act(() => {
      // zustand does not notify when the value is the same, and neither does this.
      setLaserActive(true);
    });
    expect(h.invalidates).toBe(before + 1);
    act(() => {
      setLaserActive(false);
    });
  });
});

describe('PresenceDrivenFrames: what somebody else moving means', () => {
  const arrive = (userId: string): FakePresence => ({
    userId,
    position: [1, 1.6, 2],
    lookAt: [0, 1, 0],
  });

  it('asks nothing at all in an empty room', () => {
    render(<PresenceDrivenFrames />);
    const before = h.invalidates;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // A room nobody else is in must not render ten times a second for the sake of a poll that
    // keeps finding the same empty map.
    expect(h.invalidates).toBe(before);
  });

  it('asks once when a colleague arrives, and not again while they stand still', () => {
    render(<PresenceDrivenFrames />);
    const before = h.invalidates;
    h.participants.set('them', arrive('them') as unknown as { position: number[]; lookAt: number[] });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(h.invalidates).toBe(before + 1);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(h.invalidates).toBe(before + 1);
  });

  it('asks again when they move, and when their laser moves', () => {
    render(<PresenceDrivenFrames />);
    const them = arrive('them') as unknown as { position: number[]; lookAt: number[] };
    h.participants.set('them', them);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    const before = h.invalidates;

    them.position[0] = 3;
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(h.invalidates).toBe(before + 1);

    h.lasers.set('them', { position: [0, 1, 0], partName: 'Bolt' });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(h.invalidates).toBe(before + 2);

    // A laser going down is a change too: it is the frame that takes the dot off the model.
    h.lasers.set('them', { position: null, partName: null });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(h.invalidates).toBe(before + 3);
  });

  it('does not ask about movement smaller than the poll can see', () => {
    render(<PresenceDrivenFrames />);
    const them = arrive('them') as unknown as { position: number[]; lookAt: number[] };
    h.participants.set('them', them);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    const before = h.invalidates;
    // Presence goes out as JSON numbers from a lerp, so the last digits jitter between two
    // messages that mean the same place. A poll that asked about those would never stop asking.
    them.position[0] += 1e-6;
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(h.invalidates).toBe(before);
  });
});
