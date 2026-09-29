import * as THREE from 'three';

// Module-level singleton — written by Agent.tsx useFrame, read by VRHeadsetTile mini-canvas.
// No React state: zero re-renders, safe to read/write at 60fps.
export const agentOrientations = new Map<string, THREE.Quaternion>();
export const agentPositions = new Map<string, THREE.Vector3>();
