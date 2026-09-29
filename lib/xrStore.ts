import { createXRStore } from '@react-three/xr';

// Singleton — imported by XRButton (outside canvas) and ViewpointCanvas (inside)
export const xrStore = createXRStore({
  controller: true,
  hand: false,
  // @react-three/xr injects its WebXR emulator (IWER, with a floating
  // "Enter XR" pill over the room header) whenever the page's hostname is
  // `localhost`. Useful under `npm run dev`; wrong in a production build, which
  // the self-hosted stack serves at https://localhost/ by default.
  emulate: import.meta.env.DEV ? undefined : false,
});
