// Keeping the parsed models in step with the scene the room says it is showing.
//
// The scene arrives as a list of hashes. Turning each one into geometry is a
// download and a parse, which is slow (a 200 MB STEP file is minutes in a
// worker) and can fail, so it cannot happen inside the message handler that
// received the list — that handler has to stay synchronous enough to keep the
// socket responsive, and it runs again on every change.
//
// This is the effect that does it instead: watch the list, start whatever is
// missing, drop whatever is no longer there. Mounted once by World, which both
// the room canvas and the review setup canvas render.

import { useEffect } from 'react';
import { useStore } from '../../store';
import { fetchModelFile } from '../modelsClient';
import { parseSceneModelFile } from './sceneEntries';
import type { SceneModel } from './roomScene';

// Model ids whose download-and-parse is already running.
//
// Module-level rather than per-hook because more than one thing can ask for the
// same model at the same moment: the scene the room relayed, the scene a
// curation put up a moment later, and a second World if the layout ever mounts
// one. Without this the same 200 MB file would be parsed twice and the second
// result would replace the first under the renderer that was already using it.
const inFlight = new Set<string>();

/** True while the scene still wants this model — checked after every await. */
function stillWanted(id: string): boolean {
  return useStore.getState().scene.models.some((model) => model.id === id);
}

async function load(model: SceneModel): Promise<void> {
  try {
    const file = await fetchModelFile(model.hash, model.fileName);
    // The scene can move on while a big file downloads: the model may have been
    // removed, or replaced by a revision of itself. Parsing it anyway would put
    // geometry in the store that nothing in the scene refers to.
    if (!stillWanted(model.id)) return;
    const entry = await parseSceneModelFile(model, file);
    if (!stillWanted(model.id)) return;
    useStore.getState().upsertSceneModel(entry);
  } catch (error) {
    console.error(`[scene] could not load ${model.fileName} (${model.hash}):`, error);
    // Said in the model tree, where a person is looking when a model does not
    // appear. The message is already the one modelsClient wrote for a download
    // that failed, so there is nothing here to translate.
    if (stillWanted(model.id)) {
      useStore.getState().setImportStatus(error instanceof Error ? error.message : null, null);
    }
  }
}

function sync(): void {
  const { scene, sceneEntries, pruneSceneEntries } = useStore.getState();
  let started = false;
  for (const model of scene.models) {
    // No hash means there is nothing to fetch. Every model the room relays has
    // one; this is the guard for a scene built locally before an upload
    // finished, which renders from the entry the import already parsed.
    if (model.hash === '') continue;
    if (sceneEntries[model.id] || inFlight.has(model.id)) continue;
    inFlight.add(model.id);
    started = true;
    void load(model).finally(() => {
      inFlight.delete(model.id);
    });
  }
  // Drop geometry for models the scene no longer holds. Cheap and idempotent,
  // and it is what stops a long meeting from holding every model it ever showed.
  if (!started) pruneSceneEntries();
}

/**
 * Fetch and parse whatever the scene is missing. Call once, inside the canvas.
 */
export function useSceneModelLoader(): void {
  const scene = useStore((state) => state.scene);
  const entries = useStore((state) => state.sceneEntries);

  useEffect(() => {
    sync();
    // Both dependencies matter: `scene` for what is wanted, `entries` so a
    // parse that failed while the model was still wanted is retried when the
    // next one lands rather than leaving a row stuck on "loading" for ever.
  }, [scene, entries]);
}
