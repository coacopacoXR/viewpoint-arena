// The wiring between the room and its undo stack — batch BT.
//
// lib/scene/editHistory.ts holds the stack and the rules; this file is the three things
// that need a room: reading the scene either side of a change, sending the operations
// that replay one, and telling the person what happened. It is a hook because all
// three come from context — the presence socket, the store, the permissions — and
// because the callers are components: the amber strip's two buttons, the gizmo's
// drag-end, and the model tree's eye, bin and import.
//
// TWO RULES the wiring has to respect, both learned the hard way elsewhere in this
// codebase:
//
//   • An undo goes out the SAME door as the edit it undoes. broadcastSceneUpdate first
//     and applyLocalSceneUpdate second, then keepReviewPlacements, which is exactly the
//     order components/Scene/ReviewModelGizmo.tsx and components/review/EditingStrip.tsx
//     use. Skipping any of the three leaves one of the three copies of the scene — the
//     room's, this browser's, the review's — behind the other two.
//   • Nothing off `usePresence()` goes in a dependency array. The hook builds a fresh
//     object on every render (lib/usePartyPresence.ts), so a callback that listed
//     `broadcastSceneUpdate` would be a new callback every render and any effect
//     depending on it would re-run forever. The functions are read through a ref, the
//     way pages/RoomPage.tsx reads broadcastReviewConfig and components/UI/Interface.tsx
//     reads requestReviewEdit.

import { useCallback, useEffect, useRef } from 'react';
import { useStore } from '../../store';
import { usePresence } from '../../lib/PresenceContext';
import { isTextInput } from './clickSelection';
import { keepReviewPlacements } from './keepPlacements';
import type { SceneModel } from './roomScene';
import { useScenePermissions } from './useScenePermissions';
import {
  canRedo,
  canUndo,
  changedSinceStep,
  historyNotice,
  historyRefusalNotice,
  modelsForIds,
  planRestore,
  sameSceneModels,
  stepIndex,
  stepToRedo,
  stepToUndo,
  useEditHistory,
  type HistoryStep,
} from './editHistory';

/** Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, and which of the three this browser is on. */
export type HistoryShortcut = 'undo' | 'redo';

