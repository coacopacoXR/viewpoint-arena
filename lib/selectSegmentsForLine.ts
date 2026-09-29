// Pure function: pick the pointing segment that best overlaps a transcript
// line's time window. Exported separately from the hook so it is testable
// without React and so batch D can reuse it for the extraction prompt.
//
// A transcript line occupies [offsetMs, offsetMs + LINE_WINDOW_MS). We look
// for segments from the SAME speaker that overlap this window and pick the
// one with the longest overlap. Returns null when no segment qualifies.

import type { PointingSegment } from './pointingTimelineStore';
import type { ChatMessage } from '../types';

export const LINE_WINDOW_MS = 8000;

export function selectSegmentsForLine(
  segments: PointingSegment[],
  line: ChatMessage,
): PointingSegment | null {
  if (typeof line.offsetMs !== 'number') return null;

  const lineStart = line.offsetMs;
  const lineEnd = lineStart + LINE_WINDOW_MS;
  const speakerId = line.speakerId;
  if (!speakerId) return null;

  let best: PointingSegment | null = null;
  let bestOverlap = 0;

  for (const seg of segments) {
    if (seg.userId !== speakerId) continue;
    const overlapStart = Math.max(seg.fromMs, lineStart);
    const overlapEnd = Math.min(seg.toMs, lineEnd);
    const overlap = overlapEnd - overlapStart;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = seg;
    }
  }

  return best;
}
