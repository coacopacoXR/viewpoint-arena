import React, { useState } from 'react';
import { X, Crosshair, Hand, MousePointer, Layers } from 'lucide-react';
import { clsx } from 'clsx';

type FeatureId = 'laser' | 'granularity' | 'finger' | 'hover';

interface FeatureDetails {
  id: FeatureId;
  label: string;
  icon: any;
  shortDesc: string;
  fullDesc: string;
  techSpecs: string[];
  illustration: React.ReactNode;
}

const FEATURES: FeatureDetails[] = [
  {
    id: 'laser',
    label: 'Laser Pointer',
    icon: Crosshair,
    shortDesc: 'Per-user colored beam with part-name labels',
    fullDesc:
      "Every participant gets a laser in their identity color. Activate by holding both mouse buttons OR by pressing-and-holding the P key. Remote viewers see the beam emerge from your avatar's body, a floating name label above the impact dot, and the specific part of the model you're targeting. Local users also see the clean part name above their own pointer.",
    techSpecs: [
      'Activation: LMB+RMB or P',
      'Broadcast: ~10 fps over PartyKit',
      'TTL: 1.5s receiver-side auto-clear',
      'Identifier: stable mesh index per GLB',
    ],
    illustration: (
      <div className="w-full h-full flex items-center justify-center relative">
        <div className="w-32 h-32 border-2 border-gray-800 rounded-lg flex items-center justify-center bg-gray-100" />
        <div className="absolute right-8 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-red-500 shadow-[0_0_12px_rgba(239,68,68,0.6)]" />
        <svg className="absolute inset-0 w-full h-full pointer-events-none">
          <line x1="85%" y1="15%" x2="55%" y2="50%" stroke="#ef4444" strokeWidth="2" />
        </svg>
        <div className="absolute right-2 top-4 w-2 h-2 bg-red-500 rounded-full" />
        <div className="absolute right-3 top-1 font-mono text-[8px] text-red-500">USER A</div>
      </div>
    ),
  },
  {
    id: 'granularity',
    label: 'Highlight Granularity',
    icon: Layers,
    shortDesc: 'Model-wide glow vs. single-part glow',
    fullDesc:
      "Choose what the laser highlights when it hits the model. 'Model' mode lights up the entire assembly in the pointer's color — useful when discussing the object as a whole. 'Part' mode isolates only the specific mesh under the cursor — better for component-level review and deictic precision. Switches live without recalibration.",
    techSpecs: [
      'Glow: emissive lerp at 0.45 intensity',
      'Material clones: per-mesh decoupling',
      'Per-pointer color blending',
      'Toggle: instant, no reload',
    ],
    illustration: (
      <div className="w-full h-full flex items-center justify-around gap-4 p-6">
        <div className="flex flex-col items-center gap-2">
          <div className="w-20 h-20 bg-yellow-300 rounded-lg shadow-[0_0_24px_rgba(250,204,21,0.6)]" />
          <div className="text-[10px] font-mono text-gray-500 uppercase">Model</div>
        </div>
        <div className="flex flex-col items-center gap-2">
          <div className="w-20 h-20 bg-gray-200 rounded-lg relative overflow-hidden">
            <div className="absolute top-2 left-2 w-6 h-6 bg-yellow-300 shadow-[0_0_16px_rgba(250,204,21,0.7)]" />
          </div>
          <div className="text-[10px] font-mono text-gray-500 uppercase">Part</div>
        </div>
      </div>
    ),
  },
  {
    id: 'finger',
    label: 'Finger Pointing',
    icon: Hand,
    shortDesc: 'Webcam hand tracking with 4-corner calibration',
    fullDesc:
      "Point with your physical index finger and the laser follows. A first-run prompt asks for camera permission, then a 4-corner calibration teaches the system where your screen is. The pointer uses the index finger's PIP→TIP direction, smoothed by a 1€ filter + rolling window, then anchored trackpad-style: every fresh hand detection snaps to the model center so steering starts on-target. Waits for the hand to be visible AND stationary before locking the anchor — captures the position you settled at, not the one you passed through.",
    techSpecs: [
      'Tracker: MediaPipe Hand Landmarker',
      'Filter: 1€ + 16-sample rolling window',
      'Activation: 500ms visible + 250ms still',
      'Sensitivity: 0.55× hand-to-pointer gain',
    ],
    illustration: (
      <div className="w-full h-full flex items-center justify-center relative">
        <svg viewBox="0 0 100 100" className="w-32 h-32">
          <circle cx="50" cy="75" r="14" fill="none" stroke="#fbbf24" strokeWidth="2" />
          <line x1="50" y1="63" x2="50" y2="30" stroke="#fbbf24" strokeWidth="3" strokeLinecap="round" />
          <circle cx="50" cy="30" r="3" fill="#fbbf24" />
          <line x1="50" y1="30" x2="50" y2="10" stroke="#60a5fa" strokeWidth="1.5" strokeDasharray="3 3" />
          <circle cx="50" cy="10" r="4" fill="none" stroke="#60a5fa" strokeWidth="1.5" />
          <line x1="46" y1="10" x2="54" y2="10" stroke="#60a5fa" strokeWidth="1.5" />
          <line x1="50" y1="6" x2="50" y2="14" stroke="#60a5fa" strokeWidth="1.5" />
        </svg>
      </div>
    ),
  },
  {
    id: 'hover',
    label: 'Hover Dwell',
    icon: MousePointer,
    shortDesc: 'Auto-engage when cursor settles on a part',
    fullDesc:
      "Some people point with the mouse without clicking — moving the cursor over a thing as a way to direct attention. This mode detects that pattern automatically. A 2-second sliding buffer of cursor positions is split into 'recent' (last 600ms, must be tightly clustered) and 'older' (must contain positions far from the current cluster — proving the cursor approached this spot, not just sat there). When both checks pass AND the cursor raycasts onto a tagged model, the laser engages silently. Any movement, click, or explicit activation immediately disengages.",
    techSpecs: [
      'Window: 2.0s sliding buffer',
      'Recent slice: 600ms, max 0.04 NDC dispersion',
      'Approach threshold: 0.06 NDC older deviation',
      'Pre-flight: raycast must hit modelId',
    ],
    illustration: (
      <div className="w-full h-full flex items-center justify-center relative">
        <svg viewBox="0 0 120 80" className="w-44 h-32">
          <path d="M 10 60 Q 30 20, 60 30 T 95 35" fill="none" stroke="#9ca3af" strokeWidth="1.5" strokeDasharray="4 3" />
          <circle cx="10" cy="60" r="2" fill="#9ca3af" />
          <circle cx="35" cy="35" r="2" fill="#9ca3af" />
          <circle cx="60" cy="30" r="2" fill="#9ca3af" />
          <rect x="78" y="22" width="20" height="20" rx="2" fill="rgba(16,185,129,0.18)" stroke="#10b981" strokeWidth="1.5" />
          <circle cx="88" cy="32" r="4" fill="#10b981" />
          <text x="105" y="35" fontFamily="monospace" fontSize="6" fill="#10b981">ENGAGE</text>
        </svg>
      </div>
    ),
  },
];

