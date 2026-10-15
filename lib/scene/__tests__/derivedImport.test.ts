// Waiting for the server to tessellate a CAD file.
//
// The timing is the whole of this module's behaviour, so it is what is pinned
// here: how soon the first ask goes out, how far the asks drift apart, and the
// three ways the wait ends. A poll that never backed off would turn one
// conversion into a request every two seconds from every participant who
// imported the file; a wait with no way out would leave an import stuck on
// "importing" behind an api that had lost the job.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DerivedGlbProbe } from '../../modelsClient';

const { probeDerivedGlb } = vi.hoisted(() => ({
  // One line: esbuild reads a multi-line type argument as JSX in a .tsx file, and
  // keeping the two files shaped alike is worth the habit.
  probeDerivedGlb: vi.fn<(hash: string, fileName: string) => Promise<DerivedGlbProbe>>(),
}));

vi.mock('../../modelsClient', () => ({ probeDerivedGlb }));

const {
  DERIVED_ELAPSED_TICK_MS,
  DERIVED_FIRST_POLL_MS,
  DERIVED_MAX_POLL_MS,
  waitForDerivedGlb,
} = await import('../derivedImport');

const HASH = 'a1'.repeat(32);
const BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00]);

function glb(): File {
  return new File([BYTES], 'bracket.glb', { type: 'model/gltf-binary' });
}

/** Advance the fake clock, letting the poll loop's promises settle as it goes. */
async function elapse(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  probeDerivedGlb.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('waitForDerivedGlb — a conversion that lands', () => {
  it('does not ask straight away, then asks on the opening interval', async () => {
    const file = glb();
    probeDerivedGlb.mockResolvedValueOnce({ status: 'pending' }).mockResolvedValueOnce({ status: 'ready', file });
    const waiting = waitForDerivedGlb(HASH, 'bracket.step');

    // The api has only just been told to convert; asking in the same tick is a
    // request whose answer is known.
    expect(probeDerivedGlb).not.toHaveBeenCalled();

    await elapse(DERIVED_FIRST_POLL_MS);
    expect(probeDerivedGlb).toHaveBeenCalledTimes(1);
    expect(probeDerivedGlb).toHaveBeenCalledWith(HASH, 'bracket.step');

    await elapse(DERIVED_FIRST_POLL_MS * 1.5);
    await expect(waiting).resolves.toEqual({ status: 'derived', file });
    expect(probeDerivedGlb).toHaveBeenCalledTimes(2);
  });

  it('backs the interval off to its cap, and no further', async () => {
    probeDerivedGlb.mockResolvedValue({ status: 'pending' });
    const controller = new AbortController();
    const waiting = waitForDerivedGlb(HASH, 'bracket.step', { signal: controller.signal });

    await elapse(2_000);
    expect(probeDerivedGlb).toHaveBeenCalledTimes(1);
    // 2 s × 1.5.
    await elapse(2_999);
    expect(probeDerivedGlb).toHaveBeenCalledTimes(1);
    await elapse(1);
    expect(probeDerivedGlb).toHaveBeenCalledTimes(2);
    // × 1.5 again.
    await elapse(4_500);
    expect(probeDerivedGlb).toHaveBeenCalledTimes(3);
    // 4.5 s × 1.5 would be 6.75 s, and the cap is 5 s.
    await elapse(DERIVED_MAX_POLL_MS);
    expect(probeDerivedGlb).toHaveBeenCalledTimes(4);
    // And it stays there, rather than drifting up for the rest of a long
    // conversion: five seconds is already slower than the answer can arrive.
    await elapse(DERIVED_MAX_POLL_MS);
    expect(probeDerivedGlb).toHaveBeenCalledTimes(5);

    controller.abort();
    await expect(waiting).resolves.toMatchObject({ status: 'fallback', reason: 'cancelled' });
  });

  it('reports the elapsed wait once a second, and stops when the wait ends', async () => {
    const file = glb();
    probeDerivedGlb.mockResolvedValueOnce({ status: 'pending' }).mockResolvedValueOnce({ status: 'ready', file });
    const seen: number[] = [];
    const waiting = waitForDerivedGlb(HASH, 'bracket.step', { onElapsed: (ms) => seen.push(ms) });

    // Its own timer rather than a read at each poll: the polls back off to five
    // seconds apart, and a counter that advanced in five-second jumps looks
    // broken next to a spinner that is turning smoothly.
    await elapse(4_000);
    expect(seen).toEqual([1_000, 2_000, 3_000, 4_000]);
    expect(DERIVED_ELAPSED_TICK_MS).toBe(1_000);

    // The second poll is the one that lands, five seconds in.
    await elapse(DERIVED_FIRST_POLL_MS * 1.5);
    await expect(waiting).resolves.toEqual({ status: 'derived', file });

    // Read after the wait rather than pinned to a number: whether the tick that
    // falls on the same instant as the last poll lands before or after it is the
    // runtime's business, and neither answer is a bug.
    const ticks = seen.length;
    expect(ticks).toBeGreaterThanOrEqual(4);
    await elapse(5_000);
    // A clock left running would keep re-rendering the strip that showed it,
    // after the strip had gone.
    expect(seen).toHaveLength(ticks);
  });
});

describe('waitForDerivedGlb — a conversion that does not', () => {
  it('gives up on a failure, carrying the api\'s code and nothing else', async () => {
    probeDerivedGlb
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'failed', reason: 'convert_timeout' });
    const waiting = waitForDerivedGlb(HASH, 'bracket.step');

    await elapse(2_000);
    await elapse(3_000);

    // `detail` is a code from convert_service/errors.py: ours, content-free, and
    // the caller logs it rather than showing it, because "the server could not
    // convert it" is not something the person importing can act on.
    await expect(waiting).resolves.toEqual({
      status: 'fallback',
      reason: 'failed',
      detail: 'convert_timeout',
    });
    expect(probeDerivedGlb).toHaveBeenCalledTimes(2);
  });

  it('gives up at once when there never will be a derivative', async () => {
    // No polling first: 'unavailable' means no convert-service is configured, or
    // the file is a mesh that needed none, and neither is going to change while
    // we watch.
    probeDerivedGlb.mockResolvedValue({ status: 'unavailable' });
    const waiting = waitForDerivedGlb(HASH, 'bracket.step');

    await elapse(DERIVED_FIRST_POLL_MS);

    await expect(waiting).resolves.toEqual({ status: 'fallback', reason: 'unavailable', detail: null });
    expect(probeDerivedGlb).toHaveBeenCalledTimes(1);
  });

  it('answers rather than throwing, whatever the server said', async () => {
    // Every way this can go wrong ends with the caller holding the source file,
    // so every one of them is an instruction to tessellate rather than an
    // exception to catch — and a rejection here would be a second way to leave an
    // import stuck on "importing".
    for (const probe of [
      { status: 'failed', reason: null },
      { status: 'unavailable' },
    ] as DerivedGlbProbe[]) {
      probeDerivedGlb.mockReset().mockResolvedValue(probe);
      const waiting = waitForDerivedGlb(HASH, 'bracket.step');
      await elapse(DERIVED_FIRST_POLL_MS);
      await expect(waiting).resolves.toMatchObject({ status: 'fallback' });
    }
  });
});

