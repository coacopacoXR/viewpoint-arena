// Starting a room whose server has never held a scene — the client half of batch BQ2.
//
// The room server sends its scene on connect even when it is empty, and the client
// replaces its own copy with what arrives (batch BB's rule: the room is the live space).
// That was correct for a room that HAD a scene and wrong for one that never had one —
// every new variant room, and any main room whose server storage is gone — where it wiped
// the models the client had just built from the review's history and nothing put them back.
// Found live: a review with two imported models, then Variant, and the variant's room said
// "No model yet", and went on saying it after a full reload.
//
// `seeded: false` is the server asking. These tests are about who answers, with what:
//   * a client that may change the models computes the scene from the review's stored
//     revisions FOR THE LINE IT IS ON and sends it as SCENE_SEED;
//   * a client that may not change them does not — it waits for the seeded SCENE_STATE,
//     the same one a late joiner gets, so a participant can see the models and cannot
//     choose them;
//   * a room that HAS been seeded is left alone, whatever the database says, because a
//     room somebody emptied on purpose must not be refilled behind their back.
//
// Same harness as joinKnock.test.tsx and guestPresence.test.tsx: a fake partysocket driven
// by hand. The two database reads showReviewScene makes are faked; the scene arithmetic
// (sceneFromRevisions, revisionsForSession, applyStoredPlacements) is the real one, so what
// is asserted here is the scene a history actually produces.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { ModelRevision } from '../reviews/revisionsRepo';
import type { ReviewLine } from '../reviews/lines';

interface Listener { (event: unknown): void }

class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 1; // WebSocket.OPEN
  sent: string[] = [];
  listeners = new Map<string, Set<Listener>>();

  constructor(_opts: unknown) {
    FakeSocket.last = this;
  }

  addEventListener(type: string, fn: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: Listener) {
    this.listeners.get(type)?.delete(fn);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  /** Fire the socket's 'open' handlers, as partysocket does once connected. */
  open() {
    for (const fn of this.listeners.get('open') ?? []) fn({});
  }

  /** Deliver a server message. */
  emit(msg: unknown) {
    for (const fn of this.listeners.get('message') ?? []) fn({ data: JSON.stringify(msg) });
  }

  /** Every message this socket sent, parsed. */
  messages(): Array<{ type: string; payload?: unknown }> {
    return this.sent.map((raw) => JSON.parse(raw) as { type: string; payload?: unknown });
  }

  of(type: string): unknown[] {
    return this.messages().filter((m) => m.type === type).map((m) => m.payload);
  }
}

vi.mock('partysocket', () => ({ default: FakeSocket }));

// What this browser is in the review. Faked rather than driven through a real roster read:
// the rule itself is lib/scene/roomScene.scenePermissions and has its own tests, and what
// is being pinned here is that the seed asks it at all.
const authority = vi.hoisted(() => ({
  role: 'owner' as string | null,
  rolesApply: true,
  loading: false,
}));

vi.mock('../reviews/useReviewRole', () => ({
  useReviewRole: () => ({
    role: authority.role,
    rolesApply: authority.rolesApply,
    loading: authority.loading,
    can: () => true,
    ownerId: null,
    members: [],
    refresh: () => undefined,
  }),
}));

const history = vi.hoisted(() => ({
  revisions: [] as ModelRevision[],
  originIds: null as string[] | null,
}));

vi.mock('../reviews/revisionsRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../reviews/revisionsRepo')>();
  return { ...actual, listModelRevisions: vi.fn(async () => history.revisions) };
});

vi.mock('../reviews/linesRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../reviews/linesRepo')>();
  return { ...actual, originRevisionIds: vi.fn(async () => history.originIds) };
});

vi.mock('../../utils/modelLoader', () => ({ parseModelFile: vi.fn() }));

// Imported after the mocks are registered — and dynamically, because a static import of
// anything that reaches usePartyPresence would run the partysocket factory above while
// FakeSocket is still in its TDZ.
const { usePartyPresence } = await import('../usePartyPresence');
const { useStore } = await import('../../store');
const { useActiveReviewStore } = await import('../activeReviewStore');
const { createReviewDraft } = await import('../reviewSetupStore');
const { forgetReviewScene } = await import('../scene/showCurationModel');
type ReviewAsset = import('../reviewSetupStore').ReviewAsset;

