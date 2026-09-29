import type { HandLandmark } from './fingerPointerRef';

// Index finger landmark indices.
const IDX_MCP = 5;
const IDX_PIP = 6;
const IDX_TIP = 8;

// How far past the fingertip to project, in units of (TIP - PIP) length.
// Tuned empirically: 1.5 puts the "aimed point" roughly where users intend.
const EXTRAPOLATION_FACTOR = 1.5;

// Returns a synthesized "where the user is aiming" point in image-NDC, derived
// from the index finger's direction. Falls back to the raw fingertip if the
// finger is too curled/short to give a stable direction.
export interface PointingAim {
  aimImage: { x: number; y: number };   // in image space (0..1, top-left origin), mirrored: false
  aimNDC:   { x: number; y: number };   // NDC ([-1..1]), X mirrored so right hand = right pointer
  tipImage: { x: number; y: number };   // raw fingertip in image space (for overlay rendering)
  pipImage: { x: number; y: number };   // PIP joint in image space (for overlay rendering)
}

export function computePointingAim(landmarks: HandLandmark[]): PointingAim | null {
  if (landmarks.length < 21) return null;
  const tip = landmarks[IDX_TIP];
  const pip = landmarks[IDX_PIP];
  const mcp = landmarks[IDX_MCP];

  // Length sanity check: extended finger has TIP-MCP > some minimum fraction of image.
  const segLen = Math.hypot(tip.x - mcp.x, tip.y - mcp.y);
  if (segLen < 0.04) {
    // Finger probably curled — extrapolation would amplify noise. Use raw tip.
    return {
      aimImage: { x: tip.x, y: tip.y },
      aimNDC:   { x: (0.5 - tip.x) * 2, y: (0.5 - tip.y) * 2 },
      tipImage: { x: tip.x, y: tip.y },
      pipImage: { x: pip.x, y: pip.y },
    };
  }

  // Direction of the last two segments (PIP→TIP). This is the part of the
  // finger doing the actual pointing — using MCP would smear in knuckle bend.
  const dx = tip.x - pip.x;
  const dy = tip.y - pip.y;

  const aimX = tip.x + dx * EXTRAPOLATION_FACTOR;
  const aimY = tip.y + dy * EXTRAPOLATION_FACTOR;

  return {
    aimImage: { x: aimX, y: aimY },
    aimNDC:   { x: (0.5 - aimX) * 2, y: (0.5 - aimY) * 2 },
    tipImage: { x: tip.x, y: tip.y },
    pipImage: { x: pip.x, y: pip.y },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// One Euro Filter — Casiez et al. 2012
// Adaptive low-pass filter: tight smoothing at rest, low latency under motion.
// Reference values: minCutoff=1.0 Hz, beta=0.007 are good defaults for UI pointer.
// ────────────────────────────────────────────────────────────────────────────
export class OneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  private xPrev = 0;
  private dxPrev = 0;
  private tPrev = 0;
  private initialized = false;

  constructor(minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  reset(): void { this.initialized = false; }

  filter(x: number, tMs: number): number {
    if (!this.initialized) {
      this.xPrev = x;
      this.dxPrev = 0;
      this.tPrev = tMs;
      this.initialized = true;
      return x;
    }
    const dt = Math.max(0.001, (tMs - this.tPrev) / 1000); // seconds
    const dx = (x - this.xPrev) / dt;
    const aD = alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    this.tPrev = tMs;
    return xHat;
  }
}

function alpha(cutoff: number, dt: number): number {
  const tau = 1.0 / (2 * Math.PI * cutoff);
  return 1.0 / (1.0 + tau / dt);
}

// ────────────────────────────────────────────────────────────────────────────
// Linear-weighted rolling average.
// Stores the last `size` samples and returns their weighted mean where the most
// recent sample has weight `size` and the oldest has weight 1. Compared to a
// flat SMA this gives most of the smoothing benefit with about half the lag.
// Reset on pose change so re-engagement doesn't carry old samples.
// ────────────────────────────────────────────────────────────────────────────
export class RollingAverage {
  private buf: number[] = [];
  private readonly size: number;

  constructor(size = 10) { this.size = Math.max(1, size); }

  push(value: number): number {
    this.buf.push(value);
    if (this.buf.length > this.size) this.buf.shift();

    let sum = 0;
    let weight = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const w = i + 1; // 1, 2, … N (oldest → newest)
      sum += this.buf[i] * w;
      weight += w;
    }
    return sum / weight;
  }

  reset(): void { this.buf = []; }
}
