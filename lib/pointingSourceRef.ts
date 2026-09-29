// Module-level ref for the local user's current pointing source.
// Written by UserLaser every frame alongside setLaserEntry; read by
// usePointingTimeline at 2 Hz to tag each sample with its origin.
//
// The laser raycaster is the single source of truth for "what part am I
// pointing at" regardless of input method (mouse/key, finger, hover-dwell).
// This ref records *which* input method is driving it so the timeline can
// distinguish explicit pointing from passive hover.

export type PointingSource = 'laser' | 'finger' | 'hover';

export const pointingSourceRef: { current: PointingSource | null } = { current: null };
