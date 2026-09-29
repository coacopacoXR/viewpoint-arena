import { useEffect, useRef } from 'react';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { fingerPointerRef, applyHomography } from './fingerPointerRef';
import { getActiveHomography, useFingerPointerStore } from './fingerPointerStore';
import { computePointingAim, OneEuroFilter, RollingAverage } from './pointingMath';

// MediaPipe landmark indices (Hand Landmarks model).
const TIP = { thumb: 4, index: 8, middle: 12, ring: 16, pinky: 20 };
const PIP = { index: 6, middle: 10, ring: 14, pinky: 18 };
const MCP = { index: 5, middle: 9, ring: 13, pinky: 17 };

interface Landmark { x: number; y: number; z: number }

// "Index extended, others curled" detector.
function isPointingPose(landmarks: Landmark[]): boolean {
  if (landmarks.length < 21) return false;
  const wrist = landmarks[0];
  const dist = (a: Landmark, b: Landmark) => {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.hypot(dx, dy);
  };

  const indexExtended = dist(landmarks[TIP.index], wrist) > dist(landmarks[PIP.index], wrist) * 1.15;
  const middleCurled  = dist(landmarks[TIP.middle], wrist) < dist(landmarks[MCP.middle], wrist) * 1.15;
  const ringCurled    = dist(landmarks[TIP.ring], wrist)   < dist(landmarks[MCP.ring], wrist) * 1.15;
  const pinkyCurled   = dist(landmarks[TIP.pinky], wrist)  < dist(landmarks[MCP.pinky], wrist) * 1.15;

  return indexExtended && middleCurled && ringCurled && pinkyCurled;
}

// Cached promise for the hand landmarker. Cleared on failure so a retry can succeed.
let landmarkerPromise: Promise<HandLandmarker> | null = null;

async function loadHandLandmarker(): Promise<HandLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      try {
        console.log('[FingerPointer] loading MediaPipe WASM…');
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm',
        );
        console.log('[FingerPointer] WASM loaded, fetching hand landmarker model…');
        // Try GPU first; fall back to CPU if the platform doesn't support it.
        try {
          const lm = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
              delegate: 'GPU',
            },
            runningMode: 'VIDEO',
            numHands: 1,
          });
          console.log('[FingerPointer] hand landmarker ready (GPU)');
          return lm;
        } catch (gpuErr) {
          console.warn('[FingerPointer] GPU delegate failed, falling back to CPU:', gpuErr);
          const lm = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
              delegate: 'CPU',
            },
            runningMode: 'VIDEO',
            numHands: 1,
          });
          console.log('[FingerPointer] hand landmarker ready (CPU)');
          return lm;
        }
      } catch (err) {
        // Clear cache so the next call retries fresh.
        landmarkerPromise = null;
        throw err;
      }
    })();
  }
  return landmarkerPromise;
}

interface UseHandTrackerOptions {
  enabled: boolean;
  onSample?: (sample: { x: number; y: number; isPointing: boolean }) => void;
  // If provided, attach the camera stream to this element instead of a hidden one.
  // Used by the calibration UI to render a visible mirror view.
  videoElement?: HTMLVideoElement | null;
}

