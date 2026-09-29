// Module-level mutable ref for the finger pointer — same pattern as
// mobileLaserRef.ts and xrPresenceRef.ts. Written by the hand tracker every
// camera frame, read by the laser in useFrame.

export interface HandLandmark { x: number; y: number; z: number }

export interface FingerPointerSnapshot {
  // Aim point in camera NDC ([-1..1, -1..1]). X is mirrored so moving your
  // hand right moves the value right from the user's POV. This is the
  // direction-extrapolated point ("where you mean"), not the raw fingertip.
  fingertipRaw: [number, number] | null;
  // Screen-space NDC after homography ([-1..1, -1..1]). Same coord system
  // Three.js raycaster uses, so this drops directly into setFromCamera.
  pointerNDC: [number, number] | null;
  // True when the "index extended, others curled" pose is detected.
  isPointing: boolean;
  // Full 21 landmarks in image-space [0..1] (top-left origin, NOT mirrored).
  // Consumers that draw an overlay on the raw video read this directly.
  landmarks: HandLandmark[] | null;
  // Extrapolated aim point in image space (0..1, top-left origin) — used by
  // the calibration overlay to draw a "where you're aiming" marker on the video.
  aimImage: { x: number; y: number } | null;
  // Monotonic timestamp (ms) of last update; consumers can TTL stale snapshots.
  lastUpdate: number;
}

export const fingerPointerRef: FingerPointerSnapshot = {
  fingertipRaw: null,
  pointerNDC: null,
  isPointing: false,
  landmarks: null,
  aimImage: null,
  lastUpdate: 0,
};

// MediaPipe Hand topology — edges between landmarks for skeleton rendering.
export const HAND_CONNECTIONS: Array<[number, number]> = [
  // Thumb
  [0, 1], [1, 2], [2, 3], [3, 4],
  // Index
  [0, 5], [5, 6], [6, 7], [7, 8],
  // Middle
  [5, 9], [9, 10], [10, 11], [11, 12],
  // Ring
  [9, 13], [13, 14], [14, 15], [15, 16],
  // Pinky
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

// 3×3 row-major homography. Identity by default.
export type Homography = [number, number, number, number, number, number, number, number, number];

export const IDENTITY_HOMOGRAPHY: Homography = [1, 0, 0, 0, 1, 0, 0, 0, 1];

// Applies a 3x3 homography to a 2D point (in NDC). Returns dehomogenized [x, y].
export function applyHomography(H: Homography, x: number, y: number): [number, number] {
  const w = H[6] * x + H[7] * y + H[8];
  const nx = (H[0] * x + H[1] * y + H[2]) / w;
  const ny = (H[3] * x + H[4] * y + H[5]) / w;
  return [nx, ny];
}

// Solves the 3x3 homography mapping 4 source points to 4 destination points
// using a direct linear transform. Returns null on degenerate input.
export function solveHomography(
  src: [[number, number], [number, number], [number, number], [number, number]],
  dst: [[number, number], [number, number], [number, number], [number, number]],
): Homography | null {
  // Build 8x8 linear system Ah = b where h = [h00 h01 h02 h10 h11 h12 h20 h21]
  // and h22 = 1.
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [sx, sy] = src[i];
    const [dx, dy] = dst[i];
    A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]); b.push(dx);
    A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]); b.push(dy);
  }
  const h = solveLinearSystem(A, b);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

// Gaussian elimination with partial pivoting. Returns null if singular.
function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++) {
      if (Math.abs(M[r][i]) > Math.abs(M[pivot][i])) pivot = r;
    }
    if (Math.abs(M[pivot][i]) < 1e-10) return null;
    if (pivot !== i) [M[i], M[pivot]] = [M[pivot], M[i]];

    for (let r = i + 1; r < n; r++) {
      const factor = M[r][i] / M[i][i];
      for (let c = i; c <= n; c++) M[r][c] -= factor * M[i][c];
    }
  }

  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = M[i][n];
    for (let c = i + 1; c < n; c++) sum -= M[i][c] * x[c];
    x[i] = sum / M[i][i];
  }
  return x;
}