const ROOM = 'room-1';
const HASH_A = 'a1'.repeat(32);
const HASH_B = 'b2'.repeat(32);

function revision(overrides: Partial<ModelRevision> = {}): ModelRevision {
  return {
    id: 'rev-1',
    reviewId: ROOM,
    line: 'headphones',
    revision: 'A',
    hash: HASH_A,
    fileName: 'headphones.glb',
    size: 1024,
    notes: '',
    uploadedBy: null,
    uploadedByName: '',
    createdAt: '2026-09-01T09:00:00.000Z',
    ...overrides,
  };
}

/** The live repro's review: created empty, filled by two imports made inside the room. */
const TWO_MODELS: ModelRevision[] = [
  revision({ id: 'rev-1', line: 'headphones', revision: 'A', hash: HASH_A, fileName: 'headphones.glb' }),
  revision({ id: 'rev-2', line: 'bicycle', revision: 'A', hash: HASH_B, fileName: 'bicycle.glb' }),
];

const VARIANT_LINE: ReviewLine = {
  id: 'line-a', reviewId: ROOM, kind: 'variant', name: 'Steel hinge pin', letter: 'A',
  parentSessionId: null, parentLineId: 'line-main', mergedIntoLineId: null, dropReason: null,
  status: 'active', createdBy: null, createdByName: 'Robin',
  createdAt: '2026-09-20T09:00:00.000Z', closedAt: null,
};

function socket(): FakeSocket {
  const found = FakeSocket.last;
  if (!found) throw new Error('no socket was created');
  return found;
}

/**
 * The review this room is holding, the way RoomPage holds it: through setConfig, so the
 * config's own sync runs exactly as it does in the room.
 */
function holdReview(asset: Partial<ReviewAsset> = { modelType: 'none' }) {
  const draft = createReviewDraft(ROOM);
  useActiveReviewStore.getState().setConfig({ ...draft, asset: { ...draft.asset, ...asset } });
}

/**
 * What the room server says on admitting a connection: the scene, and whether it has ever
 * held one. Sent the way sendRoomState sends it, so the order the client sees is the real
 * one.
 */
function sceneState(seeded: boolean, payload: Record<string, unknown> = {}) {
  socket().emit({
    type: 'SCENE_STATE',
    payload: { models: [], builtIn: null, modelEditors: 'host', seeded, ...payload },
  });
}

/** Let the reads showReviewScene makes, and the send that follows them, settle. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** What one SCENE_SEED carried. */
interface SeedPayload {
  models: Array<{ line: string; revision: string; visible: boolean }>;
  builtIn: string | null;
}

function seeds(): SeedPayload[] {
  return socket().of('SCENE_SEED') as SeedPayload[];
}

beforeEach(() => {
  FakeSocket.last = null;
  history.revisions = TWO_MODELS;
  history.originIds = null;
  authority.role = 'owner';
  authority.rolesApply = true;
  authority.loading = false;
  useStore.setState({ sessionHostId: null, modelEditors: 'host', activeLine: null, sceneRefusal: null });
  useActiveReviewStore.setState({ config: null });
  forgetReviewScene(ROOM);
});

afterEach(() => {
  cleanup();
  useActiveReviewStore.setState({ config: null });
  useStore.setState({ activeLine: null });
});

