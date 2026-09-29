// The wiring between the room and its undo stack — batch BT.
//
// lib/scene/editHistory.ts holds the stack and its rules and has its own test; this is
// the half that needs a room, and the three things it can get wrong:
//
//   • recording. One step per EDIT and not per frame: a drag that fires a hundred
//     pointer-moves is one thing a person did, and a hundred steps of it is a history
//     nobody can walk back through. A mutation that changed nothing records nothing.
//   • refusing. An undo is an edit, so the room can say no — and a model somebody else
//     removed while this person was moving something else is a step that cannot be
//     replayed at all. Both have to drop the step rather than leave a button that lies,
//     and neither may throw.
//   • the keys. Ctrl+Z anywhere in the room, and NOT anywhere the browser's own undo
//     belongs: a card being written, a slide title, a search box.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useStore } from '../../../store';
import { useActiveReviewStore } from '../../../lib/activeReviewStore';
import { useEditHistory, type HistoryStep } from '../editHistory';
import { sceneModelId, type SceneModel, type SceneUpdate } from '../roomScene';

const HASH = 'a1'.repeat(32);
const MODEL_ID = sceneModelId(HASH);

const wire = vi.hoisted(() => ({ sceneUpdates: [] as SceneUpdate[] }));
const permissions = vi.hoisted(() => ({ canChangeModels: true }));

vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => ({
    localUserId: 'me',
    broadcastSceneUpdate: (update: SceneUpdate) => {
      wire.sceneUpdates.push(update);
      return true;
    },
    broadcastReviewConfig: () => true,
  }),
}));

// The permission is mocked rather than arranged: useScenePermissions reads the review's
// roster through a database hook, and "may this person undo" is the shortcut gate's own
// question, not something this test is about answering twice.
vi.mock('../useScenePermissions', () => ({
  useScenePermissions: () => permissions,
}));

const { useSceneEditHistory, useSceneEditShortcuts, historyShortcutFor } =
  await import('../useSceneEditHistory');
type SceneEditHistory = ReturnType<typeof useSceneEditHistory>;

let api: SceneEditHistory | null = null;

/** Renders the hook and hands it to the test, which is all a hook needs here. */
const Probe: React.FC = () => {
  api = useSceneEditHistory();
  return null;
};

/** The same, plus the room's key bindings — a second component because a hook cannot be
 * called conditionally, and "with the keys" and "without" are the two things under test. */
const KeysProbe: React.FC = () => {
  api = useSceneEditHistory();
  useSceneEditShortcuts();
  return null;
};

function model(over: Partial<SceneModel> = {}): SceneModel {
  return {
    id: MODEL_ID,
    hash: HASH,
    fileName: 'bracket.step',
    line: 'bracket',
    revision: 'A',
    visible: true,
    offset: [0, 0, 0],
    ...over,
  };
}

function putScene(...models: SceneModel[]) {
  useStore.setState({ scene: { models, builtIn: null }, reviewEditNotice: null });
}

function move(to: number): SceneUpdate {
  return {
    op: 'setTransform',
    id: MODEL_ID,
    transform: { offset: [to, 0, 0], rotation: [0, 0, 0], scale: 1 },
  };
}

beforeEach(() => {
  putScene(model());
  useActiveReviewStore.setState({ config: null });
  useEditHistory.getState().clear();
  wire.sceneUpdates.length = 0;
  permissions.canChangeModels = true;
  api = null;
});

afterEach(() => {
  cleanup();
  useEditHistory.getState().clear();
  useStore.setState({ reviewEditNotice: null });
});

