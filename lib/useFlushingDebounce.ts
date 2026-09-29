import { useCallback, useEffect, useRef } from 'react';

/**
 * A debounced call that is never silently dropped.
 *
 * `schedule(value)` runs `run(value)` after `delayMs`, restarting the wait on
 * every call. A plain debounce cancels its timer when the component
 * unmounts, which is what lost curated work on the review setup page: capture
 * a viewpoint, press LOBBY within the 800 ms window, and the viewpoint never
 * reached the database (found walking docs/INSTALL.md). Here a pending value
 * is run immediately instead, on unmount and on `pagehide` (tab closed,
 * reload, navigation away from the app).
 *
 * `cancel()` drops the pending value on purpose, e.g. when an incoming remote
 * edit makes it stale.
 */
export function useFlushingDebounce<T>(
  run: (value: T) => void | Promise<unknown>,
  delayMs: number,
): { schedule: (value: T) => void; cancel: () => void } {
  const runRef = useRef(run);
  runRef.current = run;
  const pending = useRef<{ value: T } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const p = pending.current;
    pending.current = null;
    if (p) void runRef.current(p.value);
  }, []);

  const schedule = useCallback(
    (value: T) => {
      pending.current = { value };
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(flush, delayMs);
    },
    [delayMs, flush],
  );

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
  }, []);

  useEffect(() => {
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [flush]);

  return { schedule, cancel };
}
