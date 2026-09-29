import React, { useEffect, useState } from 'react';
import { xrStore } from '../../lib/xrStore';

const XRButton: React.FC = () => {
  const [arSupported, setArSupported] = useState(false);
  const [vrSupported, setVrSupported] = useState(false);
  const [inXR, setInXR] = useState(false);

  useEffect(() => {
    if (!navigator.xr) return;
    navigator.xr.isSessionSupported('immersive-ar').then(setArSupported).catch(() => {});
    navigator.xr.isSessionSupported('immersive-vr').then(setVrSupported).catch(() => {});

    const unsub = xrStore.subscribe(state => {
      setInXR(state.session != null);
    });
    return unsub;
  }, []);

  if (!arSupported && !vrSupported) return null;

  if (inXR) {
    return (
      <button
        onClick={() => xrStore.getState().session?.end()}
        className="px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wide border shadow-md transition-all flex items-center gap-2 bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700"
      >
        <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
        Exit XR
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      {arSupported && (
        <button
          onClick={() => xrStore.enterAR()}
          className="px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wide border shadow-md transition-all flex items-center gap-2 bg-white text-gray-600 border-gray-200 hover:bg-gray-50 hover:border-gray-400"
          title="Enter AR (Quest 3 passthrough)"
        >
          <span style={{ fontSize: 12 }}>◉</span> AR
        </button>
      )}
      {vrSupported && !arSupported && (
        <button
          onClick={() => xrStore.enterVR()}
          className="px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wide border shadow-md transition-all flex items-center gap-2 bg-white text-gray-600 border-gray-200 hover:bg-gray-50 hover:border-gray-400"
          title="Enter VR"
        >
          <span style={{ fontSize: 12 }}>◎</span> VR
        </button>
      )}
    </div>
  );
};

export default XRButton;
