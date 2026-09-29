// Putting one of the app's three sample models on screen.
//
// Batch BI. Two places offer a sample — the prompt an empty room shows in the
// middle of the canvas, and the model tree's import area — and both have to do the
// same two things in the same order, which is what an import does too: send the
// operation to the room server, then make the same change locally so the model
// appears the moment the button is pressed rather than a round trip later. The
// server is still the truth and relays the resulting scene back to everybody, this
// client included, so the local step is a prediction the echo confirms or replaces.
//
// One hook rather than two copies, because the alternative is a canvas that sends
// an operation the room server would have refused and then shows the person a
// refusal for a model that is already on their screen.
//
// WHETHER the chooser is offered is not decided here. That is
// lib/scene/useScenePermissions, which both callers already ask for their other
// controls; asking it a second time inside this hook would read the review's
// roster twice per render for one answer.

import { useMemo } from 'react';
import { useStore } from '../../store';
import { usePresence } from '../PresenceContext';
import type { BuiltInModel, SceneUpdate } from './roomScene';
import { SAMPLE_MODELS, type SampleModel } from './sampleModels';

/** The samples on offer, and the one operation that puts one of them up. */
export interface SampleModelChooser {
  samples: SampleModel[];
  chooseSample: (builtIn: BuiltInModel) => void;
}

/**
 * How to choose a sample.
 *
 * Both callers render the control only while the scene holds no models of its own.
 * That is not a restriction this hook imposes but one the scene's shape does:
 * store.ts's activeModelTypeFor reads 'imported' whenever the list is non-empty, so
 * a built-in chosen underneath it would be recorded and stay invisible until the
 * last import was removed. Offering a button that appears to do nothing is worse
 * than not offering it.
 */
export function useSampleModels(): SampleModelChooser {
  const { broadcastSceneUpdate } = usePresence();
  const applyLocalSceneUpdate = useStore(state => state.applyLocalSceneUpdate);

  const chooseSample = useMemo(
    () => (builtIn: BuiltInModel) => {
      const update: SceneUpdate = { op: 'setBuiltIn', builtIn };
      broadcastSceneUpdate(update);
      applyLocalSceneUpdate(update);
    },
    [broadcastSceneUpdate, applyLocalSceneUpdate],
  );

  return { samples: SAMPLE_MODELS, chooseSample };
}
