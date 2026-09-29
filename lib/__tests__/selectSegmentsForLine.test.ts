// Tests for selectSegmentsForLine — the pure function that matches pointing
// segments to transcript lines. Also tests for pointingTimelineStore (cap,
// clear, add).

import { describe, it, expect, beforeEach } from 'vitest';
import { selectSegmentsForLine, LINE_WINDOW_MS } from '../selectSegmentsForLine';
import { usePointingTimelineStore, MAX_SEGMENTS, type PointingSegment } from '../pointingTimelineStore';
import type { ChatMessage } from '../../types';

// ─── selectSegmentsForLine ──────────────────────────────────────────────────

function makeLine(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'line-1',
    agentId: 'live-transcript',
    text: 'hello',
    timestamp: Date.now(),
    speakerId: 'user-1',
    offsetMs: 1000,
    ...overrides,
  };
}

function makeSeg(overrides: Partial<PointingSegment> = {}): PointingSegment {
  return {
    userId: 'user-1',
    userName: 'Alice',
    partId: 'part-1',
    partName: 'Left Ear Cup',
    source: 'laser',
    fromMs: 500,
    toMs: 2000,
    ...overrides,
  };
}

describe('selectSegmentsForLine', () => {
  it('returns null when the line has no offsetMs', () => {
    const line = makeLine({ offsetMs: undefined });
    const segs = [makeSeg()];
    expect(selectSegmentsForLine(segs, line)).toBeNull();
  });

  it('returns null when the line has no speakerId', () => {
    const line = makeLine({ speakerId: undefined });
    const segs = [makeSeg()];
    expect(selectSegmentsForLine(segs, line)).toBeNull();
  });

  it('returns null when no segment overlaps the line window', () => {
    const line = makeLine({ offsetMs: 5000 });
    const segs = [makeSeg({ fromMs: 0, toMs: 1000 })];
    expect(selectSegmentsForLine(segs, line)).toBeNull();
  });

  it('returns null when segments are from a different speaker', () => {
    const line = makeLine({ offsetMs: 1000, speakerId: 'user-1' });
    const segs = [makeSeg({ userId: 'user-2', fromMs: 500, toMs: 3000 })];
    expect(selectSegmentsForLine(segs, line)).toBeNull();
  });

  it('picks the segment with the longest overlap', () => {
    const line = makeLine({ offsetMs: 1000, speakerId: 'user-1' });
    const segs = [
      makeSeg({ partName: 'Short', fromMs: 1000, toMs: 1500 }),
      makeSeg({ partName: 'Long', fromMs: 1000, toMs: 5000 }),
    ];
    const result = selectSegmentsForLine(segs, line);
    expect(result).not.toBeNull();
    expect(result!.partName).toBe('Long');
  });

  it('matches a segment that partially overlaps the line window', () => {
    const line = makeLine({ offsetMs: 1000, speakerId: 'user-1' });
    const lineEnd = 1000 + LINE_WINDOW_MS;
    const segs = [makeSeg({ fromMs: lineEnd - 500, toMs: lineEnd + 2000 })];
    const result = selectSegmentsForLine(segs, line);
    expect(result).not.toBeNull();
    expect(result!.partName).toBe('Left Ear Cup');
  });

  it('returns null for an empty segment list', () => {
    const line = makeLine();
    expect(selectSegmentsForLine([], line)).toBeNull();
  });
});

// ─── pointingTimelineStore ──────────────────────────────────────────────────

describe('pointingTimelineStore', () => {
  beforeEach(() => {
    usePointingTimelineStore.getState().clear();
  });

  it('starts empty', () => {
    expect(usePointingTimelineStore.getState().segments).toEqual([]);
  });

  it('adds a segment', () => {
    const seg = makeSeg();
    usePointingTimelineStore.getState().addSegment(seg);
    expect(usePointingTimelineStore.getState().segments).toHaveLength(1);
    expect(usePointingTimelineStore.getState().segments[0]).toEqual(seg);
  });

  it('clears all segments', () => {
    usePointingTimelineStore.getState().addSegment(makeSeg());
    usePointingTimelineStore.getState().addSegment(makeSeg({ partId: 'part-2' }));
    expect(usePointingTimelineStore.getState().segments).toHaveLength(2);
    usePointingTimelineStore.getState().clear();
    expect(usePointingTimelineStore.getState().segments).toHaveLength(0);
  });

  it('caps at MAX_SEGMENTS and drops the oldest', () => {
    const store = usePointingTimelineStore.getState();
    for (let i = 0; i < MAX_SEGMENTS + 5; i++) {
      store.addSegment(makeSeg({ partId: `part-${i}`, fromMs: i * 1000, toMs: i * 1000 + 500 }));
    }
    const segs = usePointingTimelineStore.getState().segments;
    expect(segs).toHaveLength(MAX_SEGMENTS);
    // The first 5 should have been dropped; the oldest remaining is part-5.
    expect(segs[0].partId).toBe('part-5');
  });

  it('addSegments caps correctly', () => {
    const store = usePointingTimelineStore.getState();
    const batch: PointingSegment[] = [];
    for (let i = 0; i < MAX_SEGMENTS + 10; i++) {
      batch.push(makeSeg({ partId: `part-${i}`, fromMs: i * 1000, toMs: i * 1000 + 500 }));
    }
    store.addSegments(batch);
    const segs = usePointingTimelineStore.getState().segments;
    expect(segs).toHaveLength(MAX_SEGMENTS);
    expect(segs[0].partId).toBe('part-10');
  });
});