describe('waitForDerivedGlb — "Open in browser instead"', () => {
  it('stops mid-wait, and asks nothing further', async () => {
    probeDerivedGlb.mockResolvedValue({ status: 'pending' });
    const controller = new AbortController();
    const waiting = waitForDerivedGlb(HASH, 'bracket.step', { signal: controller.signal });

    await elapse(DERIVED_FIRST_POLL_MS);
    expect(probeDerivedGlb).toHaveBeenCalledTimes(1);

    // Without waiting for the next interval: the person pressed a button and the
    // browser path they chose starts now, not in three seconds.
    controller.abort();
    await expect(waiting).resolves.toEqual({ status: 'fallback', reason: 'cancelled', detail: null });

    await elapse(60_000);
    expect(probeDerivedGlb).toHaveBeenCalledTimes(1);
  });

  it('asks nothing at all when it was cancelled before it started', async () => {
    // The panel unmounting between the upload settling and the wait beginning.
    const controller = new AbortController();
    controller.abort();

    await expect(
      waitForDerivedGlb(HASH, 'bracket.step', { signal: controller.signal }),
    ).resolves.toEqual({ status: 'fallback', reason: 'cancelled', detail: null });
    expect(probeDerivedGlb).not.toHaveBeenCalled();
  });

  it('stops the clock too', async () => {
    probeDerivedGlb.mockResolvedValue({ status: 'pending' });
    const controller = new AbortController();
    const seen: number[] = [];
    const waiting = waitForDerivedGlb(HASH, 'bracket.step', {
      signal: controller.signal,
      onElapsed: (ms) => seen.push(ms),
    });

    await elapse(2_000);
    controller.abort();
    await waiting;

    const ticks = seen.length;
    await elapse(10_000);
    expect(seen).toHaveLength(ticks);
  });
});
