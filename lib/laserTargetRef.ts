// Module-level maps for laser target tracking — same pattern as xrPresenceRef.ts.
// Written by usePartyPresence LASER_MOVE handler + the local UserLaser/MobileLaser.
// Read imperatively in useFrame consumers (e.g. Headphones for emissive glow).
//
// Keys are userId strings. The LOCAL user writes their own entry here as well
// so model components can highlight what the local user is pointing at (without
// roundtripping through the network).
export const remoteLaserTargets    = new Map<string, string | null>();
export const remoteLaserColors     = new Map<string, string>();
export const remoteLaserMeshNames  = new Map<string, string | null>(); // userId → hit mesh index from GLB
export const remoteLaserPartNames  = new Map<string, string | null>(); // userId → clean readable part name
export const remoteLaserLastUpdate = new Map<string, number>();        // userId → ms timestamp of last write

// If we haven't heard from a pointer in this many ms, treat it as off.
// Guards against lost "off" broadcasts (network glitch, tab focus loss).
export const LASER_TTL_MS = 1500;

export function isLaserEntryFresh(userId: string): boolean {
  const t = remoteLaserLastUpdate.get(userId);
  if (!t) return false;
  return Date.now() - t < LASER_TTL_MS;
}

export function clearLaserEntry(userId: string) {
  remoteLaserTargets.delete(userId);
  remoteLaserColors.delete(userId);
  remoteLaserMeshNames.delete(userId);
  remoteLaserPartNames.delete(userId);
  remoteLaserLastUpdate.delete(userId);
}

export function setLaserEntry(
  userId: string,
  targetId: string | null,
  meshIndex: string | null,
  partName: string | null,
  color: string,
) {
  remoteLaserTargets.set(userId, targetId);
  remoteLaserMeshNames.set(userId, meshIndex);
  remoteLaserPartNames.set(userId, partName);
  remoteLaserColors.set(userId, color);
  remoteLaserLastUpdate.set(userId, Date.now());
}
