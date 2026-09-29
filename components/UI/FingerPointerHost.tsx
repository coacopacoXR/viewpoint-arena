import React from 'react';
import { useFingerPointerStore } from '../../lib/fingerPointerStore';
import { useHandTracker } from '../../lib/useHandTracker';
import FingerCalibration from './FingerCalibration';
import { Hand } from 'lucide-react';

// Lives at the top of the app tree. Owns the tracker lifecycle in 'active'
// mode, renders the first-run prompt, and mounts the calibration overlay
// when needed.
const FingerPointerHost: React.FC = () => {
  const mode = useFingerPointerStore((s) => s.mode);
  const setMode = useFingerPointerStore((s) => s.setMode);
  const cameraError = useFingerPointerStore((s) => s.cameraError);
  const startRecalibration = useFingerPointerStore((s) => s.startRecalibration);
  const calibration = useFingerPointerStore((s) => s.calibration);

  // Run the tracker while active. Calibration mode owns its own tracker
  // instance (so it can grab raw samples via onSample).
  useHandTracker({ enabled: mode === 'active' });

  if (mode === 'prompt') {
    return <FingerPrompt onAccept={startRecalibration} onDecline={() => setMode('disabled')} />;
  }

  if (mode === 'calibrating') {
    return (
      <FingerCalibration
        onDone={() => setMode('active')}
        onCancel={() => setMode(calibration ? 'active' : 'disabled')}
      />
    );
  }

  if (cameraError && mode === 'active') {
    // Non-blocking toast — could promote to a modal later.
    return (
      <div style={{
        position: 'fixed', bottom: 24, right: 24, zIndex: 9000,
        background: 'rgba(239,68,68,0.18)', border: '1px solid rgba(239,68,68,0.5)',
        color: '#fca5a5', padding: '8px 14px', borderRadius: 6,
        fontFamily: 'monospace', fontSize: '12px',
        pointerEvents: 'auto',
      }}>
        Finger pointer: {cameraError}
      </div>
    );
  }

  return null;
};

interface PromptProps { onAccept: () => void; onDecline: () => void; }

const FingerPrompt: React.FC<PromptProps> = ({ onAccept, onDecline }) => {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 10000,
      background: 'rgba(8, 10, 16, 0.85)',
      backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'monospace', color: '#fff',
      // Parent (.pointer-events-none in Interface) blocks input; re-enable here.
      pointerEvents: 'auto',
    }}>
      <div style={{
        maxWidth: 460, padding: '32px 36px',
        background: 'rgba(20, 22, 30, 0.95)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <Hand size={22} />
          <div style={{ fontSize: '11px', letterSpacing: '0.18em', color: 'rgba(255,255,255,0.6)' }}>
            FINGER POINTER
          </div>
        </div>
        <div style={{ fontSize: '20px', fontWeight: 600, marginBottom: 14 }}>
          Use your finger as a laser pointer?
        </div>
        <div style={{ fontSize: '13px', lineHeight: 1.6, color: 'rgba(255,255,255,0.7)', marginBottom: 24 }}>
          Your webcam will track your index finger. We'll run a quick 4-corner
          calibration so the pointer lines up with your screen. The video feed
          stays on your machine — only the computed pointer position is shared.
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={onDecline}
            style={{
              padding: '8px 16px',
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.2)',
              color: 'rgba(255,255,255,0.75)',
              borderRadius: 4, cursor: 'pointer',
              fontFamily: 'monospace', fontSize: '12px',
            }}
          >
            Not now
          </button>
          <button
            onClick={onAccept}
            style={{
              padding: '8px 18px',
              background: '#fbbf24', color: '#111',
              border: 'none',
              borderRadius: 4, cursor: 'pointer',
              fontFamily: 'monospace', fontSize: '12px', fontWeight: 600,
            }}
          >
            Calibrate
          </button>
        </div>
      </div>
    </div>
  );
};

export default FingerPointerHost;
