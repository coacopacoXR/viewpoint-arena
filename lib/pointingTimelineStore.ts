// Room-wide pointing segments, shared across all clients via POINTING_SEGMENT
// broadcasts. Capped at MAX_SEGMENTS (oldest dropped) so a long meeting cannot
// grow without bound. Cleared when a new recording starts.

import { create } from 'zustand';

export type PointingSegmentSource = 'laser' | 'finger' | 'hover';

export interface PointingSegment {
  userId: string;
  userName: string;
  partId: string;
  partName: string;
  source: PointingSegmentSource;
  fromMs: number;
  toMs: number;
}

export const MAX_SEGMENTS = 2000;

interface PointingTimelineState {
  segments: PointingSegment[];
  addSegment: (seg: PointingSegment) => void;
  addSegments: (segs: PointingSegment[]) => void;
  clear: () => void;
}

export const usePointingTimelineStore = create<PointingTimelineState>()((set) => ({
  segments: [],

  addSegment: (seg) =>
    set((state) => {
      const next = [...state.segments, seg];
      if (next.length > MAX_SEGMENTS) next.splice(0, next.length - MAX_SEGMENTS);
      return { segments: next };
    }),

  addSegments: (segs) =>
    set((state) => {
      if (segs.length === 0) return state;
      const next = [...state.segments, ...segs];
      if (next.length > MAX_SEGMENTS) next.splice(0, next.length - MAX_SEGMENTS);
      return { segments: next };
    }),

  clear: () => set({ segments: [] }),
}));
