import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Camera, MapPin, ListOrdered, Box } from 'lucide-react';
import { clsx } from 'clsx';

type FeatureId = 'viewpoints' | 'pins' | 'agenda' | 'asset';

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
    id: 'viewpoints',
    label: 'Viewpoints',
    icon: Camera,
    shortDesc: 'Saved camera angles · navigable, editable',
    fullDesc:
      "Viewpoints are pre-curated camera positions captured during setup. In the live room, the navigator lets you walk through them one at a time (Prev / Next) — clicking either button rides the camera smoothly to that angle. Each viewpoint behaves like a comment with a visual annotation: it has a title, free-form notes, and the saved camera framing acts as its 'image'. Edits made in the room broadcast to all participants so notes stay in sync.",
    techSpecs: [
      'Capture: screenshot + camera pose at setup time',
      'Jump: ease-in-out lerp ~600ms (shared OrbitControls)',
      'Edit: live, broadcast to room via REVIEW_CONFIG',
      'Persist: server-cached for late joiners',
    ],
    illustration: (
      <div className="w-full h-full flex items-center justify-center gap-4">
        <div className="w-6 h-6 border-2 border-gray-300 rounded-full flex items-center justify-center text-gray-400 text-xs">←</div>
        <div className="w-40 h-24 bg-gray-100 rounded border border-gray-200 flex items-center justify-center text-gray-400">
          <Camera size={24} />
        </div>
        <div className="w-6 h-6 border-2 border-emerald-400 rounded-full flex items-center justify-center text-emerald-500 text-xs">→</div>
      </div>
    ),
  },
  {
    id: 'pins',
    label: 'Pins',
    icon: MapPin,
    shortDesc: 'Text-only comments anchored to a part',
    fullDesc:
      "Pins are pre-curated annotations attached to a specific mesh of the model. Think of them as comments with no visual annotation — just a label, optional notes, and a severity (info / concern / blocker). In the 3D scene they render as color-coded markers floating above the part. In the panel they appear in the comments stream below the viewpoint navigator. Like viewpoints, the label and notes are editable live in the room.",
    techSpecs: [
      'Attach: raycast onto userData.modelId mesh',
      'Severity: info / concern / blocker',
      'Marker: color-coded sphere + stem + label',
      'Stream: shown as text-only comment entries',
    ],
    illustration: (
      <div className="w-full h-full flex items-center justify-center relative">
        <div className="w-32 h-20 bg-gray-100 rounded border border-gray-200 relative">
          <div className="absolute -top-2 left-8 w-px h-4 bg-amber-400" />
          <div className="absolute -top-3 left-7 w-3 h-3 rounded-full bg-amber-400 shadow-[0_0_8px_rgba(245,158,11,0.5)]" />
          <div className="absolute -top-1 left-12 text-[8px] font-mono bg-amber-400 text-black px-1 rounded">Cup hinge</div>
        </div>
      </div>
    ),
  },
  {
    id: 'agenda',
    label: 'Agenda',
    icon: ListOrdered,
    shortDesc: 'Slide deck of viewpoints, pins, and speaker notes',
    fullDesc:
      "A linear deck composed at setup time. Each slide has a title, optional speaker notes, and any number of attached viewpoints and pins. During the review the host steps through slides in order — the camera auto-jumps to attached viewpoints and the room highlights attached pins. The agenda is metadata; the room UI surfaces it as a step-through deck.",
    techSpecs: [
      'Composition: drag-reorder at setup',
      'Per slide: title + notes + N viewpoints + N pins',
      'Step: next/prev controls in the panel',
      'Sync: broadcast with the rest of the config',
    ],
    illustration: (
      <div className="w-full h-full flex items-center justify-center">
        <div className="flex flex-col gap-1.5">
          {[1, 2, 3].map((n) => (
            <div key={n} className="flex items-center gap-2 text-[10px] font-mono">
              <div className={clsx('w-4 h-4 rounded-full flex items-center justify-center text-white', n === 2 ? 'bg-emerald-500' : 'bg-gray-300')}>{n}</div>
              <div className="w-32 h-3 rounded bg-gray-100" />
            </div>
          ))}
        </div>
      </div>
    ),
  },
  {
    id: 'asset',
    label: 'Asset',
    icon: Box,
    shortDesc: 'The model + reference materials',
    fullDesc:
      "Defines what's being reviewed. Either a preset model (Headphones / Bicycle / Synth) or an uploaded GLB / OBJ / FBX / STL. Reference materials (spec sheets, prior versions, briefs) attach as named links. When a participant joins the room, the asset is automatically loaded from the broadcast — no manual setup needed.",
    techSpecs: [
      'Formats: GLB, GLTF, OBJ, FBX, STL',
      'Wire transport: base64 in REVIEW_CONFIG payload',
      'References: name + URL pairs (metadata only)',
      'Load: parsed via shared modelLoader pipeline',
    ],
    illustration: (
      <div className="w-full h-full flex items-center justify-center">
        <div className="w-24 h-24 border-2 border-gray-300 rounded-lg flex items-center justify-center bg-gray-50">
          <Box size={32} className="text-gray-400" />
        </div>
      </div>
    ),
  },
];

const ReviewExplainer: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [activeId, setActiveId] = useState<FeatureId>('viewpoints');
  const active = FEATURES.find((f) => f.id === activeId) || FEATURES[0];

  return createPortal(
    <div className="fixed inset-0 z-[100] bg-[#F2F2F2]/90 backdrop-blur-xl flex items-center justify-center p-8 animate-in fade-in duration-300 pointer-events-auto">
      <button
        onClick={onClose}
        className="absolute top-8 right-8 p-2 rounded-full border border-gray-300 text-gray-500 hover:bg-white hover:text-black transition-colors"
      >
        <X size={24} />
      </button>

      <div className="w-full max-w-6xl h-[80vh] flex shadow-2xl rounded-2xl overflow-hidden border border-gray-200 bg-white">
        <div className="w-1/3 bg-gray-50 border-r border-gray-200 flex flex-col">
          <div className="p-8 border-b border-gray-200">
            <h2 className="text-2xl font-bold tracking-tight text-gray-900 mb-2">Active Review</h2>
            <p className="text-sm text-gray-500 font-mono">Curated session reference</p>
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
                    <div className="text-xs text-gray-400">{f.shortDesc}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex-1 flex flex-col relative bg-white">
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
    </div>,
    document.body,
  );
};

export default ReviewExplainer;