describe('a room whose server has never held a scene', () => {
  it('is started from the review’s stored models by a client that may change them', async () => {
    holdReview();
    renderHook(() => usePartyPresence(ROOM));
    socket().open();

    sceneState(false);
    await settle();

    // The bug: this room was empty, the empty scene arrived, and nothing ever put the two
    // imported models the review holds onto it — not on the first visit and not after a
    // reload, because a reload is the same sequence again.
    const sent = seeds();
    expect(sent).toHaveLength(1);
    expect(sent[0].models.map((model) => model.line).sort()).toEqual(['bicycle', 'headphones']);
    expect(sent[0].models.every((model) => model.visible)).toBe(true);
    // And the seeder's own screen is showing it rather than waiting on the relay.
    expect(useStore.getState().scene.models).toHaveLength(2);
  });

  it('is NOT started by somebody who may not change the models', async () => {
    authority.role = 'participant';
    holdReview();
    renderHook(() => usePartyPresence(ROOM));
    socket().open();

    sceneState(false);
    await settle();

    // A participant gets the same scene as everybody else — from whoever seeded it — and
    // has no way to choose one. The room is also left unseeded rather than marked, so the
    // next owner to arrive still gets asked.
    expect(seeds()).toHaveLength(0);
    expect(useStore.getState().scene.models).toEqual([]);
  });

  it('is started by the meeting host on an install with no accounts', async () => {
    // identity.mode 'none': there is no role, and the host is the only authority such an
    // install has. Seeding must work there, or the default self-hosted deployment keeps
    // the bug this batch exists to remove.
    authority.rolesApply = false;
    authority.role = null;
    useStore.setState({ sessionHostId: null });
    holdReview();
    renderHook(() => usePartyPresence(ROOM));
    socket().open();

    sceneState(false);
    await settle();

    expect(seeds()).toHaveLength(1);
  });

  it('waits for the role rather than guessing with the safe one', async () => {
    // On a deployment with accounts the role is a participant until the roster lands, so
    // answering at once would have the OWNER of the review decline to seed their own
    // variant room — and the room would stay empty for everybody.
    authority.loading = true;
    authority.role = 'participant';
    holdReview();
    const { rerender } = renderHook(() => usePartyPresence(ROOM));
    socket().open();

    sceneState(false);
    await settle();
    expect(seeds()).toHaveLength(0);

    // The roster landing re-renders the room, which is what asks again.
    authority.loading = false;
    authority.role = 'owner';
    await act(async () => {
      rerender();
    });
    await settle();

    expect(seeds()).toHaveLength(1);
    expect(seeds()[0].models).toHaveLength(2);
  });

  it('seeds the whole history for a variant that has never met', async () => {
    // A variant with no parent session has no origin to narrow to, so what it starts from
    // is the main line's current scene as the DATABASE knows it: the latest visible
    // revision of every line, with the placements the review stored.
    history.revisions = [
      ...TWO_MODELS,
      revision({ id: 'rev-3', line: 'headphones', revision: 'B', hash: 'c3'.repeat(32), fileName: 'headphones-v2.glb' }),
    ];
    history.originIds = null;
    useStore.setState({ activeLine: VARIANT_LINE });
    holdReview();
    renderHook(() => usePartyPresence(ROOM));
    socket().open();

    sceneState(false);
    await settle();

    const sent = seeds();
    expect(sent).toHaveLength(1);
    // Rev B of the headphones superseded Rev A, so the history is still there for Compare
    // but the newest is what the room opens on.
    expect(sent[0].models).toHaveLength(3);
    expect(sent[0].models.find((model) => model.revision === 'B')?.visible).toBe(true);
    expect(sent[0].models.find((model) => model.revision === 'A' && model.line === 'headphones')?.visible).toBe(false);
    expect(sent[0].models.map((model) => model.line).sort()).toEqual(['bicycle', 'headphones', 'headphones']);
  });

  it('seeds what its line was last looking at, not the review’s newest upload', async () => {
    // docs/plan/15 batch BK: a session starts where its line left off. The review has been
    // to Rev B; the line this room is on last met on Rev A.
    history.revisions = [
      ...TWO_MODELS,
      revision({ id: 'rev-3', line: 'headphones', revision: 'B', hash: 'c3'.repeat(32), fileName: 'headphones-v2.glb' }),
    ];
    history.originIds = ['rev-1'];
    useStore.setState({ activeLine: VARIANT_LINE });
    holdReview();
    renderHook(() => usePartyPresence(ROOM));
    socket().open();

    sceneState(false);
    await settle();

    const sent = seeds();
    expect(sent).toHaveLength(1);
    expect(sent[0].models).toHaveLength(1);
    expect(sent[0].models[0]).toMatchObject({ line: 'headphones', revision: 'A', visible: true });
  });

  it('answers a room that asks later, when the review’s row lands after the scene did', async () => {
    // The order on a reload: SCENE_STATE is in the bundle the server sends on admission,
    // and the review's row is a database read that starts after it. A seed that only asked
    // at the moment the scene arrived would never fire on a reload — which is exactly the
    // half of the live repro that survived a page refresh.
    renderHook(() => usePartyPresence(ROOM));
    socket().open();

    sceneState(false);
    await settle();
    expect(seeds()).toHaveLength(0);

    holdReview();
    await settle();

    expect(seeds()).toHaveLength(1);
    expect(seeds()[0].models).toHaveLength(2);
  });

  it('offers the review’s preset when it has no stored models', async () => {
    // A preset IS part of the scene record (`builtIn`), so a variant of a review that has
    // never had anything imported starts from the same sample the review names rather than
    // from nothing — and from the ASSET rather than from whatever the store happens to
    // hold, because the SCENE_STATE that asked wiped the store a moment earlier.
    history.revisions = [];
    holdReview({ modelType: 'headphones' });
    renderHook(() => usePartyPresence(ROOM));
    socket().open();

    sceneState(false);
    await settle();

    expect(seeds()).toHaveLength(1);
    expect(seeds()[0].models).toEqual([]);
    expect(seeds()[0].builtIn).toBe('headphones');
  });

  it('offers nothing at all for a room with no review in it', async () => {
    // An ad-hoc session, and every room from before reviews existed. There is no history to
    // read and no preset to name, so the room stays unseeded and empty — which is what it
    // was, and what the empty room's own "Try a sample" prompt is for.
    renderHook(() => usePartyPresence(ROOM));
    socket().open();

    sceneState(false);
    await settle();

    expect(seeds()).toHaveLength(0);
  });
});

