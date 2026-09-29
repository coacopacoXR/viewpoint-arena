import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Homography } from './fingerPointerRef';
import { IDENTITY_HOMOGRAPHY } from './fingerPointerRef';

// Persisted: the calibration result. We keep the raw 4 corner samples so a
// future tweak (e.g. swapping homography for bilinear) can recompute without
// re-running the user through calibration.
export interface CalibrationData {
  // Camera-NDC samples captured at each screen corner, in this order:
  // top-left, top-right, bottom-right, bottom-left.
  cornerSamples: [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ];
  homography: Homography;
  capturedAt: number; // ms timestamp
}

export type FingerPointerMode =
  | 'disabled'    // feature off (default until the user opts in)
  | 'prompt'      // first-run prompt visible
  | 'calibrating' // running the 4-corner calibration
  | 'active';     // tracking + projecting

// Tracker readiness — observable so UIs can show progress without polling.
export type TrackerStatus =
  | 'idle'         // not running
  | 'camera'       // requesting webcam permission / opening stream
  | 'model'        // loading MediaPipe WASM + hand landmarker model
  | 'ready'        // streaming + detecting
  | 'error';

interface FingerPointerState {
  mode: FingerPointerMode;
  calibration: CalibrationData | null;
  cameraError: string | null;
  trackerStatus: TrackerStatus;

  // Actions
  setMode: (mode: FingerPointerMode) => void;
  setCalibration: (cal: CalibrationData | null) => void;
  setCameraError: (err: string | null) => void;
  setTrackerStatus: (status: TrackerStatus) => void;

  // Convenience: open the first-run prompt if no calibration exists,
  // otherwise jump straight to active mode.
  enableFingerPointer: () => void;
  disableFingerPointer: () => void;
  startRecalibration: () => void;
}

export const useFingerPointerStore = create<FingerPointerState>()(
  persist(
    (set, get) => ({
      mode: 'disabled',
      calibration: null,
      cameraError: null,
      trackerStatus: 'idle',

      setMode: (mode) => set({ mode }),
      setCalibration: (calibration) => set({ calibration }),
      setCameraError: (cameraError) => set({ cameraError }),
      setTrackerStatus: (trackerStatus) => set({ trackerStatus }),

      enableFingerPointer: () => {
        const { calibration } = get();
        set({ mode: calibration ? 'active' : 'prompt', cameraError: null });
      },
      disableFingerPointer: () => set({ mode: 'disabled', cameraError: null }),
      startRecalibration: () => set({ mode: 'calibrating', cameraError: null }),
    }),
    {
      name: 'vp_finger_pointer',
      // Only persist the calibration; the mode is session-local.
      partialize: (state) => ({ calibration: state.calibration }),
    },
  ),
);

export const getActiveHomography = (): Homography => {
  return useFingerPointerStore.getState().calibration?.homography ?? IDENTITY_HOMOGRAPHY;
};
