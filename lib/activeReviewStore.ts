import { create } from 'zustand';
import {
  reviewTitleFrom,
  type AgendaItem,
  type NewAgendaItem,
  type ReviewAssetReference,
  type ReviewDraft,
  type ReviewViewpoint,
  type ReviewPin,
} from './reviewSetupStore';
import type { SpatialComment, Requirement } from '../types';
import type { TeamMember } from './people';
import { useStore } from '../store';
import { forgetReviewScene, showReviewScene } from './scene/showCurationModel';
import { placementsForLine, samePlacements, type StoredPlacement } from './scene/placement';
import { forgetLocalEdit, markLocalEdit } from './reviewLocalEdit';

// Build a live SpatialComment from a curated pin at commit time. The comment
// is authored by whoever presses the button (not the curator), attached to the
// same node the pin was placed on, and uses the pin's notes — or its label
// when there are no notes, or "label — notes" when both are present.
export function pinToLiveComment(
  pin: ReviewPin,
  author: string,
  authorColor: string,
): SpatialComment {
  const content = pin.notes?.trim()
    ? (pin.label.trim() ? `${pin.label.trim()} — ${pin.notes.trim()}` : pin.notes.trim())
    : (pin.label.trim() || 'Pinned comment');
  return {
    id: Math.random().toString(36).substr(2, 9),
    type: 'text',
    content,
    author,
    authorColor,
    timestamp: Date.now(),
    position: { x: pin.worldPos[0], y: pin.worldPos[1], z: pin.worldPos[2] },
    attachedToNodeId: pin.meshIndex ?? pin.modelId ?? '',
    attachedToNodeName: pin.partName ?? pin.label,
    assignees: [],
    resolved: false,
    linkedToMeeting: false,
  };
}

// Room-time view of the curated review. Distinct from the host's local draft:
// this is the config currently in effect in the live session (received from the
// host via PartyKit, or seeded directly by the host on entry).
//
// Pre-curated content is mirrored into the main `comments` store so it surfaces
// in the existing comments module. The review store remains the source of truth
// — we re-synthesize the comments whenever the config changes.

const PRE_VP_PREFIX = 'pre-vp-';
const PRE_PIN_PREFIX = 'pre-pin-';