interface ShortcutKeys {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * Which shortcut a key press is, or null when it is not one.
 *
 * Cmd on macOS because that is where the muscle memory is, and Ctrl+Y beside
 * Ctrl+Shift+Z because both are "redo" in every other application anybody uses.
 * Ignored while the focus is in a text field: see isTextInput.
 */
export function historyShortcutFor(target: EventTarget | null, keys: ShortcutKeys): HistoryShortcut | null {
  if (isTextInput(target)) return null;
  if (!keys.ctrlKey && !keys.metaKey) return null;
  const key = keys.key.toLowerCase();
  if (key === 'z') return keys.shiftKey ? 'redo' : 'undo';
  if (key === 'y') return keys.shiftKey ? null : 'redo';
  return null;
}

export interface SceneEditHistory {
  /**
   * The records a step will be measured against, read NOW.
   *
   * Only a drag needs this: it puts an operation on the wire every hundred milliseconds
   * while it is being dragged, so by the time the pointer comes up the scene is already
   * most of the way to the "after". Everything else — a reset, an eye, a bin, an import
   * — is one mutation and can leave it to `record`.
   */
  snapshot: (ids: string[]) => SceneModel[];
  /**
   * Run one scene edit and remember it, against a snapshot taken before it started.
   *
   * `ids` is every model the edit touches, including one it removes — a removal has to
   * be named here because after `mutate` there is no record left in the scene to find.
   * An edit that changed nothing (a drag that ended where it started, an update the
   * reducer answered with the same object) records no step, so Ctrl+Z never appears to
   * do nothing.
   */
  recordFrom: (label: string, ids: string[], before: SceneModel[], mutate: () => void) => void;
  /** The same, with the snapshot taken at the moment of the edit. */
  record: (label: string, ids: string[], mutate: () => void) => void;
  undo: () => void;
  redo: () => void;
  mayUndo: boolean;
  mayRedo: boolean;
}

export function useSceneEditHistory(): SceneEditHistory {
  const { broadcastSceneUpdate, broadcastReviewConfig } = usePresence();
  const applyLocalSceneUpdate = useStore((state) => state.applyLocalSceneUpdate);
  const recordStep = useEditHistory((state) => state.record);
  const steps = useEditHistory((state) => state.steps);
  const cursor = useEditHistory((state) => state.cursor);

  // The presence functions through a ref — see the second rule in this file's header.
  const presence = useRef({ broadcastSceneUpdate, broadcastReviewConfig });
  useEffect(() => {
    presence.current = { broadcastSceneUpdate, broadcastReviewConfig };
  });

  const snapshot = useCallback((ids: string[]) => modelsForIds(useStore.getState().scene, ids), []);

  const recordFrom = useCallback((
    label: string,
    ids: string[],
    before: SceneModel[],
    mutate: () => void,
  ) => {
    if (ids.length === 0) {
      mutate();
      return;
    }
    mutate();
    const after = modelsForIds(useStore.getState().scene, ids);
    if (sameSceneModels(before, after)) return;
    recordStep({ label, ids: [...ids], before, after });
  }, [recordStep]);

  const record = useCallback((label: string, ids: string[], mutate: () => void) => {
    recordFrom(label, ids, modelsForIds(useStore.getState().scene, ids), mutate);
  }, [recordFrom]);

  const replay = useCallback((step: HistoryStep, direction: 'undo' | 'redo') => {
    const history = useEditHistory.getState();
    const at = stepIndex(history, direction);
    const store = useStore.getState();
    const plan = planRestore(store.scene, step, direction);
    const { broadcastSceneUpdate: send, broadcastReviewConfig: sendConfig } = presence.current;

    // Somebody removed the model this step was about. There is nothing to send and
    // nothing to put back, so the step goes: leaving it in the stack is a button that
    // does nothing every time it is pressed.
    if (plan.missing.length > 0) {
      history.drop(at);
      store.setReviewEditNotice(historyRefusalNotice(direction, step));
      return;
    }

    const changedSince = direction === 'undo' && changedSinceStep(store.scene, step);

    for (const update of plan.updates) {
      send(update);
      applyLocalSceneUpdate(update);
    }
    // The review keeps every placement of its own, and an undo is a placement change:
    // without this the room would show the model back where it was and the review would
    // still open next month on the place the undo undid.
    if (plan.updates.length > 0) keepReviewPlacements(sendConfig);

    // Refused by the room, or refused by this browser's own reducer. The local half is
    // checked here because it is the half that can be checked: a SCENE_REFUSED arrives
    // later on the socket and lib/usePartyPresence.ts turns it into the model tree's own
    // message, which is the existing refusal the person reads. What must not happen is
    // the cursor moving over a step that did not apply, which would leave every button
    // after it undoing the wrong thing.
    const target = direction === 'undo' ? step.before : step.after;
    if (!sameSceneModels(modelsForIds(useStore.getState().scene, step.ids), target)) {
      history.drop(at);
      store.setReviewEditNotice(historyRefusalNotice(direction, step));
      return;
    }

    history.move(direction === 'undo' ? -1 : 1);
    // The scene has no last-changed-by to name, so the notice is the short sentence —
    // see historyNotice for what would have to change for it to say a name.
    store.setReviewEditNotice(historyNotice(direction, changedSince, null));
  }, [applyLocalSceneUpdate]);

  const undo = useCallback(() => {
    const step = stepToUndo(useEditHistory.getState());
    if (step) replay(step, 'undo');
  }, [replay]);

  const redo = useCallback(() => {
    const step = stepToRedo(useEditHistory.getState());
    if (step) replay(step, 'redo');
  }, [replay]);

  return {
    snapshot,
    recordFrom,
    record,
    undo,
    redo,
    mayUndo: canUndo({ cursor }),
    mayRedo: canRedo({ steps, cursor }),
  };
}

/**
 * The keyboard half, and the owner of the stack's lifetime.
 *
 * Mounted once, in the room's interface, rather than in the strip: the buttons belong
 * to Edit mode but the history does not — hiding a model in the tree and then pressing
 * Ctrl+Z is the same undo whether or not anybody has the edit lock. Gated on the
 * permission instead, because an undo is an edit and offering one to a person the room
 * will refuse is a button that lies.
 *
 * THIS is what empties the stack when the room is left, and it is the only place that
 * does: the strip unmounts on Done and the gizmo unmounts whenever a tool is switched
 * off, and either of those clearing the history would throw away the meeting's undo
 * the moment it stopped being visible.
 */
export function useSceneEditShortcuts(): void {
  const history = useSceneEditHistory();
  const { canChangeModels } = useScenePermissions();

  // The latest undo/redo, read at key-press time rather than closed over: they are
  // rebuilt whenever a store action identity changes, and a listener that captured an
  // older pair would still work but would be detached and re-attached for nothing.
  const historyRef = useRef(history);
  useEffect(() => {
    historyRef.current = history;
  });

  useEffect(() => () => {
    useEditHistory.getState().clear();
  }, []);

  useEffect(() => {
    if (!canChangeModels) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = historyShortcutFor(event.target, event);
      if (!shortcut) return;
      const current = historyRef.current;
      if (shortcut === 'undo' ? !current.mayUndo : !current.mayRedo) return;
      // The browser's own undo is not running here — the focus is not in a text
      // field, which historyShortcutFor has just checked — so the key press is ours.
      event.preventDefault();
      if (shortcut === 'undo') current.undo();
      else current.redo();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canChangeModels]);
}
