// A room with nothing in it — batch BI's first section, at the store level.
//
// The app had never had to cope with "there is no model": store.ts held a
// DEFAULT_BUILT_IN of 'headphones', so `activeModelType` always named a product and
// every reader could assume there was a part list behind it. What these tests pin
// is the new default and the three things that must not silently keep assuming the
// old one — the part list a capture is grounded on, the product name a tracker row
// carries, and a scene that already has a model in it, which must be left alone.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EMPTY_SCENE_TREE, getCurrentSceneTree, sceneComponents, useStore } from '../store';
import { createReviewDraft, useReviewSetupStore } from '../lib/reviewSetupStore';
import type { ModelType } from '../types';

const flushed = vi.hoisted(() => ({ calls: [] as Array<{ modelName: string | null }> }));

vi.mock('../lib/trackerBridge', () => ({
  flushSessionToTracker: vi.fn(async (opts: { modelName: string | null }) => {
    flushed.calls.push({ modelName: opts.modelName });
  }),
}));

const HASH = 'a1'.repeat(32);

function importedScene() {
  return {
    models: [{
      id: 'model-1',
      hash: HASH,
      fileName: 'bracket.step',
      line: 'bracket',
      revision: 'A',
      visible: true,
      offset: [0, 0, 0] as [number, number, number],
    }],
    builtIn: null,
  };
}

describe('a fresh room', () => {
  // Read once, before any test has touched the store: this IS the default.
  const initial = useStore.getState();

  it('has no model at all', () => {
    expect(initial.activeModelType).toBe('none');
    expect(initial.scene).toEqual({ models: [], builtIn: null });
  });

  it('has no points of interest for its agents to inspect', () => {
    // An empty room used to be unreachable, so this was never a question. It is
    // now the first thing every room is, and an agent with a target called "No
    // model" at the origin would be inspecting nothing.
    expect(initial.pois).toEqual([]);
  });

  it('names no product in the model tree', () => {
    expect(getCurrentSceneTree('none', null, null, null)).toBe(EMPTY_SCENE_TREE);
    expect(EMPTY_SCENE_TREE.children).toEqual([]);
  });
});

describe('a room with nothing in it — what a reader gets', () => {
  it('grounds a capture on no components at all, rather than on a preset\'s', () => {
    // RecordingContext builds the grounded context from sceneComponents, and the
    // chat panel suggests part names from the same call. With 'none' falling
    // through to the SYNTH tree — the old default at the bottom of
    // getCurrentSceneTree — a capture taken in an empty room would have told the
    // model that the meeting was about a synthesiser's parts.
    expect(sceneComponents('none', null)).toEqual([]);
    // The helper is not simply always empty: a room that does have a model still
    // grounds on its parts.
    expect(sceneComponents('headphones', null).length).toBeGreaterThan(0);
  });

  it('records no product name in the tracker', () => {
    // 'none' is the app's own spelling of "no model". Writing it into model_name
    // would put a product called "none" in the tracker's list of products.
    useStore.setState({ activeModelType: 'none', scene: { models: [], builtIn: null }, insightCards: [] });
    flushed.calls.length = 0;

    useStore.getState().endMeeting(true, 1);

    expect(flushed.calls).toHaveLength(1);
    expect(flushed.calls[0].modelName).toBeNull();
  });

  it('still records the product a room was actually held on', () => {
    useStore.setState({ activeModelType: 'headphones', insightCards: [] });
    flushed.calls.length = 0;

    useStore.getState().endMeeting(true, 1);

    expect(flushed.calls[0].modelName).toBe('headphones');
    useStore.setState({ isMeetingEnded: false });
  });
});

describe('a scene that already has a model keeps it', () => {
  beforeEach(() => {
    useStore.setState({ scene: { models: [], builtIn: null }, activeModelType: 'none' });
  });

  it('reads an imported model as imported, and a sample as itself', () => {
    useStore.getState().setRoomScene(importedScene());
    expect(useStore.getState().activeModelType).toBe('imported');

    useStore.getState().setRoomScene({ models: [], builtIn: 'bicycle' });
    expect(useStore.getState().activeModelType).toBe('bicycle');
  });

  it('answers a part list for a model that is there', () => {
    useStore.getState().setRoomScene({ models: [], builtIn: 'headphones' });
    const tree = getCurrentSceneTree(useStore.getState().activeModelType, null, null, null);
    expect(tree).not.toBe(EMPTY_SCENE_TREE);
    expect(tree.name).toBe('Headphones');
  });

  it('empties the scene again when asked, which is what choosing no model means', () => {
    useStore.getState().setRoomScene(importedScene());
    useStore.getState().setActiveModelType('none');

    const state = useStore.getState();
    expect(state.scene).toEqual({ models: [], builtIn: null });
    expect(state.activeModelType).toBe('none');
    expect(state.pois).toEqual([]);
  });

  it('is a ModelType every reader can be handed', () => {
    // Cheap exhaustiveness: a member added to the union without a branch here is a
    // compile error rather than a room that quietly renders nothing.
    const handled: Record<ModelType, true> = {
      none: true, synth: true, bicycle: true, imported: true, headphones: true,
    };
    expect(Object.keys(handled)).toHaveLength(5);
  });
});

describe('a new design review', () => {
  it('is created with no model', () => {
    expect(createReviewDraft('review-1').asset.modelType).toBe('none');
  });

  it('goes back to no model when its imported file is cleared', () => {
    // Not back to a sample: removing the file somebody uploaded leaves the review
    // with nothing on screen, which is what it started with.
    useReviewSetupStore.getState().startNewDraft('review-1');
    useReviewSetupStore.getState().setImportedFile('bracket.step', HASH);
    expect(useReviewSetupStore.getState().draft?.asset.modelType).toBe('imported');

    useReviewSetupStore.getState().clearImportedFile();

    expect(useReviewSetupStore.getState().draft?.asset.modelType).toBe('none');
    useReviewSetupStore.getState().discardDraft();
  });
});