export function useHandTracker({ enabled, onSample, videoElement }: UseHandTrackerOptions) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onSampleRef = useRef(onSample);
  onSampleRef.current = onSample;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const { setCameraError, setTrackerStatus } = useFingerPointerStore.getState();

    let ownedVideo: HTMLVideoElement | null = null;
    let video: HTMLVideoElement;

    if (videoElement) {
      video = videoElement;
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
    } else {
      ownedVideo = document.createElement('video');
      ownedVideo.autoplay = true;
      ownedVideo.muted = true;
      ownedVideo.playsInline = true;
      // Off-screen instead of display:none — some browsers refuse to play hidden video.
      ownedVideo.style.position = 'fixed';
      ownedVideo.style.top = '-9999px';
      ownedVideo.style.left = '-9999px';
      ownedVideo.style.width = '1px';
      ownedVideo.style.height = '1px';
      document.body.appendChild(ownedVideo);
      video = ownedVideo;
    }
    videoRef.current = video;

    let landmarker: HandLandmarker | null = null;
    // 1€ filters — outlier/jitter rejection. Looser cutoff now that a rolling
    // window does the bulk of the smoothing downstream.
    const filterX = new OneEuroFilter(1.2, 0.012, 1.0);
    const filterY = new OneEuroFilter(1.2, 0.012, 1.0);
    const rawFilterX = new OneEuroFilter(1.5, 0.02, 1.0);
    const rawFilterY = new OneEuroFilter(1.5, 0.02, 1.0);
    // Rolling weighted averages — the main "calm" filter. 16 samples at ~30fps
    // ≈ 530 ms window, linear weights so recent samples dominate.
    const rollX = new RollingAverage(16);
    const rollY = new RollingAverage(16);
    const rawRollX = new RollingAverage(10);
    const rawRollY = new RollingAverage(10);

    (async () => {
      try {
        setCameraError(null);
        setTrackerStatus('camera');
        console.log('[FingerPointer] requesting camera…');

        if (!window.isSecureContext) {
          throw new Error(`Camera requires HTTPS or localhost (current origin: ${location.origin}). If you're testing via IP, open the app at http://localhost:${location.port || '3000'} instead.`);
        }
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('getUserMedia not available in this browser/context');
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: 'user' },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        video.srcObject = stream;
        await video.play();
        console.log('[FingerPointer] camera streaming, video size:', video.videoWidth, 'x', video.videoHeight);

        setTrackerStatus('model');
        landmarker = await loadHandLandmarker();
        if (cancelled) return;

        setTrackerStatus('ready');
        loop();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[FingerPointer] init failed:', err);
        setCameraError(message);
        setTrackerStatus('error');
      }
    })();

    const loop = () => {
      if (cancelled) return;
      if (!landmarker || !video || video.readyState < 2) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      const t = performance.now();
      let result;
      try {
        result = landmarker.detectForVideo(video, t);
      } catch (err) {
        console.error('[FingerPointer] detectForVideo threw:', err);
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      const landmarks = result.landmarks?.[0];

      if (landmarks && landmarks.length >= 21) {
        const pointing = isPointingPose(landmarks);
        const aim = computePointingAim(landmarks);

        if (aim) {
          // Adaptive/Wii-style pointing: as soon as the hand is detected we
          // project the calibrated aim point through the homography. The pose
          // (index-extended-others-curled) is no longer required — the user
          // learns the mapping by watching the dot, and the dot is always there
          // to learn from. We keep `isPointing` on the ref for diagnostics only.
          const rawX0 = rawFilterX.filter(aim.aimNDC.x, t);
          const rawY0 = rawFilterY.filter(aim.aimNDC.y, t);
          const rawX = rawRollX.push(rawX0);
          const rawY = rawRollY.push(rawY0);

          fingerPointerRef.fingertipRaw = [rawX, rawY];
          fingerPointerRef.aimImage = { x: aim.aimImage.x, y: aim.aimImage.y };
          fingerPointerRef.landmarks = landmarks;
          fingerPointerRef.isPointing = pointing;
          fingerPointerRef.lastUpdate = Date.now();

          const H = getActiveHomography();
          const [px, py] = applyHomography(H, rawX, rawY);
          const sx0 = filterX.filter(px, t);
          const sy0 = filterY.filter(py, t);
          const sx = rollX.push(sx0);
          const sy = rollY.push(sy0);
          fingerPointerRef.pointerNDC = [sx, sy];

          onSampleRef.current?.({ x: rawX, y: rawY, isPointing: pointing });
        }
      } else {
        fingerPointerRef.fingertipRaw = null;
        fingerPointerRef.pointerNDC = null;
        fingerPointerRef.isPointing = false;
        fingerPointerRef.landmarks = null;
        fingerPointerRef.aimImage = null;
        fingerPointerRef.lastUpdate = Date.now();
        filterX.reset(); filterY.reset();
        rawFilterX.reset(); rawFilterY.reset();
        rollX.reset(); rollY.reset();
        rawRollX.reset(); rawRollY.reset();
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (video) video.srcObject = null;
      // Only remove the element if we created it.
      if (ownedVideo) ownedVideo.remove();
      videoRef.current = null;
      fingerPointerRef.fingertipRaw = null;
      fingerPointerRef.pointerNDC = null;
      fingerPointerRef.isPointing = false;
      fingerPointerRef.landmarks = null;
      useFingerPointerStore.getState().setTrackerStatus('idle');
    };
  }, [enabled, videoElement]);
}