function newId(): string {
  return (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

/**
 * A new draft with one field replaced, and the timestamp every write carries.
 *
 * Batch BH moved the curation tabs into the room, which brought eleven writes
 * with them that this store did not have. Each is the same three steps as the
 * ones above it — take the config, produce a new draft, put it back — so the
 * repetition lives here once rather than eleven times, and each caller still
 * names the field it changed and the sync that follows it.
 */
function edited(cfg: ReviewDraft, change: Partial<ReviewDraft>): ReviewDraft {
  return { ...cfg, ...change, updatedAt: Date.now() };
}

/**
 * Put an edited review in the store, and say that THIS browser is the one that
 * edited it.
 *
 * Every write to `config` below goes through here, and `setConfig` — the copy
 * that arrives from the room server, from the database, or from the lobby —
 * deliberately does not. That mark is the only thing that makes pages/RoomPage
 * write the review back: a change on its own says nothing about whose change it
 * was, and saving somebody else's (or an older) copy is what batch BH3 fixed.
 * See lib/reviewLocalEdit.
 */
function applyEdit(set: (partial: Partial<ActiveReviewState>) => void, next: ReviewDraft): void {
  markLocalEdit();
  set({ config: next });
}

/**
 * Move one element of a list, the way dragging a card onto another means it.
 *
 * An index outside the list — a stale drag, a card somebody else removed a moment
 * ago — answers with the list it was given, unchanged and by identity, so the
 * caller's "nothing happened" test works the same way the scene reducer's does.
 */
function moved<T>(list: T[], fromIdx: number, toIdx: number): T[] {
  if (fromIdx === toIdx) return list;
  if (fromIdx < 0 || toIdx < 0 || fromIdx >= list.length || toIdx >= list.length) return list;
  const next = [...list];
  const removed = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, removed[0]);
  return next;
}

/** One agenda slide with one of its two link lists replaced. */
function withAgendaLinks(
  cfg: ReviewDraft,
  itemId: string,
  change: (item: AgendaItem) => Pick<AgendaItem, 'viewpointIds' | 'pinIds'>,
): ReviewDraft {
  return edited(cfg, {
    agenda: cfg.agenda.map((item) => (item.id === itemId ? { ...item, ...change(item) } : item)),
  });
}

function viewpointToComment(v: ReviewViewpoint): SpatialComment {
  return {
    id: `${PRE_VP_PREFIX}${v.id}`,
    type: 'drawing', // viewpoints carry a visual annotation (thumbnail)
    content: v.notes ?? '',
    drawingData: v.thumbnail,
    author: 'Curator',
    authorColor: '#10b981',
    timestamp: v.createdAt,
    position: { x: v.position[0], y: v.position[1], z: v.position[2] },
    attachedToNodeId: 'viewpoint',
    attachedToNodeName: v.label || 'Viewpoint',
    assignees: [],
    resolved: false,
    linkedToMeeting: false,
    preReview: true,
    preReviewSourceId: v.id,
    preReviewSourceKind: 'viewpoint',
  };
}

function pinToComment(p: ReviewPin): SpatialComment {
  return {
    id: `${PRE_PIN_PREFIX}${p.id}`,
    type: 'text', // pins are text-only comments
    content: p.notes ?? '',
    author: 'Curator',
    authorColor: '#10b981',
    timestamp: p.createdAt,
    position: { x: p.worldPos[0], y: p.worldPos[1], z: p.worldPos[2] },
    attachedToNodeId: p.modelId ?? 'unknown',
    attachedToNodeName: p.partName ? `${p.label} · ${p.partName}` : p.label,
    assignees: [],
    resolved: false,
    linkedToMeeting: false,
    preReview: true,
    preReviewSourceId: p.id,
    preReviewSourceKind: 'pin',
  };
}

// Replace all pre-review entries in the main comments store with a fresh
// synthesis from the active review config. Live (non-pre-review) comments
// are preserved untouched.
function syncMainComments(config: ReviewDraft | null) {
  const main = useStore.getState();
  const live = main.comments.filter((c) => !c.preReview);
  if (!config) {
    main.setAllComments(live);
    return;
  }
  const synthesized: SpatialComment[] = [
    ...config.viewpoints.map(viewpointToComment),
    ...config.pins.map(pinToComment),
  ];
  main.setAllComments([...live, ...synthesized]);
}

// Push the review's requirements onto the main store so InsightDetailModal,
// DialogueEngine, and MeetingSummary resolve affectedRequirementIds from the
// active review instead of a global constant. Empty when there is no review.
function syncMainRequirements(config: ReviewDraft | null) {
  const main = useStore.getState();
  main.setRequirements(config?.requirements ?? []);
}

// Make sure the World renders the curation's model. World reads
// `activeModelType` from the main store, so loading a curation that
// specifies e.g. 'bicycle' has to push that onto the main store too —
// otherwise the room loads with whatever was already on screen. An
// imported file becomes a scene holding the review's models; see
// lib/scene/showCurationModel, which the review setup page also
// calls so that both paths build the same scene.
function syncMainModel(config: ReviewDraft | null) {
  if (!config) return;
  const { setActiveModelType, setModelTransform } = useStore.getState();
  const a = config.asset;
  // Push the curator's transform onto the main store (used by World's group
  // wrapper). Identity if none was set.
  setModelTransform(a?.transform ?? { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 });
  if (!a?.modelType) return;
  if (a.modelType === 'imported') {
    // The whole review rather than only the model its curation row names: a
    // design review that has been through three revisions opens on the third,
    // with the first two present and hidden so Compare can still reach them
    // (docs/plan/14 batch BC). A review with no stored revisions — every one
    // written before model_revisions existed — gets exactly the one-model scene
    // it got before, synchronously, because the async half of showReviewScene
    // starts after the scene is already set and only ever adds to it.
    void showReviewScene(config.reviewId, a, 'activeReviewStore');
    return;
  }
  // 'none' names no model, so it has nothing to put on screen — and it must not
  // take anything OFF it either. Every review created since batch BI carries
  // 'none', including one whose room is holding models the room server relayed or
  // somebody imported after opening it; setActiveModelType('none') would adopt an
  // empty scene, and `fresh` takes the meeting's comments, chat and cards with it.
  // The scene is the room server's (batch BB's rule); a review that names no model
  // simply has no opinion about what is in it.
  if (a.modelType === 'none') return;
  setActiveModelType(a.modelType);
}

interface ActiveReviewState {
  config: ReviewDraft | null;
  jumpTarget: { position: [number, number, number]; lookAt: [number, number, number] } | null;
  activeViewpointIdx: number;
  agendaIdx: number;
  // Host-only split-screen manager workspace (action triage + follow-up notes).
  managerMode: boolean;
  // Free-form session-wide notes the manager keeps during the meeting (local to
  // each participant — the host's copy is what matters; not synced in v1).
  sessionNotes: string;

  setConfig: (c: ReviewDraft | null) => void;
  jumpToViewpoint: (id: string) => void;
  jumpToViewpointAtIdx: (idx: number) => void;
  clearJumpTarget: () => void;

  nextViewpoint: () => void;
  prevViewpoint: () => void;
  setActiveViewpointIdx: (idx: number) => void;

  updateViewpoint: (id: string, patch: Partial<ReviewViewpoint>) => ReviewDraft | null;
  updatePin: (id: string, patch: Partial<ReviewPin>) => ReviewDraft | null;
  /**
   * Name this design review (batch BQ).
   *
   * The name is a field of the review like any other, so it travels the same way:
   * marked as THIS browser's edit, so RoomPage's subscriber saves it, and returned
   * as a draft so the caller broadcasts it and everybody else in the room is
   * looking at the same name a moment later. An empty answer keeps the name the
   * review already had — see lib/reviewSetupStore.reviewTitleFrom.
   */
  setTitle: (title: string) => ReviewDraft | null;
  /**
   * The writes the curation tabs need, which batch BH moved into the room.
   *
   * The room read this review before and could rename a viewpoint or a pin in it,
   * but it could not add a slide, delete a pin, reorder a requirement or tag the
   * review — those were the curate page's, against its own draft store. They are
   * here now because the tabs are here now, and each one answers with the draft it
   * produced so the caller can broadcast exactly that and nothing else.
   */
  addViewpoint: (vp: Omit<ReviewViewpoint, 'id' | 'createdAt'>) => ReviewDraft | null;
  removeViewpoint: (id: string) => ReviewDraft | null;
  /**
   * Add a pin, which batch BI made possible from inside the room.
   *
   * The Pins tab could list a pin, jump to it and edit it, but not add one:
   * `addPin` existed only in lib/reviewSetupStore, which holds the lobby's draft
   * and not the review a room is presenting. It is here for the reason the other
   * eleven writes are — the tab is here now — and it answers with the draft so the
   * caller broadcasts exactly that.
   */
  addPin: (pin: Omit<ReviewPin, 'id' | 'createdAt'>) => ReviewDraft | null;
  removePin: (id: string) => ReviewDraft | null;
  /**
   * Record a document under the review's asset, which is where references live.
   *
   * Added in batch BG for the PLM launch (T5.3): a room opened from Onshape or
   * Teamcenter records the document it was opened from, and the room has no other
   * way to write one — the curate page that had `addReference` is gone. Same
   * signature lib/reviewSetupStore offers, so both stores write the same shape.
   */
  addReference: (ref: Omit<ReviewAssetReference, 'id'>) => ReviewDraft | null;
  /**
   * Where the room's models are standing, kept with the review.
   *
   * Batch BI. The room's Move / Rotate / Scale write a SceneModel's transform,
   * which the room server persists with its scene — and room storage does not
   * outlive the room. This is the review's copy, written when a drag ends rather
   * than on every frame of it, so opening the review later puts every revision
   * back where it was left. Answering null is how "nothing moved" is spelled: no
   * mark, no broadcast, no write.
   *
   * `lineId` is the slot to write, batch BV: null for the main line, which goes on
   * writing `asset.placements` exactly as it always has, and a variant's id, which
   * writes `asset.linePlacements[id]` and leaves the main line's positions alone.
   * Optional so every caller that predates lines keeps its meaning.
   */
  setScenePlacements: (placements: StoredPlacement[], lineId?: string | null) => ReviewDraft | null;
  addAgendaItem: (item: NewAgendaItem) => ReviewDraft | null;
  removeAgendaItem: (id: string) => ReviewDraft | null;
  reorderAgenda: (fromIdx: number, toIdx: number) => ReviewDraft | null;
  attachViewpointToAgendaItem: (itemId: string, viewpointId: string) => ReviewDraft | null;
  detachViewpointFromAgendaItem: (itemId: string, viewpointId: string) => ReviewDraft | null;
  attachPinToAgendaItem: (itemId: string, pinId: string) => ReviewDraft | null;
  detachPinFromAgendaItem: (itemId: string, pinId: string) => ReviewDraft | null;
  reorderRequirements: (fromIdx: number, toIdx: number) => ReviewDraft | null;
  setLabel: (fieldId: string, value: string) => ReviewDraft | null;
  clearLabel: (fieldId: string) => ReviewDraft | null;
  updateAgendaItem: (id: string, patch: Partial<import('./reviewSetupStore').AgendaItem>) => ReviewDraft | null;

  addRequirement: (req: Omit<Requirement, 'id'>) => ReviewDraft | null;
  updateRequirement: (id: string, patch: Partial<Requirement>) => ReviewDraft | null;
  removeRequirement: (id: string) => ReviewDraft | null;

  addTeamMember: (member: Omit<TeamMember, 'id'>) => ReviewDraft | null;
  updateTeamMember: (id: string, patch: Partial<TeamMember>) => ReviewDraft | null;
  removeTeamMember: (id: string) => ReviewDraft | null;
  reorderTeam: (fromIdx: number, toIdx: number) => ReviewDraft | null;

  // Called by CommentsPanel when the user edits a pre-review comment.
  // Translates the comment patch back into a viewpoint/pin patch and returns
  // the updated draft so the caller can re-broadcast it.
  applyCommentEdit: (commentId: string, patch: Partial<SpatialComment>) => ReviewDraft | null;

  // Commit a curated pin as a live SpatialComment. Returns the created comment
  // and the updated config (so the caller can broadcast REVIEW_CONFIG), or null
  // when there is no config or the pin is unknown/already committed.
  commitPinAsComment: (pinId: string, author: string, authorColor: string) => { comment: SpatialComment; config: ReviewDraft } | null;

  // Clear the committedCommentId on whichever pin holds it. Called when a
  // comment is deleted (locally or via COMMENT_DELETE) so the pin can be
  // committed again.
  clearCommittedCommentId: (commentId: string) => ReviewDraft | null;

  setAgendaIdx: (idx: number) => void;
  nextSlide: () => void;
  prevSlide: () => void;
  jumpToSlide: (idx: number) => void;

  setManagerMode: (open: boolean) => void;
  setSessionNotes: (notes: string) => void;
}

export const useActiveReviewStore = create<ActiveReviewState>((set, get) => ({
  config: null,
  jumpTarget: null,
  activeViewpointIdx: 0,
  agendaIdx: 0,
  managerMode: false,
  sessionNotes: '',

  setConfig: (config) => {
    const previous = get().config;
    // Leaving a review, or moving to a different one, forgets that its scene was
    // already rebuilt from history — so opening it again in this page session
    // opens it properly rather than showing the single model its curation row
    // names. See forgetReviewScene.
    if (previous && previous.reviewId !== config?.reviewId) {
      forgetReviewScene(previous.reviewId);
    }
    // Adopting a copy of the review is not editing it, whichever way the copy
    // arrived — a REVIEW_CONFIG off the socket, the row read on entry, the lobby's
    // handover draft. Any mark still standing was raised by a change no writer was
    // listening for (a viewer who renamed something while nobody had Edit), and it
    // must not licence this copy, or the next one, to be written to the database.
    forgetLocalEdit();
    set({
      config,
      activeViewpointIdx: Math.min(get().activeViewpointIdx, Math.max(0, (config?.viewpoints.length ?? 1) - 1)),
    });
    syncMainComments(config);
    syncMainModel(config);
    syncMainRequirements(config);
  },

  jumpToViewpoint: (id) => {
    const cfg = get().config;
    if (!cfg) return;
    const idx = cfg.viewpoints.findIndex((v) => v.id === id);
    if (idx < 0) return;
    const vp = cfg.viewpoints[idx];
    set({ jumpTarget: { position: vp.position, lookAt: vp.lookAt }, activeViewpointIdx: idx });
  },

  jumpToViewpointAtIdx: (idx) => {
    const cfg = get().config;
    if (!cfg || cfg.viewpoints.length === 0) return;
    const safeIdx = Math.max(0, Math.min(cfg.viewpoints.length - 1, idx));
    const vp = cfg.viewpoints[safeIdx];
    set({ jumpTarget: { position: vp.position, lookAt: vp.lookAt }, activeViewpointIdx: safeIdx });
  },

  clearJumpTarget: () => set({ jumpTarget: null }),

  nextViewpoint: () => {
    const { config, activeViewpointIdx } = get();
    if (!config || config.viewpoints.length === 0) return;
    get().jumpToViewpointAtIdx((activeViewpointIdx + 1) % config.viewpoints.length);
  },
  prevViewpoint: () => {
    const { config, activeViewpointIdx } = get();
    if (!config || config.viewpoints.length === 0) return;
    get().jumpToViewpointAtIdx((activeViewpointIdx - 1 + config.viewpoints.length) % config.viewpoints.length);
  },
  setActiveViewpointIdx: (idx) => set({ activeViewpointIdx: idx }),

  updateViewpoint: (id, patch) => {
    const cfg = get().config;
    if (!cfg) return null;
    const next: ReviewDraft = {
      ...cfg,
      viewpoints: cfg.viewpoints.map((v) => v.id === id ? { ...v, ...patch } : v),
      updatedAt: Date.now(),
    };
    applyEdit(set, next);
    syncMainComments(next);
    return next;
  },
  updatePin: (id, patch) => {
    const cfg = get().config;
    if (!cfg) return null;
    const next: ReviewDraft = {
      ...cfg,
      pins: cfg.pins.map((p) => p.id === id ? { ...p, ...patch } : p),
      updatedAt: Date.now(),
    };
    applyEdit(set, next);
    syncMainComments(next);
    return next;
  },

  setTitle: (title) => {
    const cfg = get().config;
    if (!cfg) return null;
    // The name it already had when the answer is empty, so pressing Enter in a
    // field nobody filled in changes nothing rather than un-naming the review.
    const next = edited(cfg, { title: reviewTitleFrom(title, cfg.title) });
    applyEdit(set, next);
    return next;
  },

  // ─── The curation tabs' writes ──────────────────────────────────────────────
  // Batch BH. Each answers with the draft it produced, or null when there is no
  // review open — which is what "the room has nothing to edit yet" looks like from
  // here, and the reason the caller can broadcast without re-reading the store.

  addViewpoint: (vp) => {
    const cfg = get().config;
    if (!cfg) return null;
    const next = edited(cfg, {
      viewpoints: [...cfg.viewpoints, { ...vp, id: newId(), createdAt: Date.now() }],
    });
    applyEdit(set, next);
    // A viewpoint is also a pre-curated comment in the room's comment list, so the
    // mirror has to be rebuilt — the same step updateViewpoint takes.
    syncMainComments(next);
    return next;
  },

  removeViewpoint: (id) => {
    const cfg = get().config;
    if (!cfg) return null;
    const next = edited(cfg, {
      viewpoints: cfg.viewpoints.filter((v) => v.id !== id),
      // A slide that linked the removed viewpoint would otherwise keep an id that
      // resolves to nothing, and render as a gap where a camera chip was.
      agenda: cfg.agenda.map((item) => (
        item.viewpointIds.includes(id)
          ? { ...item, viewpointIds: item.viewpointIds.filter((v) => v !== id) }
          : item
      )),
    });
    applyEdit(set, next);
    syncMainComments(next);
    return next;
  },

  addPin: (pin) => {
    const cfg = get().config;
    if (!cfg) return null;
    const next = edited(cfg, {
      pins: [...cfg.pins, { ...pin, id: newId(), createdAt: Date.now() }],
    });
    applyEdit(set, next);
    // Mirrored into the room's comment list, exactly as a pin curated in the lobby
    // is: that mirror is what puts the marker on the canvas for everybody, and a
    // pin added live in the room is the same kind of thing as one added before it.
    syncMainComments(next);
    return next;
  },

  removePin: (id) => {
    const cfg = get().config;
    if (!cfg) return null;
    const next = edited(cfg, {
      pins: cfg.pins.filter((p) => p.id !== id),
      agenda: cfg.agenda.map((item) => (
        item.pinIds.includes(id)
          ? { ...item, pinIds: item.pinIds.filter((p) => p !== id) }
          : item
      )),
    });
    applyEdit(set, next);
    syncMainComments(next);
    return next;
  },

  // No sync follows this one: a reference is metadata about the review, so neither
  // the mirrored comments nor the scene nor the requirements change with it.
  addReference: (ref) => {
    const cfg = get().config;
    if (!cfg) return null;
    const next = edited(cfg, {
      asset: {
        ...cfg.asset,
        references: [...cfg.asset.references, { id: newId(), ...ref }],
      },
    });
    applyEdit(set, next);
    return next;
  },

  setScenePlacements: (placements, lineId) => {
    const cfg = get().config;
    if (!cfg) return null;
    // The slot this drag writes: a variant's own id, or null for the main line — which
    // is also the answer for an ad-hoc room, an install with no lines and the curator's
    // setup page, all of which have no line and all of which mean the review's own.
    const wanted = typeof lineId === 'string' ? lineId.trim() : '';
    const slot = wanted === '' ? null : wanted;
    // A drag that ended where it started is not an edit. Treating it as one would
    // mark the review, broadcast the whole of it to everybody in the room and write
    // the row, for a change nobody can see. The list is rebuilt from the scene
    // every time and the scene's order is the order additions arrived in, so the
    // comparison is by (line, revision) and not by position.
    //
    // Against the SLOT being written, read through the same rule the seeding half
    // uses: a variant that has not diverged yet has no slot and stands where the main
    // line stands, so a drag in it that changed nothing writes nothing — and the first
    // drag that does change something creates its slot.
    if (samePlacements(slot === null ? cfg.asset.placements : placementsForLine(cfg.asset, slot), placements)) {
      return null;
    }
    const next = edited(cfg, {
      asset: slot === null
        ? { ...cfg.asset, placements }
        : { ...cfg.asset, linePlacements: { ...cfg.asset.linePlacements, [slot]: placements } },
    });
    applyEdit(set, next);
    // No sync follows: the scene this was read from is already the truth on this
    // screen, and placements say nothing about comments or requirements.
    return next;
  },

  addAgendaItem: (item) => {
    const cfg = get().config;
    if (!cfg) return null;
    const next = edited(cfg, {
      agenda: [...cfg.agenda, {
        ...item,
        id: newId(),
        viewpointIds: item.viewpointIds ?? [],
        pinIds: item.pinIds ?? [],
      }],
    });
    applyEdit(set, next);
    return next;
  },

  removeAgendaItem: (id) => {
    const cfg = get().config;
    if (!cfg) return null;
    const next = edited(cfg, { agenda: cfg.agenda.filter((a) => a.id !== id) });
    applyEdit(set, next);
    return next;
  },

  reorderAgenda: (fromIdx, toIdx) => {
    const cfg = get().config;
    if (!cfg) return null;
    const agenda = moved(cfg.agenda, fromIdx, toIdx);
    if (agenda === cfg.agenda) return null;
    const next = edited(cfg, { agenda });
    applyEdit(set, next);
    return next;
  },

  attachViewpointToAgendaItem: (itemId, viewpointId) => {
    const cfg = get().config;
    if (!cfg) return null;
    const next = withAgendaLinks(cfg, itemId, (item) => ({
      viewpointIds: item.viewpointIds.includes(viewpointId)
        ? item.viewpointIds
        : [...item.viewpointIds, viewpointId],
      pinIds: item.pinIds,
    }));
    applyEdit(set, next);
    return next;
  },

  detachViewpointFromAgendaItem: (itemId, viewpointId) => {
    const cfg = get().config;
    if (!cfg) return null;
    const next = withAgendaLinks(cfg, itemId, (item) => ({
      viewpointIds: item.viewpointIds.filter((v) => v !== viewpointId),
      pinIds: item.pinIds,
    }));
    applyEdit(set, next);
    return next;
  },

  attachPinToAgendaItem: (itemId, pinId) => {
    const cfg = get().config;
    if (!cfg) return null;
    const next = withAgendaLinks(cfg, itemId, (item) => ({
      viewpointIds: item.viewpointIds,
      pinIds: item.pinIds.includes(pinId) ? item.pinIds : [...item.pinIds, pinId],
    }));
    applyEdit(set, next);
    return next;
  },

  detachPinFromAgendaItem: (itemId, pinId) => {
    const cfg = get().config;
    if (!cfg) return null;
    const next = withAgendaLinks(cfg, itemId, (item) => ({
      viewpointIds: item.viewpointIds,
      pinIds: item.pinIds.filter((p) => p !== pinId),
    }));
    applyEdit(set, next);
    return next;
  },

  reorderRequirements: (fromIdx, toIdx) => {
    const cfg = get().config;
    if (!cfg) return null;
    const requirements = moved(cfg.requirements, fromIdx, toIdx);
    if (requirements === cfg.requirements) return null;
    const next = edited(cfg, { requirements });
    applyEdit(set, next);
    syncMainRequirements(next);
    return next;
  },

  setLabel: (fieldId, value) => {
    const cfg = get().config;
    if (!cfg) return null;
    if (cfg.labels[fieldId] === value) return null;
    const next = edited(cfg, { labels: { ...cfg.labels, [fieldId]: value } });
    applyEdit(set, next);
    return next;
  },

  clearLabel: (fieldId) => {
    const cfg = get().config;
    if (!cfg) return null;
    if (!(fieldId in cfg.labels)) return null;
    const labels = { ...cfg.labels };
    delete labels[fieldId];
    const next = edited(cfg, { labels });
    applyEdit(set, next);
    return next;
  },

  applyCommentEdit: (commentId, patch) => {
    // Pre-review comments have ids like `pre-vp-<viewpointId>` and
    // `pre-pin-<pinId>`. Map the field changes back to the source entity.
    if (commentId.startsWith(PRE_VP_PREFIX)) {
      const viewpointId = commentId.slice(PRE_VP_PREFIX.length);
      const vpPatch: Partial<ReviewViewpoint> = {};
      if (patch.attachedToNodeName !== undefined) vpPatch.label = patch.attachedToNodeName;
      if (patch.content !== undefined) vpPatch.notes = patch.content;
      return get().updateViewpoint(viewpointId, vpPatch);
    }
    if (commentId.startsWith(PRE_PIN_PREFIX)) {
      const pinId = commentId.slice(PRE_PIN_PREFIX.length);
      const pinPatch: Partial<ReviewPin> = {};
      if (patch.attachedToNodeName !== undefined) {
        // Comment label is "Label · PartName" — only the label half is editable.
        const part = patch.attachedToNodeName.split(' · ')[0] ?? patch.attachedToNodeName;
        pinPatch.label = part;
      }
      if (patch.content !== undefined) pinPatch.notes = patch.content;
      return get().updatePin(pinId, pinPatch);
    }
    return null;
  },

  commitPinAsComment: (pinId, author, authorColor) => {
    const cfg = get().config;
    if (!cfg) return null;
    const pin = cfg.pins.find((p) => p.id === pinId);
    if (!pin) return null;
    // Idempotent: a pin that already produced a comment cannot produce another
    // until the first one is deleted (which clears committedCommentId).
    if (pin.committedCommentId) return null;
    const comment = pinToLiveComment(pin, author, authorColor);
    const next: ReviewDraft = {
      ...cfg,
      pins: cfg.pins.map((p) => p.id === pinId ? { ...p, committedCommentId: comment.id } : p),
      updatedAt: Date.now(),
    };
    applyEdit(set, next);
    // The live comment is added to the main store by the caller (alongside
    // broadcastCommentAdd), so every client sees it. We only update the
    // config here — the caller owns the comment side-effect.
    return { comment, config: next };
  },

  clearCommittedCommentId: (commentId) => {
    const cfg = get().config;
    if (!cfg) return null;
    const pin = cfg.pins.find((p) => p.committedCommentId === commentId);
    if (!pin) return null;
    const next: ReviewDraft = {
      ...cfg,
      pins: cfg.pins.map((p) => p.id === pin.id ? { ...p, committedCommentId: undefined } : p),
      updatedAt: Date.now(),
    };
    applyEdit(set, next);
    return next;
  },

  setAgendaIdx: (agendaIdx) => set({ agendaIdx }),

  jumpToSlide: (idx) => {
    const cfg = get().config;
    if (!cfg || cfg.agenda.length === 0) return;
    const safeIdx = Math.max(0, Math.min(cfg.agenda.length - 1, idx));
    set({ agendaIdx: safeIdx });
    // Auto-jump camera to the first attached viewpoint, if any.
    const firstVpId = cfg.agenda[safeIdx].viewpointIds[0];
    if (firstVpId) get().jumpToViewpoint(firstVpId);
  },

  nextSlide: () => {
    const { config, agendaIdx } = get();
    if (!config || config.agenda.length === 0) return;
    get().jumpToSlide((agendaIdx + 1) % config.agenda.length);
  },

  prevSlide: () => {
    const { config, agendaIdx } = get();
    if (!config || config.agenda.length === 0) return;
    get().jumpToSlide((agendaIdx - 1 + config.agenda.length) % config.agenda.length);
  },

  updateAgendaItem: (id, patch) => {
    const cfg = get().config;
    if (!cfg) return null;
    const next: ReviewDraft = {
      ...cfg,
      agenda: cfg.agenda.map((a) => a.id === id ? { ...a, ...patch } : a),
      updatedAt: Date.now(),
    };
    applyEdit(set, next);
    return next;
  },

  addRequirement: (req) => {
    const cfg = get().config;
    if (!cfg) return null;
    const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
    // No invented code: the user found a pre-filled "REQ-3F2A" in every new
    // requirement unwelcome (2026-09-25). The code is only ever displayed, so an
    // empty one is fine and the field shows its placeholder.
    const code = req.code.trim();
    const next: ReviewDraft = {
      ...cfg,
      requirements: [...cfg.requirements, { ...req, id, code }],
      updatedAt: Date.now(),
    };
    applyEdit(set, next);
    syncMainRequirements(next);
    return next;
  },

  updateRequirement: (id, patch) => {
    const cfg = get().config;
    if (!cfg) return null;
    // Taken as typed. It used to fall back to the old code whenever the field was
    // empty, so the box could never be cleared to type a new name (user,
    // 2026-09-25) — and trimming on every keystroke ate the space being typed.
    const next: ReviewDraft = {
      ...cfg,
      requirements: cfg.requirements.map((r) => r.id === id ? { ...r, ...patch } : r),
      updatedAt: Date.now(),
    };
    applyEdit(set, next);
    syncMainRequirements(next);
    return next;
  },

  removeRequirement: (id) => {
    const cfg = get().config;
    if (!cfg) return null;
    const next: ReviewDraft = {
      ...cfg,
      requirements: cfg.requirements.filter((r) => r.id !== id),
      updatedAt: Date.now(),
    };
    applyEdit(set, next);
    syncMainRequirements(next);
    return next;
  },

  addTeamMember: (member) => {
    const cfg = get().config;
    if (!cfg) return null;
    const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
    const next: ReviewDraft = {
      ...cfg,
      team: [...cfg.team, { ...member, id }],
      updatedAt: Date.now(),
    };
    applyEdit(set, next);
    return next;
  },

  updateTeamMember: (id, patch) => {
    const cfg = get().config;
    if (!cfg) return null;
    const next: ReviewDraft = {
      ...cfg,
      team: cfg.team.map((m) => m.id === id ? { ...m, ...patch } : m),
      updatedAt: Date.now(),
    };
    applyEdit(set, next);
    return next;
  },

  removeTeamMember: (id) => {
    const cfg = get().config;
    if (!cfg) return null;
    const next: ReviewDraft = {
      ...cfg,
      team: cfg.team.filter((m) => m.id !== id),
      updatedAt: Date.now(),
    };
    applyEdit(set, next);
    return next;
  },

  reorderTeam: (fromIdx, toIdx) => {
    const cfg = get().config;
    if (!cfg) return null;
    const arr = [...cfg.team];
    if (fromIdx < 0 || fromIdx >= arr.length || toIdx < 0 || toIdx >= arr.length) return cfg;
    const [moved] = arr.splice(fromIdx, 1);
    arr.splice(toIdx, 0, moved);
    const next: ReviewDraft = { ...cfg, team: arr, updatedAt: Date.now() };
    applyEdit(set, next);
    return next;
  },

  setManagerMode: (managerMode) => set({ managerMode }),
  setSessionNotes: (sessionNotes) => set({ sessionNotes }),
}));
