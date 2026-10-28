// The room's view tools in the store — task 08a.
//
// Three claims, and each has a failure mode that is invisible on one screen:
//
//   • a LOCAL change applies immediately AND goes to the room. Applied immediately because
//     a section that arrived a round trip late would lag behind the hand dragging it; sent
//     because a cut only one browser can see is not a cut.
//   • an INCOMING change applies WITHOUT going back out. The room relays to everybody but
//     the sender, so a receiver that re-sent what it received would have the room relaying
//     its own message around for as long as anybody kept touching the slider.
//   • a DRAG does not put sixty messages a second on the wire, and the last value of one
//     still arrives. A range input fires per pointer-move; ~15/s with a trailing send is the
//     rate at which a section sweeping across a model already looks continuous to everybody
//     else and the room's socket is not the thing being measured.
//
// The store is the real one and the socket is not: `lib/viewToolsSender.ts` exists precisely
// so that store.ts can reach the wire without importing lib/usePartyPresence.ts, which
// imports the store. A test registers a spy sender through the same seam the presence hook
// does, which is also the proof the seam is the only one.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { useStore, flushViewTools, VIEW_TOOLS_SEND_MS } from '../../store';
import { setViewToolsSender } from '../viewToolsSender';
import { DEFAULT_VIEW_TOOLS, type ViewTools } from '../scene/viewTools';

const CUT = { axis: 'x', position: 0.5, flip: false } as const;

/** Everything the store handed to the wire, in order. */
let sent: ViewTools[];

// Installed ONCE for the file and not per test. `vi.useFakeTimers()` resets the clock to
// the system time it was called at, so installing it in `beforeEach` would have thrown away
// every advance the test before it made — and the throttle's own memory of when it last sent
// is module state that outlives a test. With one install the clock accumulates and
// `advanceTimersByTime` below really does put the next test outside the last one's slot.
beforeAll(() => {
  vi.useFakeTimers();
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  sent = [];
  setViewToolsSender((payload) => sent.push(payload));
  useStore.setState({ viewTools: DEFAULT_VIEW_TOOLS });
  // Drain whatever the test before this one left waiting, and then let the throttle window
  // close. Without the second half a test inherits the slot the one before it sent in, and
  // "the leading edge sends at once" — which is only true of a send more than a slot after
  // the last — becomes a claim about test order rather than about the throttle.
  flushViewTools();
  vi.advanceTimersByTime(VIEW_TOOLS_SEND_MS * 20);
  sent.length = 0;
});

afterEach(() => {
  setViewToolsSender(null);
  useStore.setState({ viewTools: DEFAULT_VIEW_TOOLS });
  flushViewTools();
});

/** How many times a value was put on the wire, and what the last of them was. */
const sentCount = () => sent.length;

describe('setViewTools', () => {
  it('applies a local change immediately and sends it to the room', () => {
    const next = { cut: CUT, explode: 0 };
    useStore.getState().setViewTools(next);

    // Immediately, and not after a round trip: the section has to be on this screen the
    // moment the person dragging the slider moves it.
    expect(useStore.getState().viewTools).toEqual(next);
    // The leading edge of the throttle sends at once, so the room is not a slot behind the
    // hand either.
    expect(sent).toEqual([next]);
  });

  it('applies an incoming change without sending it back', () => {
    useStore.getState().setViewTools({ cut: CUT, explode: 0 }, { broadcast: false });

    expect(useStore.getState().viewTools).toEqual({ cut: CUT, explode: 0 });
    // The one thing that keeps the relay from being a loop.
    expect(sentCount()).toBe(0);
  });

  it('broadcasts by default, which is the case a person dragging a slider is', () => {
    useStore.getState().setViewTools({ cut: null, explode: 0.5 });
    expect(sentCount()).toBe(1);
  });

  it('writes nothing and sends nothing for the value the store already had', () => {
    useStore.getState().setViewTools({ cut: CUT, explode: 0 });
    const before = useStore.getState().viewTools;
    sent.length = 0;

    // A fresh object saying the same thing, which is what a relayed message is: the reader
    // rebuilds the payload rather than handing over the one it parsed. Under
    // `frameloop="demand"` a store write is a frame asked for, so "the same value" has to
    // be answered field by field and not by identity.
    useStore.getState().setViewTools({ cut: { ...CUT }, explode: 0 });

    expect(useStore.getState().viewTools).toBe(before);
    expect(sentCount()).toBe(0);
  });

  it('puts the explode on the wire beside the cut, so 08b needs no new message', () => {
    useStore.getState().setViewTools({ cut: null, explode: 0.75 });
    expect(sent[0]).toEqual({ cut: null, explode: 0.75 });
  });
});

describe('the throttle', () => {
  it('does not put a message on the wire for every step of a drag', () => {
    // Sixty steps, one per frame of a one-second drag at 60 Hz — the worst case a range
    // input produces.
    for (let step = 1; step <= 60; step += 1) {
      useStore.getState().setViewTools({ cut: { axis: 'x', position: step / 60, flip: false }, explode: 0 });
      vi.advanceTimersByTime(1000 / 60);
    }

    // Every step applied locally...
    expect(useStore.getState().viewTools.cut?.position).toBeCloseTo(1);
    // ...and about fifteen of them went out, not sixty.
    expect(sentCount()).toBeGreaterThan(5);
    expect(sentCount()).toBeLessThanOrEqual(17);
  });

  it('still sends the last value of a drag, once the release flushes it', () => {
    for (let step = 1; step <= 5; step += 1) {
      useStore.getState().setViewTools({ cut: { axis: 'x', position: step / 5, flip: false }, explode: 0 });
      vi.advanceTimersByTime(10);
    }
    const last = useStore.getState().viewTools;

    // The release. Without it the room would converge on the value the drag ended at up to
    // one slot later, which is a room that disagrees with the screen that dragged it.
    flushViewTools();

    expect(sent[sent.length - 1]).toEqual(last);
    vi.advanceTimersByTime(1000);
    expect(sent[sent.length - 1]).toEqual(last);
  });

  it('sends the final value even when nobody flushes it, once the slot comes round', () => {
    useStore.getState().setViewTools({ cut: { axis: 'z', position: 0.1, flip: false }, explode: 0 });
    useStore.getState().setViewTools({ cut: { axis: 'z', position: 0.9, flip: true }, explode: 0 });
    sent.length = 0;

    vi.advanceTimersByTime(500);

    // The trailing send, and it carries the NEWEST value: an intermediate one nobody will
    // see is not worth a message.
    expect(sent).toEqual([{ cut: { axis: 'z', position: 0.9, flip: true }, explode: 0 }]);
  });

  it('sends nothing when there is nothing waiting', () => {
    flushViewTools();
    vi.advanceTimersByTime(1000);
    expect(sentCount()).toBe(0);
  });
});

describe('the sender seam', () => {
  it('is silent while no room is connected, so the lobby can move a cut of its own', () => {
    setViewToolsSender(null);
    useStore.getState().setViewTools({ cut: CUT, explode: 0 });

    // Applied, and nothing thrown: a lobby preview canvas has no socket and no room to tell,
    // and a cut that only worked inside a meeting would not be a control anybody could try.
    expect(useStore.getState().viewTools).toEqual({ cut: CUT, explode: 0 });
  });
});