describe('historyShortcutFor', () => {
  const keys = (over: Partial<Parameters<typeof historyShortcutFor>[1]> = {}) => ({
    key: 'z', ctrlKey: false, metaKey: false, shiftKey: false, ...over,
  });

  it('is Ctrl+Z and Ctrl+Shift+Z, and Ctrl+Y beside them', () => {
    expect(historyShortcutFor(document.body, keys({ ctrlKey: true }))).toBe('undo');
    expect(historyShortcutFor(document.body, keys({ ctrlKey: true, shiftKey: true }))).toBe('redo');
    expect(historyShortcutFor(document.body, keys({ key: 'y', ctrlKey: true }))).toBe('redo');
  });

  it('is Cmd on macOS', () => {
    expect(historyShortcutFor(document.body, keys({ metaKey: true }))).toBe('undo');
    expect(historyShortcutFor(document.body, keys({ metaKey: true, shiftKey: true }))).toBe('redo');
  });

  it('is nothing without a modifier, and nothing for a key it does not own', () => {
    expect(historyShortcutFor(document.body, keys())).toBeNull();
    expect(historyShortcutFor(document.body, keys({ ctrlKey: true, key: 'w' }))).toBeNull();
    // Ctrl+Shift+Y is not a redo anybody asked for, and guessing would eat a browser key.
    expect(historyShortcutFor(document.body, keys({ key: 'y', ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it('stands aside while the focus is in a field, so typing still undoes text', () => {
    const input = document.createElement('input');
    const area = document.createElement('textarea');
    const editable = document.createElement('div');
    Object.defineProperty(editable, 'isContentEditable', { value: true });

    for (const field of [input, area, editable]) {
      expect(historyShortcutFor(field, keys({ ctrlKey: true }))).toBeNull();
      expect(historyShortcutFor(field, keys({ ctrlKey: true, shiftKey: true }))).toBeNull();
    }
  });
});

describe('recording', () => {
  it('is one step for one edit, whatever the edit did to get there', () => {
    render(<Probe />);
    const history = api as SceneEditHistory;

    // What a drag looks like from here: the gizmo sends an operation per throttled frame
    // and one more when the pointer comes up, and the step is recorded once at the end.
    act(() => history.record('Moved bracket · Rev A', [MODEL_ID], () => {
      useStore.getState().applyLocalSceneUpdate(move(1));
      useStore.getState().applyLocalSceneUpdate(move(2));
      useStore.getState().applyLocalSceneUpdate(move(3));
    }));

    const state = useEditHistory.getState();
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0].before).toEqual([model()]);
    // `setTransform` writes all three fields, so the record after a drag carries a
    // rotation and a scale the untouched one does not — and sameSceneModel reads both as
    // the identity they are, which is what keeps this from being a step for nothing.
    expect(state.steps[0].after).toEqual([model({ offset: [3, 0, 0], rotation: [0, 0, 0], scale: 1 })]);
    expect(state.cursor).toBe(1);
  });

  it('records nothing for an edit that changed nothing', () => {
    render(<Probe />);
    const history = api as SceneEditHistory;

    // A press on a gizmo handle that never moved, a Reset on a part that is already
    // where the file had it: both reach this path, and a step for either is a Ctrl+Z
    // that appears to do nothing.
    act(() => history.record('Moved bracket · Rev A', [MODEL_ID], () => {
      useStore.getState().applyLocalSceneUpdate(move(0));
    }));

    expect(useEditHistory.getState().steps).toHaveLength(0);
  });

  it('records a removal, which leaves no record behind to find afterwards', () => {
    render(<Probe />);
    const history = api as SceneEditHistory;

    act(() => history.record('Removed bracket · Rev A', [MODEL_ID], () => {
      useStore.getState().applyLocalSceneUpdate({ op: 'remove', id: MODEL_ID });
    }));

    const step = useEditHistory.getState().steps[0];
    expect(step.after).toEqual([]);
    expect(step.before).toEqual([model()]);
  });
});

describe('undoing', () => {
  it('sends the before record through the same door the edit went through', () => {
    render(<Probe />);
    const history = api as SceneEditHistory;

    act(() => history.record('Moved bracket · Rev A', [MODEL_ID], () => {
      useStore.getState().applyLocalSceneUpdate(move(4));
    }));
    wire.sceneUpdates.length = 0;

    act(() => history.undo());

    expect(wire.sceneUpdates).toEqual([
      { op: 'setTransform', id: MODEL_ID, transform: { offset: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } },
    ]);
    expect(useStore.getState().scene.models[0].offset).toEqual([0, 0, 0]);
    expect(useStore.getState().reviewEditNotice).toBe('Undone.');
    expect(useEditHistory.getState().cursor).toBe(0);
  });

  it('puts a removed model back, and takes an added one away', () => {
    render(<Probe />);
    const history = api as SceneEditHistory;

    act(() => history.record('Removed bracket · Rev A', [MODEL_ID], () => {
      useStore.getState().applyLocalSceneUpdate({ op: 'remove', id: MODEL_ID });
    }));
    expect(useStore.getState().scene.models).toHaveLength(0);

    act(() => history.undo());
    expect(useStore.getState().scene.models).toEqual([model()]);

    act(() => history.redo());
    expect(useStore.getState().scene.models).toHaveLength(0);
  });

  it('still undoes when somebody else moved the model in between, and says so', () => {
    render(<Probe />);
    const history = api as SceneEditHistory;

    act(() => history.record('Moved bracket · Rev A', [MODEL_ID], () => {
      useStore.getState().applyLocalSceneUpdate(move(4));
    }));
    // Olga, afterwards.
    act(() => useStore.getState().applyLocalSceneUpdate(move(9)));

    act(() => history.undo());

    expect(useStore.getState().scene.models[0].offset).toEqual([0, 0, 0]);
    // The scene carries no last-changed-by, so the notice cannot name her today; it says
    // the undo happened rather than staying quiet about a colleague's edit being replaced.
    expect(useStore.getState().reviewEditNotice).toBe('Undone.');
  });

  it('drops a step whose model somebody else removed, instead of offering it again', () => {
    render(<Probe />);
    const history = api as SceneEditHistory;

    act(() => history.record('Moved bracket · Rev A', [MODEL_ID], () => {
      useStore.getState().applyLocalSceneUpdate(move(4));
    }));
    act(() => useStore.getState().applyLocalSceneUpdate({ op: 'remove', id: MODEL_ID }));

    expect(() => act(() => history.undo())).not.toThrow();

    const state = useEditHistory.getState();
    expect(state.steps).toHaveLength(0);
    expect(state.cursor).toBe(0);
    // Re-adding it would put a product back into a meeting that has moved on without it.
    expect(wire.sceneUpdates.filter((update) => update.op === 'add')).toHaveLength(0);
    expect(useStore.getState().reviewEditNotice).toContain('Cannot undo');
  });

  it('does nothing at all when there is nothing to undo', () => {
    render(<Probe />);
    const history = api as SceneEditHistory;

    expect(() => act(() => history.undo())).not.toThrow();
    expect(() => act(() => history.redo())).not.toThrow();
    expect(wire.sceneUpdates).toHaveLength(0);
  });

  it('reports what may be done, which is what the two buttons read', () => {
    render(<Probe />);
    const history = api as SceneEditHistory;
    expect(history.mayUndo).toBe(false);
    expect(history.mayRedo).toBe(false);

    act(() => history.record('Moved bracket · Rev A', [MODEL_ID], () => {
      useStore.getState().applyLocalSceneUpdate(move(4));
    }));
    const after = api as SceneEditHistory;
    expect(after.mayUndo).toBe(true);
    expect(after.mayRedo).toBe(false);

    act(() => after.undo());
    const undone = api as SceneEditHistory;
    expect(undone.mayUndo).toBe(false);
    expect(undone.mayRedo).toBe(true);
  });
});

describe('the keys, in the room', () => {
  function press(target: EventTarget, over: Partial<Parameters<typeof historyShortcutFor>[1]> = {}) {
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'z', ctrlKey: true, bubbles: true, cancelable: true, ...over,
      }));
    });
  }

  function movedOnce() {
    const history = api as SceneEditHistory;
    act(() => history.record('Moved bracket · Rev A', [MODEL_ID], () => {
      useStore.getState().applyLocalSceneUpdate(move(4));
    }));
  }

  it('undoes from Ctrl+Z pressed anywhere in the room', () => {
    render(<KeysProbe />);
    movedOnce();

    press(document.body);
    expect(useStore.getState().scene.models[0].offset).toEqual([0, 0, 0]);
  });

  it('redoes from Ctrl+Shift+Z', () => {
    render(<KeysProbe />);
    movedOnce();
    press(document.body);
    press(document.body, { shiftKey: true });
    expect(useStore.getState().scene.models[0].offset).toEqual([4, 0, 0]);
  });

  it('leaves Ctrl+Z to the browser while the focus is in a field', () => {
    render(<KeysProbe />);
    movedOnce();

    const input = document.createElement('input');
    document.body.appendChild(input);
    press(input);
    expect(useStore.getState().scene.models[0].offset).toEqual([4, 0, 0]);
    input.remove();
  });

  it('does not take the key from somebody who may not change the models', () => {
    permissions.canChangeModels = false;
    render(<KeysProbe />);
    movedOnce();

    press(document.body);
    expect(useStore.getState().scene.models[0].offset).toEqual([4, 0, 0]);
  });

  it('empties the stack when the room is left', () => {
    const view = render(<KeysProbe />);
    movedOnce();
    expect(useEditHistory.getState().steps).toHaveLength(1);

    view.unmount();
    expect(useEditHistory.getState().steps).toHaveLength(0);
  });

  it('keeps the stack when only the strip goes away', () => {
    // Done ends Edit mode and unmounts the buttons; the history belongs to the room, so
    // pressing Edit again a minute later has to find it still there.
    const view = render(<Probe />);
    movedOnce();
    view.unmount();
    expect(useEditHistory.getState().steps).toHaveLength(1);
  });
});

describe('a step recorded by hand', () => {
  it('is replayed exactly like one the hooks recorded', () => {
    render(<Probe />);
    const step: HistoryStep = {
      label: 'Hid bracket · Rev A',
      ids: [MODEL_ID],
      before: [model()],
      after: [model({ visible: false })],
    };
    act(() => useStore.getState().applyLocalSceneUpdate({ op: 'setVisible', id: MODEL_ID, visible: false }));
    act(() => useEditHistory.getState().record(step));

    act(() => (api as SceneEditHistory).undo());

    expect(useStore.getState().scene.models[0].visible).toBe(true);
    expect(wire.sceneUpdates[wire.sceneUpdates.length - 1]).toEqual({
      op: 'setVisible', id: MODEL_ID, visible: true,
    });
  });
});
