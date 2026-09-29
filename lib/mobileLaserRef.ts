// Module-level mutable ref shared between MobileRoomView (writer) and MobileLaser (reader).
// Using a plain object instead of Zustand avoids React re-render timing issues inside R3F's fiber.
export const mobileLaserRef: { ndc: [number, number] | null } = { ndc: null };
