import React, { useEffect, useRef, useState } from 'react';
import { useFingerPointerStore } from '../../lib/fingerPointerStore';
import { solveHomography, fingerPointerRef, HAND_CONNECTIONS } from '../../lib/fingerPointerRef';
import { useHandTracker } from '../../lib/useHandTracker';

// Tiny live dot that follows the calibrated pointer. Renders nothing until a
// hand is detected. Shown during calibration so users see the mapping they're
// learning, and (optionally) elsewhere as ambient feedback.
const LiveProjectedDot: React.FC = () => {
  const dotRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf: number;
    const tick = () => {
      const dot = dotRef.current;
      if (dot) {
        const fresh = Date.now() - fingerPointerRef.lastUpdate < 200;
        const ndc = fresh ? fingerPointerRef.pointerNDC : null;
        if (ndc) {
          // NDC [-1..1] (Y up) → CSS percentages.
          const left = ((ndc[0] + 1) / 2) * 100;
          const top  = ((1 - ndc[1]) / 2) * 100;
          dot.style.display = 'block';
          dot.style.left = `${left}%`;
          dot.style.top = `${top}%`;
        } else {
          dot.style.display = 'none';
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div
      ref={dotRef}
      style={{
        position: 'fixed',
        width: 22, height: 22,
        marginLeft: -11, marginTop: -11,
        borderRadius: '50%',
        background: 'rgba(96, 165, 250, 0.95)',
        boxShadow: '0 0 16px rgba(96,165,250,0.7), 0 0 4px rgba(255,255,255,0.6) inset',
        pointerEvents: 'none',
        display: 'none',
        zIndex: 10001,
        transition: 'background 0.15s',
      }}
    />
  );
};

const COUNTDOWN_MS = 3000; // hold time after clicking Capture
const SAMPLE_MIN = 6;      // need at least this many samples during countdown

// Screen NDC targets. Order: top-left, top-right, bottom-right, bottom-left.
const CORNER_TARGETS: [[number, number], [number, number], [number, number], [number, number]] = [
  [-1,  1],
  [ 1,  1],
  [ 1, -1],
  [-1, -1],
];
const CORNER_LABELS = ['Top-Left', 'Top-Right', 'Bottom-Right', 'Bottom-Left'];

interface Props { onDone: () => void; onCancel: () => void; }

const FingerCalibration: React.FC<Props> = ({ onDone, onCancel }) => {
  const setCalibration = useFingerPointerStore((s) => s.setCalibration);
  const cameraError = useFingerPointerStore((s) => s.cameraError);
  const trackerStatus = useFingerPointerStore((s) => s.trackerStatus);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRafRef = useRef<number | null>(null);

  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  useEffect(() => { setVideoEl(videoRef.current); }, []);

  const [cornerIdx, setCornerIdx] = useState(0);
  const [captured, setCaptured] = useState<Array<[number, number] | null>>([null, null, null, null]);
  const [countdownStart, setCountdownStart] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Sample buffer collected during the active countdown.
  const samplesRef = useRef<Array<[number, number]>>([]);

  useHandTracker({
    enabled: true,
    videoElement: videoEl,
    onSample: ({ x, y }) => {
      if (countdownStart !== null) {
        samplesRef.current.push([x, y]);
      }
    },
  });

  // Drive the countdown progress (UI only — sample collection happens in onSample).
  useEffect(() => {
    if (countdownStart === null) return;
    let raf: number;
    const tick = () => {
      const elapsed = performance.now() - countdownStart;
      const p = Math.min(1, elapsed / COUNTDOWN_MS);
      setProgress(p);
      if (p >= 1) {
        finalizeCapture();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdownStart]);

  // Continuously redraw the hand skeleton + fingertip marker on the canvas.
  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video) {
        overlayRafRef.current = requestAnimationFrame(draw);
        return;
      }
      const w = video.clientWidth || 640;
      const h = video.clientHeight || 480;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        overlayRafRef.current = requestAnimationFrame(draw);
        return;
      }
      ctx.clearRect(0, 0, w, h);

      const lm = fingerPointerRef.landmarks;
      const aim = fingerPointerRef.aimImage;
      if (lm && lm.length >= 21) {
        // Landmarks are in image coords (top-left origin, 0..1). The video is
        // CSS-mirrored via transform: scaleX(-1), so we mirror X here too to
        // align the overlay with what the user sees.
        const toX = (n: number) => (1 - n) * w;
        const toY = (n: number) => n * h;

        // Skeleton edges
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.85)';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (const [a, b] of HAND_CONNECTIONS) {
          ctx.moveTo(toX(lm[a].x), toY(lm[a].y));
          ctx.lineTo(toX(lm[b].x), toY(lm[b].y));
        }
        ctx.stroke();

        // Joint dots
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        for (const p of lm) {
          ctx.beginPath();
          ctx.arc(toX(p.x), toY(p.y), 3.5, 0, Math.PI * 2);
          ctx.fill();
        }

        // Fingertip
        const tip = lm[8];
        ctx.fillStyle = '#fbbf24';
        ctx.beginPath();
        ctx.arc(toX(tip.x), toY(tip.y), 7, 0, Math.PI * 2);
        ctx.fill();

        // Aim line + extrapolated point ("where we think you're aiming").
        if (aim) {
          ctx.strokeStyle = 'rgba(96, 165, 250, 0.9)';
          ctx.setLineDash([6, 4]);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(toX(tip.x), toY(tip.y));
          ctx.lineTo(toX(aim.x), toY(aim.y));
          ctx.stroke();
          ctx.setLineDash([]);

          // Aim crosshair
          const ax = toX(aim.x), ay = toY(aim.y);
          ctx.strokeStyle = '#60a5fa';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(ax, ay, 12, 0, Math.PI * 2);
          ctx.moveTo(ax - 16, ay); ctx.lineTo(ax + 16, ay);
          ctx.moveTo(ax, ay - 16); ctx.lineTo(ax, ay + 16);
          ctx.stroke();
        }
      }

      overlayRafRef.current = requestAnimationFrame(draw);
    };
    overlayRafRef.current = requestAnimationFrame(draw);
    return () => { if (overlayRafRef.current) cancelAnimationFrame(overlayRafRef.current); };
  }, []);

  // Compute and persist the homography once all 4 corners are captured.
  useEffect(() => {
    if (cornerIdx < 4) return;
    if (captured.some((c) => c === null)) return;
    const src = captured as [[number, number], [number, number], [number, number], [number, number]];
    const H = solveHomography(src, CORNER_TARGETS);
    if (!H) {
      setErrorMessage('Calibration math failed — the 4 points may be too close together. Restart and spread them more.');
      setCornerIdx(0);
      setCaptured([null, null, null, null]);
      return;
    }
    setCalibration({ cornerSamples: src, homography: H, capturedAt: Date.now() });
    onDone();
  }, [cornerIdx, captured, setCalibration, onDone]);

  const startCountdown = () => {
    if (trackerStatus !== 'ready') return;
    setErrorMessage(null);
    samplesRef.current = [];
    setCountdownStart(performance.now());
  };

  const finalizeCapture = () => {
    setCountdownStart(null);
    setProgress(0);
    const samples = samplesRef.current;
    samplesRef.current = [];
    if (samples.length < SAMPLE_MIN) {
      setErrorMessage(`Couldn't see your finger — only ${samples.length} samples captured. Make sure your hand is in the camera view and try again.`);
      return;
    }
    const cx = samples.reduce((s, p) => s + p[0], 0) / samples.length;
    const cy = samples.reduce((s, p) => s + p[1], 0) / samples.length;

    const idx = cornerIdx;
    setCaptured((prev) => {
      const next = [...prev];
      next[idx] = [cx, cy];
      return next;
    });
    if (idx < 3) setCornerIdx(idx + 1);
    else setCornerIdx(4);
  };

  const buttonLabel =
    trackerStatus !== 'ready' ? 'Setting up camera…' :
    countdownStart !== null   ? `Keep pointing… ${Math.ceil((1 - progress) * (COUNTDOWN_MS / 1000))}s` :
    cornerIdx >= 4            ? 'Done' :
    `Capture ${CORNER_LABELS[cornerIdx]}`;

  const buttonDisabled = trackerStatus !== 'ready' || countdownStart !== null || cornerIdx >= 4;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(8, 10, 16, 0.94)',
        backdropFilter: 'blur(6px)',
        display: 'flex', flexDirection: 'column',
        color: '#fff', fontFamily: 'monospace',
        pointerEvents: 'auto',
      }}
    >
      {/* Live calibrated pointer dot — the user learns the mapping by watching this */}
      <LiveProjectedDot />

      {/* Corner targets — fixed at the viewport edges */}
      <CornerDot pos={{ top: 24, left: 24 }}     idx={0} active={cornerIdx} captured={captured} pulsing={countdownStart !== null} progress={progress} />
      <CornerDot pos={{ top: 24, right: 24 }}    idx={1} active={cornerIdx} captured={captured} pulsing={countdownStart !== null} progress={progress} />
      <CornerDot pos={{ bottom: 24, right: 24 }} idx={2} active={cornerIdx} captured={captured} pulsing={countdownStart !== null} progress={progress} />
      <CornerDot pos={{ bottom: 24, left: 24 }}  idx={3} active={cornerIdx} captured={captured} pulsing={countdownStart !== null} progress={progress} />

      {/* Header */}
      <div style={{ textAlign: 'center', padding: '28px 24px 12px' }}>
        <div style={{ fontSize: '11px', letterSpacing: '0.2em', color: 'rgba(255,255,255,0.55)', marginBottom: 10 }}>
          FINGER POINTER · CALIBRATION ({Math.min(cornerIdx + 1, 4)}/4)
        </div>
        <div style={{ fontSize: '22px', fontWeight: 600 }}>
          {cornerIdx < 4
            ? <>Point your finger at the <span style={{ color: '#fbbf24' }}>{CORNER_LABELS[cornerIdx]}</span> corner, then click capture</>
            : <>Computing calibration…</>}
        </div>
      </div>

      {/* Video + skeleton overlay (center) */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 24px' }}>
        <div style={{
          position: 'relative',
          width: 'min(640px, 60vw)',
          aspectRatio: '4 / 3',
          background: '#000',
          borderRadius: 12,
          overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}>
          <video
            ref={videoRef}
            style={{
              position: 'absolute', inset: 0,
              width: '100%', height: '100%',
              objectFit: 'cover',
              transform: 'scaleX(-1)', // mirror so it feels like a selfie
            }}
          />
          <canvas
            ref={canvasRef}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
          />
          {/* Status pill in the corner of the video */}
          <div style={{
            position: 'absolute', top: 10, left: 10,
            padding: '4px 10px', borderRadius: 999,
            background: 'rgba(0,0,0,0.55)',
            border: '1px solid rgba(255,255,255,0.15)',
            fontSize: '11px',
            color: trackerStatus === 'ready' ? '#34d399' : trackerStatus === 'error' ? '#fca5a5' : '#fbbf24',
          }}>
            {trackerStatus === 'camera' ? 'Camera…' :
             trackerStatus === 'model'  ? 'Loading model…' :
             trackerStatus === 'ready'  ? (fingerPointerRef.landmarks ? 'Hand detected' : 'Show your hand') :
             trackerStatus === 'error'  ? 'Setup failed' : 'Starting…'}
          </div>
        </div>
      </div>

      {/* Capture button + cancel */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '24px' }}>
        {errorMessage && (
          <div style={{
            padding: '8px 14px',
            background: 'rgba(239,68,68,0.15)',
            border: '1px solid rgba(239,68,68,0.5)',
            borderRadius: 6,
            color: '#fca5a5',
            fontSize: '12px',
            maxWidth: 540,
            textAlign: 'center',
          }}>{errorMessage}</div>
        )}
        {cameraError && (
          <div style={{
            padding: '8px 14px',
            background: 'rgba(239,68,68,0.15)',
            border: '1px solid rgba(239,68,68,0.5)',
            borderRadius: 6,
            color: '#fca5a5',
            fontSize: '12px',
            maxWidth: 540,
            textAlign: 'center',
          }}>
            <strong>Camera:</strong> {cameraError}
          </div>
        )}
        <button
          onClick={startCountdown}
          disabled={buttonDisabled}
          style={{
            padding: '14px 36px',
            background: buttonDisabled ? 'rgba(255,255,255,0.1)' : '#fbbf24',
            color: buttonDisabled ? 'rgba(255,255,255,0.5)' : '#111',
            border: 'none',
            borderRadius: 8,
            cursor: buttonDisabled ? 'not-allowed' : 'pointer',
            fontFamily: 'monospace',
            fontSize: '14px',
            fontWeight: 700,
            letterSpacing: '0.05em',
            transition: 'background 0.15s',
          }}
        >
          {buttonLabel}
        </button>
        <button
          onClick={onCancel}
          style={{
            padding: '6px 14px',
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.2)',
            color: 'rgba(255,255,255,0.65)',
            borderRadius: 4,
            cursor: 'pointer',
            fontFamily: 'monospace',
            fontSize: '11px',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

interface CornerDotProps {
  pos: { top?: number; left?: number; right?: number; bottom?: number };
  idx: number;
  active: number;
  captured: Array<[number, number] | null>;
  pulsing: boolean;
  progress: number;
}

const CornerDot: React.FC<CornerDotProps> = ({ pos, idx, active, captured, pulsing, progress }) => {
  const isActive = idx === active;
  const isCaptured = captured[idx] !== null;
  const size = isActive ? 56 : 28;
  const color = isCaptured ? '#10b981' : isActive ? '#fbbf24' : 'rgba(255,255,255,0.25)';

  return (
    <div style={{ position: 'absolute', ...pos, width: size, height: size, pointerEvents: 'none' }}>
      <div style={{
        width: '100%', height: '100%',
        borderRadius: '50%',
        border: `3px solid ${color}`,
        background: isActive ? 'rgba(251,191,36,0.18)' : 'transparent',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '11px', color,
        boxShadow: isActive ? '0 0 24px rgba(251,191,36,0.45)' : 'none',
        animation: isActive && pulsing ? 'fp-pulse 1s ease-in-out infinite' : 'none',
        transition: 'all 0.2s',
      }}>
        {isCaptured ? '✓' : idx + 1}
      </div>
      {isActive && pulsing && (
        <svg style={{ position: 'absolute', inset: -6, transform: 'rotate(-90deg)' }} width={size + 12} height={size + 12}>
          <circle
            cx={(size + 12) / 2} cy={(size + 12) / 2}
            r={(size + 6) / 2}
            fill="none"
            stroke="#fbbf24"
            strokeWidth={3}
            strokeDasharray={Math.PI * (size + 6)}
            strokeDashoffset={Math.PI * (size + 6) * (1 - progress)}
            strokeLinecap="round"
            opacity={0.7}
          />
        </svg>
      )}
      <style>{`@keyframes fp-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }`}</style>
    </div>
  );
};

export default FingerCalibration;
