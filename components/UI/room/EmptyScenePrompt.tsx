// What an empty room says about itself.
//
// Batch BI took the default model away: a room and a new design review both start
// with nothing on screen, and the three models that ship with the app became
// samples somebody chooses. An empty canvas with no explanation reads as a broken
// room, so it gets one calm sentence and the two ways out of it — import the
// product this meeting is actually about, or start from a sample.
//
// Somebody who may not change the models gets the sentence and nothing else. Two
// buttons they cannot press, or a disabled pair with a refusal on each, would both
// be noise in the middle of the thing everybody is looking at; the model tree
// already carries the reason in full.

import React, { useState } from 'react';
import { Box, ChevronDown, Sparkles, Upload } from 'lucide-react';
import { clsx } from 'clsx';
import { useStore } from '../../../store';
import { requestSceneImportPicker } from '../../../lib/scene/importHandoff';
import { useSampleModels } from '../../../lib/scene/useSampleModels';
import { useScenePermissions } from '../../../lib/scene/useScenePermissions';

const EmptyScenePrompt: React.FC = () => {
  // Derived from the scene, so this is true only while the room holds neither
  // models of its own nor a chosen sample — and it goes false for everybody in the
  // room the moment the scene changes, because the scene is the server's.
  const isEmpty = useStore(state => state.activeModelType === 'none');
  const isImporting = useStore(state => state.isImporting);
  const { canChangeModels } = useScenePermissions();
  const { samples, chooseSample } = useSampleModels();

  const [samplesOpen, setSamplesOpen] = useState(false);
  // Set when the model tree is not there to open a picker for. Interface always
  // mounts the tree beside this, so it is the mobile room and a test that reach
  // it — but a button that does nothing at all is the one thing the module that
  // hands the picker over warns against.
  const [pickerMissing, setPickerMissing] = useState(false);

  if (!isEmpty) return null;

  const openImport = () => {
    setSamplesOpen(false);
    setPickerMissing(!requestSceneImportPicker());
  };

  return (
    <div
      data-testid="empty-scene-prompt"
      className="pointer-events-auto w-72 rounded-lg border border-gray-200 bg-white/95 backdrop-blur-md shadow-sm p-5 text-center"
    >
      <Box size={22} className="mx-auto mb-2 text-gray-300" />

      {!canChangeModels ? (
        <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
          No model yet — the host will add one
        </p>
      ) : (
        <>
          <p className="text-xs font-bold text-gray-700">No model yet</p>
          <p className="mt-1 text-[10px] font-mono text-gray-400 leading-relaxed">
            Import the product this review is about, or start from one of the
            samples.
          </p>

          <button
            onClick={openImport}
            disabled={isImporting}
            title="Import a 3D model into this room"
            className={clsx(
              'mt-3 w-full px-3 py-2 rounded text-[10px] font-bold flex items-center justify-center gap-2 transition-all',
              isImporting
                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                : 'bg-blue-500 text-white hover:bg-blue-600 shadow-sm',
            )}
          >
            <Upload size={12} />
            Import a model
          </button>

          <button
            onClick={() => { setSamplesOpen(open => !open); setPickerMissing(false); }}
            disabled={isImporting}
            aria-expanded={samplesOpen}
            title="Put one of the models that ship with the app in the room"
            className="mt-1 w-full px-3 py-1.5 rounded text-[10px] font-bold flex items-center justify-center gap-1.5 text-gray-500 border border-gray-200 bg-white hover:bg-gray-50 hover:text-gray-700 transition-colors"
          >
            <Sparkles size={11} />
            Try a sample
            <ChevronDown size={11} className={clsx('transition-transform', samplesOpen && 'rotate-180')} />
          </button>

          {samplesOpen && (
            <div className="mt-1 flex flex-col gap-0.5 rounded border border-gray-200 bg-white p-1">
              {samples.map(sample => (
                <button
                  key={sample.builtIn}
                  onClick={() => { chooseSample(sample.builtIn); setSamplesOpen(false); }}
                  className="px-2 py-1.5 rounded text-left text-[10px] font-mono text-gray-600 hover:bg-blue-50 hover:text-blue-700 transition-colors"
                >
                  {sample.label}
                </button>
              ))}
            </div>
          )}

          {pickerMissing && (
            <p className="mt-2 text-[9px] font-mono text-gray-400">
              The model tree is not open, so there is no file picker to reach.
            </p>
          )}
        </>
      )}
    </div>
  );
};

export default EmptyScenePrompt;