describe('a room that has held a scene', () => {
  it('is left alone, whatever the review’s history says', async () => {
    holdReview();
    renderHook(() => usePartyPresence(ROOM));
    socket().open();

    sceneState(true, { models: [], builtIn: null });
    await settle();

    // Somebody emptied this room on purpose. Refilling it from the database behind their
    // back is the failure the flag exists to prevent, and it is also why the flag is about
    // the ROOM rather than about the model list being empty.
    expect(seeds()).toHaveLength(0);
  });

  it('adopts the models it is sent, as it always did', async () => {
    holdReview();
    renderHook(() => usePartyPresence(ROOM));
    socket().open();

    sceneState(true, {
      models: [{
        id: `model-${HASH_A}`, hash: HASH_A, fileName: 'headphones.glb', line: 'headphones',
        revision: 'A', visible: true, offset: [0, 0, 0],
      }],
    });
    await settle();

    expect(useStore.getState().scene.models).toHaveLength(1);
    expect(seeds()).toHaveLength(0);
  });

  it('reads no flag from a server that has not been updated, and so does not seed one', async () => {
    // A mixed deployment: a client from this build against a room server from the last one.
    // Absent has to read as "seeded", or the new client would rebuild its scene from the
    // database over whatever the old server was actually holding.
    holdReview();
    renderHook(() => usePartyPresence(ROOM));
    socket().open();

    socket().emit({
      type: 'SCENE_STATE',
      payload: { models: [], builtIn: null, modelEditors: 'host' },
    });
    await settle();

    expect(seeds()).toHaveLength(0);
  });
});

describe('being refused', () => {
  it('says nothing when somebody else seeded the room first', async () => {
    holdReview();
    renderHook(() => usePartyPresence(ROOM));
    socket().open();

    sceneState(false);
    await settle();
    expect(seeds()).toHaveLength(1);

    socket().emit({ type: 'SCENE_REFUSED', payload: { reason: 'already_seeded' } });
    await act(async () => {});

    // Two people opened the same empty variant room at the same moment. The first won and
    // its scene is already on its way to everybody, so the second is not shown a red banner
    // about a race the room settled correctly.
    expect(useStore.getState().sceneRefusal).toBeNull();
  });

  it('still shows every other refusal', async () => {
    holdReview();
    renderHook(() => usePartyPresence(ROOM));
    socket().open();

    socket().emit({ type: 'SCENE_REFUSED', payload: { reason: 'host-only' } });
    await act(async () => {});

    expect(useStore.getState().sceneRefusal).toMatch(/Only the host/);
  });
});
