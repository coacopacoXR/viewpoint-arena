// Waiting for the server to tessellate a CAD file.
//
// An upload of a STEP file answers immediately and leaves convert-service
// working on it (api/_lib/derivedJobs.ts), so the importer's next step is a
// wait: ask every couple of seconds whether the GLB is there yet, and say how
// long the wait has taken, because a 200 MB assembly takes minutes and a
// spinner with no clock on it looks like a hang.
//
// It lives here rather than in components/UI/SceneTree.tsx for two reasons. One
// is testability: the timing is the whole of this module's behaviour, and
// driving it under fake timers is a lot easier than driving a 1300-line panel
// through a file picker. The other is that the wait has to be ABANDONABLE — the
// panel shows "Open in browser instead" for as long as it runs, and a conversion
// that failed or a deployment that has no convert-service ends it too — so the
// loop and the escape hatch are the same piece of logic and belong together.
//
// Nothing here touches React or the store: it is a promise that resolves with
// either the derivative or the reason there is not one, and the caller decides
// what to render and what to broadcast.

import { probeDerivedGlb } from '../modelsClient';

/**
 * How soon the first poll goes out.
 *
 * Two seconds, which is longer than a small file takes (convert-service
 * tessellates a bracket in well under a second) and short enough that the common
 * case feels immediate rather than polled. Asking sooner would mostly catch the
 * api mid-conversion and cost a request for nothing.
 */
export const DERIVED_FIRST_POLL_MS = 2_000;

/**
 * How far apart the polls drift to.
 *
 * Five seconds, and the drift is the point: a conversion that has not finished
 * in the first few seconds is a big assembly that will not finish in the next
 * one either, so there is nothing to gain by asking at the opening rate for the
 * whole of a five-minute tessellation. Backing off keeps a room full of
 * participants who all imported the same file from turning one conversion into a
 * request each, every two seconds, until it lands.
 */
export const DERIVED_MAX_POLL_MS = 5_000;

/** Each poll waits this much longer than the last, until DERIVED_MAX_POLL_MS. */
const DERIVED_POLL_BACKOFF = 1.5;

/**
 * How often the elapsed clock is reported.
 *
 * Its own timer rather than a read at each poll, because polls back off to five
 * seconds apart and a counter that advanced in five-second jumps looks broken
 * next to a spinner that is turning smoothly.
 */
export const DERIVED_ELAPSED_TICK_MS = 1_000;

/** How the wait ended. */
export type DerivedImportOutcome =
  /** The derivative is stored, and here it is. Broadcast 'derived-glb'. */
  | { status: 'derived'; file: File }
  /**
   * There is no derivative to wait for. Broadcast 'source' and tessellate the
   * file in the browser, which is what the app did before convert-service
   * existed and still does on every deployment that has not configured one.
   *
   * `reason` says why, and the three are worth telling apart even though the
   * caller does the same thing for all of them: 'cancelled' is the person who
   * pressed "Open in browser instead" and needs no explanation, while 'failed'
   * and 'unavailable' are the server's answer and are the cases where the
   * slow-import warning belongs back on screen. `detail` is the api's failure
   * code for a 'failed', and null otherwise — a code, never a message, and
   * never anything from inside the file.
   */
  | { status: 'fallback'; reason: 'cancelled' | 'failed' | 'unavailable'; detail: string | null };

export interface DerivedImportOptions {
  /** Aborted by "Open in browser instead", and by the panel unmounting. */
  signal?: AbortSignal;
  /** How long the wait has been running, once a second, for the status strip. */
  onElapsed?: (elapsedMs: number) => void;
}

/**
 * Wait for `hash`'s derived GLB, and answer with it or with the reason to give
 * up on it.
 *
 * Never rejects: every way this can go wrong — a conversion that failed, a
 * deployment with no convert-service, a source that has been deleted, a network
 * that dropped — is an answer rather than an exception, because in every one of
 * them the caller is holding the source file and can still put the model on
 * screen. A rejection here would be a second path for the panel to handle and a
 * second way to leave an import stuck on "importing".
 *
 * There is deliberately no overall deadline. convert-service has its own
 * (CONVERT_TIMEOUT_SECONDS), and a conversion that hits it comes back as
 * 'failed' rather than as a 202 that never ends; the escape for an api wedged
 * in 'pending' is the button the caller shows for the whole wait, which is a
 * better answer than a timeout that gives up on a tessellation that was about to
 * land.
 */
export async function waitForDerivedGlb(
  hash: string,
  fileName: string,
  options: DerivedImportOptions = {},
): Promise<DerivedImportOutcome> {
  const { signal, onElapsed } = options;
  const startedAt = Date.now();
  const clock = onElapsed
    ? setInterval(() => onElapsed(Date.now() - startedAt), DERIVED_ELAPSED_TICK_MS)
    : null;

  const cancelled = (): boolean => signal?.aborted === true;

  try {
    let wait = DERIVED_FIRST_POLL_MS;
    for (;;) {
      if (cancelled()) return { status: 'fallback', reason: 'cancelled', detail: null };
      // Checked before the first ask as well as after it: a person who pressed
      // the button while the upload was still settling should not pay for a
      // request whose answer is going to be thrown away.
      await sleep(wait, signal);
      if (cancelled()) return { status: 'fallback', reason: 'cancelled', detail: null };

      const probe = await probeDerivedGlb(hash, fileName);
      if (probe.status === 'ready') return { status: 'derived', file: probe.file };
      if (probe.status === 'failed') {
        return { status: 'fallback', reason: 'failed', detail: probe.reason };
      }
      if (probe.status === 'unavailable') {
        return { status: 'fallback', reason: 'unavailable', detail: null };
      }
      wait = Math.min(wait * DERIVED_POLL_BACKOFF, DERIVED_MAX_POLL_MS);
    }
  } finally {
    if (clock !== null) clearInterval(clock);
  }
}

/**
 * Wait `ms`, or until `signal` aborts, whichever happens first.
 *
 * Resolving rather than rejecting on an abort is what lets the loop above read
 * as a straight line: it wakes up, notices the cancellation at the top of the
 * next turn and answers 'cancelled' itself, instead of a throw having to be
 * caught somewhere that then has to know what a cancellation meant.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}
