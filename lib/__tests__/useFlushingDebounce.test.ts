import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFlushingDebounce } from '../useFlushingDebounce';

describe('useFlushingDebounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs once, with the latest value, after the delay', () => {
    const run = vi.fn();
    const { result } = renderHook(() => useFlushingDebounce(run, 800));
    act(() => { result.current.schedule('a'); result.current.schedule('b'); });
    expect(run).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(800); });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('b');
  });

  it('runs a pending value immediately on unmount instead of dropping it', () => {
    // The review setup page lost a just-captured viewpoint this way: LOBBY
    // pressed inside the debounce window unmounted the page and the timer died.
    const run = vi.fn();
    const { result, unmount } = renderHook(() => useFlushingDebounce(run, 800));
    act(() => { result.current.schedule('viewpoint added'); });
    unmount();
    expect(run).toHaveBeenCalledWith('viewpoint added');
    act(() => { vi.advanceTimersByTime(800); });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs a pending value on pagehide (tab closed or reloaded)', () => {
    const run = vi.fn();
    const { result } = renderHook(() => useFlushingDebounce(run, 800));
    act(() => { result.current.schedule('x'); });
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(run).toHaveBeenCalledWith('x');
  });

  it('cancel() drops the pending value, and unmount then runs nothing', () => {
    const run = vi.fn();
    const { result, unmount } = renderHook(() => useFlushingDebounce(run, 800));
    act(() => { result.current.schedule('stale'); result.current.cancel(); });
    unmount();
    act(() => { vi.advanceTimersByTime(800); });
    expect(run).not.toHaveBeenCalled();
  });
});