const DeicticFeaturesExplainer: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [activeId, setActiveId] = useState<FeatureId>('laser');
  const active = FEATURES.find((f) => f.id === activeId) || FEATURES[0];

  return (
    <div className="fixed inset-0 z-[100] bg-[#F2F2F2]/90 backdrop-blur-xl flex items-center justify-center p-8 animate-in fade-in duration-300 pointer-events-auto">
      <button
        onClick={onClose}
        className="absolute top-8 right-8 p-2 rounded-full border border-gray-300 text-gray-500 hover:bg-white hover:text-black transition-colors"
      >
        <X size={24} />
      </button>

      <div className="w-full max-w-6xl h-[80vh] flex shadow-2xl rounded-2xl overflow-hidden border border-gray-200 bg-white">
        {/* LEFT: Navigation List */}
        <div className="w-1/3 bg-gray-50 border-r border-gray-200 flex flex-col">
          <div className="p-8 border-b border-gray-200">
            <h2 className="text-2xl font-bold tracking-tight text-gray-900 mb-2">Deictic Features</h2>
            <p className="text-sm text-gray-500 font-mono">Pointing &amp; Reference Manual</p>
          </div>
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
            {FEATURES.map((f) => {
              const Icon = f.icon;
              return (
                <button
                  key={f.id}
                  onClick={() => setActiveId(f.id)}
                  className={clsx(
                    'flex items-center gap-4 p-4 rounded-lg text-left transition-all duration-200 group',
                    activeId === f.id
                      ? 'bg-black text-white shadow-lg scale-[1.02]'
                      : 'hover:bg-gray-200 text-gray-600',
                  )}
                >
                  <Icon size={20} className={activeId === f.id ? 'text-emerald-400' : 'text-gray-400 group-hover:text-gray-600'} />
                  <div>
                    <div className="font-bold text-sm uppercase tracking-wide">{f.label}</div>
                    <div className={clsx('text-xs', activeId === f.id ? 'text-gray-400' : 'text-gray-400')}>{f.shortDesc}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* RIGHT: Detail View */}
        <div className="flex-1 flex flex-col relative bg-white">
          <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-5 pointer-events-none" />
          <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]" />

          <div className="p-12 flex flex-col h-full relative z-10">
            <div className="flex items-start justify-between mb-12">
              <div>
                <div className="text-xs font-mono font-bold text-emerald-600 mb-2 uppercase tracking-widest border border-emerald-100 bg-emerald-50 px-2 py-1 rounded w-fit">
                  Active Feature
                </div>
                <h1 className="text-5xl font-bold text-gray-900 tracking-tight mb-4">{active.label}</h1>
                <p className="text-xl text-gray-500 font-light max-w-xl leading-relaxed">{active.fullDesc}</p>
              </div>

              <div className="bg-gray-50 border border-gray-200 p-4 rounded-lg w-64 shrink-0">
                <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3 border-b border-gray-200 pb-2">
                  Technical Specs
                </div>
                <div className="flex flex-col gap-2">
                  {active.techSpecs.map((spec, i) => (
                    <div key={i} className="text-xs font-mono text-gray-600 flex items-center gap-2">
                      <div className="w-1 h-1 bg-gray-400 rounded-full" />
                      {spec}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex-1 border-2 border-gray-100 rounded-xl bg-gray-50/50 relative overflow-hidden flex items-center justify-center p-8 group">
              <div className="absolute top-4 left-4 text-[10px] font-mono text-gray-400 uppercase">Schematic Representation</div>
              <div className="w-full max-w-lg aspect-video bg-white shadow-xl rounded-lg border border-gray-200 p-2 transition-transform duration-700 group-hover:scale-105">
                {active.illustration}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DeicticFeaturesExplainer;
