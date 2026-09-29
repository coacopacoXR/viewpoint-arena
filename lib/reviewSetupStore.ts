import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ModelType, Requirement } from '../types';
import type { TeamMember } from './people';
// Type-only, so it is erased at runtime: lib/scene/placement is pure and imports
// nothing from here, and a value import would have made the review's own store
// depend on the scene module that reads it back.
import type { StoredPlacement } from './scene/placement';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReviewViewpoint {
  id: string;
  label: string;
  position: [number, number, number];
  lookAt: [number, number, number];
  thumbnail?: string; // dataUrl
  notes?: string;
  createdAt: number;
}

export type PinSeverity = 'info' | 'concern' | 'blocker';

export interface ReviewPin {
  id: string;
  label: string;
  notes?: string;
  worldPos: [number, number, number];
  modelId?: string | null;
  meshIndex?: string | null;
  partName?: string | null;
  severity: PinSeverity;
  createdAt: number;
  // Set when the pin has been committed as a live SpatialComment in the room.
  // Lives inside the pins jsonb (no new column) so it travels with the review
  // through REVIEW_CONFIG broadcasts. Cleared when the comment is deleted.
  committedCommentId?: string;
}

export interface AgendaItem {
  id: string;
  title: string;
  notes?: string;        // speaker notes written at curation time
  followUp?: string;     // notes added live during the meeting by the manager
  viewpointIds: string[];
  pinIds: string[];
  durationMinutes?: number;
}

/**
 * A slide as it is handed to addAgendaItem.
 *
 * The two link lists are optional because a new slide usually has nothing on it
 * yet, and the store fills in the empty arrays. Named here rather than at either
 * caller because two stores now offer addAgendaItem — this one, and
 * lib/activeReviewStore for the room — and the curation tabs in
 * components/review/ are written against whichever they are handed. One spelling
 * of the argument is what keeps them interchangeable.
 */
export type NewAgendaItem =
  Omit<AgendaItem, 'id' | 'viewpointIds' | 'pinIds'> &
    Partial<Pick<AgendaItem, 'viewpointIds' | 'pinIds'>>;

export interface ReviewAssetReference {
  id: string;
  name: string;
  url?: string;          // external link (spec sheet, prior version)
  // intentionally NOT storing file contents here in v1 — only metadata
}

// Transform applied to whatever model is loaded — lets the curator fix
// scale/orientation issues common to imported CAD (Onshape, uploads).
// Rotation is in radians for direct passthrough to three.js.
export interface ModelTransform {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: number; // uniform scale
}

export const IDENTITY_TRANSFORM: ModelTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: 1,
};

export interface ReviewAsset {
  modelType: ModelType;
  /**
   * The SHA-256 of the imported file, as POST /api/models stored it. This — not
   * the file — is what a curation records, so a review keeps pointing at the
   * same bytes however many times it is opened and however many people open it,
   * and the row stays a few hundred bytes instead of a base64 blob in a jsonb
   * column.
   */
  modelHash?: string;
  /**
   * The name it was imported under. Not cosmetic: utils/modelLoader.ts
   * dispatches on the extension, so a hash alone cannot be parsed.
   */
  importedFileName?: string;
  /**
   * LEGACY, and read-only from here on.
   *
   * A curation saved before models were stored by hash carried the file inline.
   * lib/migrateCurationAsset.ts uploads those bytes once, records `modelHash`
   * and drops this. Nothing writes it any more, and curationsRepo strips it
   * before a row is saved, so the only way it can still arrive is from a
   * browser's own persisted draft — which is exactly the case the migration
   * exists for.
   */
  importedFileBase64?: string;
  references: ReviewAssetReference[];
  transform?: ModelTransform;
  /**
   * Where each of the review's models was left, per revision — the room's Move /
   * Rotate / Scale, kept with the review rather than only in the room server's
   * storage. Absent, or absent for one revision, means that model stands where the
   * scene put it. Batch BI; see lib/scene/placement.ts for why it lives here and
   * not in a column on model_revisions.
   *
   * THE MAIN LINE'S, and only the main line's. Batch BV moved every other line's
   * positions into `linePlacements` below, because this one slot was shared: a
   * variant that moved a model overwrote where the main line had left it, and
   * whichever room re-seeded from the database last won.
   */
  placements?: StoredPlacement[];
  /**
   * Where a VARIANT's models were left, keyed by its review_lines id. Batch BV.
   *
   * Absent for a variant nobody has moved anything in, which is not the same as an
   * empty list: a variant with no slot of its own opens on the main line's
   * `placements`, because "a variant starts where the main line is" is what starting
   * one means, and it diverges into its own slot the first time somebody drags
   * anything in it. lib/scene/placement.placementsForLine is the one reader of that
   * rule and lib/scene/keepPlacements the one writer.
   *
   * Kept when the variant is adopted or dropped: an adoption copies the slot into
   * `placements` (docs/supabase-schema.sql, `adopt_review_line`) and a drop leaves it
   * as the record of where the answer the review did not take had got to.
   */
  linePlacements?: Record<string, StoredPlacement[]>;
}

export interface ReviewDraft {
  reviewId: string;
  title: string;
  description: string;
  asset: ReviewAsset;
  viewpoints: ReviewViewpoint[];
  pins: ReviewPin[];
  agenda: AgendaItem[];
  requirements: Requirement[];
  team: TeamMember[];
  labels: Record<string, string>;
  listed: boolean;
  createdAt: number;
  updatedAt: number;
}


// ─── Store ────────────────────────────────────────────────────────────────────

interface ReviewSetupState {
  draft: ReviewDraft | null;

  // Lifecycle
  startNewDraft: (reviewId: string) => void;
  loadDraft: (reviewId: string) => boolean; // returns true if a draft was loaded
  hydrateDraft: (draft: ReviewDraft) => void; // adopt a remote/loaded draft
  discardDraft: () => void;

  // Title / description / visibility
  setTitle: (title: string) => void;
  setDescription: (desc: string) => void;
  setListed: (listed: boolean) => void;

  // Asset
  setModelType: (modelType: ModelType) => void;
  /**
   * Record an uploaded model by its content address. The file itself is already
   * on the server (lib/modelsClient.ts uploadModelFile) by the time this is
   * called; what a curation keeps is the hash and the name it was picked under.
   */
  setImportedFile: (fileName: string, modelHash: string) => void;
  clearImportedFile: () => void;
  addReference: (ref: Omit<ReviewAssetReference, 'id'>) => void;
  removeReference: (id: string) => void;
  setAssetTransform: (patch: Partial<ModelTransform>) => void;
  resetAssetTransform: () => void;

  // Viewpoints
  addViewpoint: (vp: Omit<ReviewViewpoint, 'id' | 'createdAt'>) => string; // returns id
  updateViewpoint: (id: string, patch: Partial<ReviewViewpoint>) => void;
  removeViewpoint: (id: string) => void;

  // Pins
  addPin: (pin: Omit<ReviewPin, 'id' | 'createdAt'>) => string;
  updatePin: (id: string, patch: Partial<ReviewPin>) => void;
  removePin: (id: string) => void;

  // Agenda
  addAgendaItem: (item: Omit<AgendaItem, 'id' | 'viewpointIds' | 'pinIds'> & Partial<Pick<AgendaItem, 'viewpointIds' | 'pinIds'>>) => string;
  updateAgendaItem: (id: string, patch: Partial<AgendaItem>) => void;
  removeAgendaItem: (id: string) => void;
  reorderAgenda: (fromIdx: number, toIdx: number) => void;
  attachViewpointToAgendaItem: (itemId: string, viewpointId: string) => void;
  detachViewpointFromAgendaItem: (itemId: string, viewpointId: string) => void;
  attachPinToAgendaItem: (itemId: string, pinId: string) => void;
  detachPinFromAgendaItem: (itemId: string, pinId: string) => void;

  // Requirements
  addRequirement: (req: Omit<Requirement, 'id'>) => string;
  updateRequirement: (id: string, patch: Partial<Requirement>) => void;
  removeRequirement: (id: string) => void;
  reorderRequirements: (fromIdx: number, toIdx: number) => void;


  // Team (people roster)
  addTeamMember: (member: Omit<TeamMember, 'id'>) => string;
  updateTeamMember: (id: string, patch: Partial<TeamMember>) => void;
  removeTeamMember: (id: string) => void;
  reorderTeam: (fromIdx: number, toIdx: number) => void;

  // Labels (user-defined grouping values)
  setLabel: (fieldId: string, value: string) => void;
  clearLabel: (fieldId: string) => void;
}

const uid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
  ? crypto.randomUUID()
  : Math.random().toString(36).slice(2);

/** The title a brand-new design review gets before anybody names it. */
export const NEW_REVIEW_TITLE = 'Untitled design review';

/**
 * How long a design review's name may be.
 *
 * It is read on a lobby card, in a room's top-left corner and in a tracker row, so
 * the limit is what those three can show rather than what a column can hold:
 * review_curations.title is text. 120 is long enough for "Door hinge, rev C —
 * supplier change after the tooling quote" and short enough that a card truncates
 * rather than wraps into its neighbours.
 */
export const MAX_REVIEW_TITLE = 120;

/**
 * A name somebody typed, as the review stores it.
 *
 * Trimmed and capped. An empty answer keeps `current` rather than un-naming the
 * review: naming is an edit like any other, and pressing Enter in a field nobody
 * filled in is not a decision to call the review nothing.
 */
export function reviewTitleFrom(raw: string, current: string): string {
  const wanted = raw.trim().slice(0, MAX_REVIEW_TITLE);
  return wanted === '' ? current : wanted;
}

/**
 * A draft for a review that does not exist yet.
 *
 * Exported (rather than staying the private `emptyDraft` below) because batch BH
 * moved the moment a review is born: the lobby's "New design review" creates the
 * row and opens the ROOM with Edit on, so the shape of a new review has to be
 * reachable from outside this store. One factory, so a review created from the
 * lobby and a draft started by the setup page cannot disagree about defaults.
 */
export function createReviewDraft(reviewId: string, title: string = NEW_REVIEW_TITLE): ReviewDraft {
  return {
    reviewId,
    title,
    description: '',
    asset: {
      // No model, rather than one of the samples: a review is about somebody's
      // product, and opening every one of them on a pair of headphones meant the
      // room was showing a product nobody had chosen (batch BI). The samples are
      // still one click away, in the room and in the model tree.
      modelType: 'none',
      references: [],
    },
    viewpoints: [],
    pins: [],
    agenda: [],
    requirements: [],
    team: [],
    labels: {},
    listed: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

const emptyDraft = (reviewId: string): ReviewDraft => createReviewDraft(reviewId, 'Untitled Review');

const touch = (draft: ReviewDraft): ReviewDraft => ({ ...draft, updatedAt: Date.now() });

export const useReviewSetupStore = create<ReviewSetupState>()(
  persist(
    (set, get) => ({
      draft: null,

      startNewDraft: (reviewId) => set({ draft: emptyDraft(reviewId) }),

      loadDraft: (reviewId) => {
        const current = get().draft;
        if (current && current.reviewId === reviewId) return true;
        // No draft cached for this id — caller should call startNewDraft.
        return false;
      },

      // Adopt a draft loaded from the cloud. A cloud row carries `modelHash`,
      // which is small enough that curationsRepo saves it, so there is normally
      // nothing to preserve.
      //
      // The fallback below is for one specific case: a browser whose OWN
      // persisted draft still holds the legacy inline base64, meeting a cloud
      // row that has no model in it at all — because curationsRepo stripped the
      // blob before saving it, so every row written before the migration has
      // neither a hash nor bytes. Dropping the local copy there would lose the
      // curator's model on their next page load; keeping it is what lets
      // lib/migrateCurationAsset.ts upload those bytes once and replace them
      // with a hash.
      hydrateDraft: (incoming) => set((s) => {
        const local = s.draft && s.draft.reviewId === incoming.reviewId ? s.draft : null;
        const preservedAsset = local?.asset.importedFileBase64 && !incoming.asset.modelHash
          ? { ...incoming.asset, importedFileBase64: local.asset.importedFileBase64, importedFileName: local.asset.importedFileName }
          : incoming.asset;
        return { draft: { ...incoming, asset: preservedAsset } };
      }),

      discardDraft: () => set({ draft: null }),

      setTitle: (title) => set((s) => s.draft ? { draft: touch({ ...s.draft, title }) } : s),
      setDescription: (description) => set((s) => s.draft ? { draft: touch({ ...s.draft, description }) } : s),
      setListed: (listed) => set((s) => s.draft ? { draft: touch({ ...s.draft, listed }) } : s),

      setModelType: (modelType) => set((s) => {
        if (!s.draft) return s;
        const next: ReviewDraft = {
          ...s.draft,
          asset: { ...s.draft.asset, modelType },
        };
        return { draft: touch(next) };
      }),

      setImportedFile: (importedFileName, modelHash) => set((s) => {
        if (!s.draft) return s;
        // Any legacy inline copy goes at the same moment the hash arrives. The
        // two must never both be present: a later reader could not tell which
        // one described the model on screen, and the base64 one is the copy
        // that would be saved into a jsonb column.
        const { importedFileBase64: _legacy, ...asset } = s.draft.asset;
        const next: ReviewDraft = {
          ...s.draft,
          asset: {
            ...asset,
            modelType: 'imported',
            importedFileName,
            modelHash,
          },
        };
        return { draft: touch(next) };
      }),

      clearImportedFile: () => set((s) => {
        if (!s.draft) return s;
        const next: ReviewDraft = {
          ...s.draft,
          asset: {
            // Back to no model, not back to a sample: removing the file somebody
            // uploaded leaves the review with nothing on screen, which is what it
            // started with (batch BI).
            modelType: s.draft.asset.modelType === 'imported' ? 'none' : s.draft.asset.modelType,
            references: s.draft.asset.references,
          },
        };
        return { draft: touch(next) };
      }),

      addReference: (ref) => set((s) => {
        if (!s.draft) return s;
        const next: ReviewDraft = {
          ...s.draft,
          asset: {
            ...s.draft.asset,
            references: [...s.draft.asset.references, { id: uid(), ...ref }],
          },
        };
        return { draft: touch(next) };
      }),

      removeReference: (id) => set((s) => {
        if (!s.draft) return s;
        const next: ReviewDraft = {
          ...s.draft,
          asset: {
            ...s.draft.asset,
            references: s.draft.asset.references.filter((r) => r.id !== id),
          },
        };
        return { draft: touch(next) };
      }),

      setAssetTransform: (patch) => set((s) => {
        if (!s.draft) return s;
        const current = s.draft.asset.transform ?? IDENTITY_TRANSFORM;
        const next: ReviewDraft = {
          ...s.draft,
          asset: {
            ...s.draft.asset,
            transform: { ...current, ...patch },
          },
        };
        return { draft: touch(next) };
      }),

      resetAssetTransform: () => set((s) => {
        if (!s.draft) return s;
        const next: ReviewDraft = {
          ...s.draft,
          asset: { ...s.draft.asset, transform: IDENTITY_TRANSFORM },
        };
        return { draft: touch(next) };
      }),

      addViewpoint: (vp) => {
        const id = uid();
        set((s) => {
          if (!s.draft) return s;
          const next: ReviewDraft = {
            ...s.draft,
            viewpoints: [...s.draft.viewpoints, { id, createdAt: Date.now(), ...vp }],
          };
          return { draft: touch(next) };
        });
        return id;
      },

      updateViewpoint: (id, patch) => set((s) => {
        if (!s.draft) return s;
        const next: ReviewDraft = {
          ...s.draft,
          viewpoints: s.draft.viewpoints.map((v) => v.id === id ? { ...v, ...patch } : v),
        };
        return { draft: touch(next) };
      }),

      removeViewpoint: (id) => set((s) => {
        if (!s.draft) return s;
        const next: ReviewDraft = {
          ...s.draft,
          viewpoints: s.draft.viewpoints.filter((v) => v.id !== id),
          // Cascade: drop the viewpoint reference from every slide that linked it.
          agenda: s.draft.agenda.map((a) => ({
            ...a,
            viewpointIds: a.viewpointIds.filter((vid) => vid !== id),
          })),
        };
        return { draft: touch(next) };
      }),

      addPin: (pin) => {
        const id = uid();
        set((s) => {
          if (!s.draft) return s;
          const next: ReviewDraft = {
            ...s.draft,
            pins: [...s.draft.pins, { id, createdAt: Date.now(), ...pin }],
          };
          return { draft: touch(next) };
        });
        return id;
      },

      updatePin: (id, patch) => set((s) => {
        if (!s.draft) return s;
        const next: ReviewDraft = {
          ...s.draft,
          pins: s.draft.pins.map((p) => p.id === id ? { ...p, ...patch } : p),
        };
        return { draft: touch(next) };
      }),

      removePin: (id) => set((s) => {
        if (!s.draft) return s;
        const next: ReviewDraft = {
          ...s.draft,
          pins: s.draft.pins.filter((p) => p.id !== id),
          agenda: s.draft.agenda.map((a) => ({
            ...a,
            pinIds: a.pinIds.filter((pid) => pid !== id),
          })),
        };
        return { draft: touch(next) };
      }),

      addAgendaItem: (item) => {
        const id = uid();
        set((s) => {
          if (!s.draft) return s;
          const next: ReviewDraft = {
            ...s.draft,
            agenda: [
              ...s.draft.agenda,
              { id, viewpointIds: [], pinIds: [], ...item },
            ],
          };
          return { draft: touch(next) };
        });
        return id;
      },

      updateAgendaItem: (id, patch) => set((s) => {
        if (!s.draft) return s;
        const next: ReviewDraft = {
          ...s.draft,
          agenda: s.draft.agenda.map((a) => a.id === id ? { ...a, ...patch } : a),
        };
        return { draft: touch(next) };
      }),

      removeAgendaItem: (id) => set((s) => {
        if (!s.draft) return s;
        const next: ReviewDraft = {
          ...s.draft,
          agenda: s.draft.agenda.filter((a) => a.id !== id),
        };
        return { draft: touch(next) };
      }),

      reorderAgenda: (fromIdx, toIdx) => set((s) => {
        if (!s.draft) return s;
        const arr = [...s.draft.agenda];
        if (fromIdx < 0 || fromIdx >= arr.length || toIdx < 0 || toIdx >= arr.length) return s;
        const [moved] = arr.splice(fromIdx, 1);
        arr.splice(toIdx, 0, moved);
        return { draft: touch({ ...s.draft, agenda: arr }) };
      }),

      attachViewpointToAgendaItem: (itemId, viewpointId) => set((s) => {
        if (!s.draft) return s;
        const next: ReviewDraft = {
          ...s.draft,
          agenda: s.draft.agenda.map((a) =>
            a.id === itemId && !a.viewpointIds.includes(viewpointId)
              ? { ...a, viewpointIds: [...a.viewpointIds, viewpointId] }
              : a,
          ),
        };
        return { draft: touch(next) };
      }),

      detachViewpointFromAgendaItem: (itemId, viewpointId) => set((s) => {
        if (!s.draft) return s;
        const next: ReviewDraft = {
          ...s.draft,
          agenda: s.draft.agenda.map((a) =>
            a.id === itemId
              ? { ...a, viewpointIds: a.viewpointIds.filter((id) => id !== viewpointId) }
              : a,
          ),
        };
        return { draft: touch(next) };
      }),

      attachPinToAgendaItem: (itemId, pinId) => set((s) => {
        if (!s.draft) return s;
        const next: ReviewDraft = {
          ...s.draft,
          agenda: s.draft.agenda.map((a) =>
            a.id === itemId && !a.pinIds.includes(pinId)
              ? { ...a, pinIds: [...a.pinIds, pinId] }
              : a,
          ),
        };
        return { draft: touch(next) };
      }),

      detachPinFromAgendaItem: (itemId, pinId) => set((s) => {
        if (!s.draft) return s;
        const next: ReviewDraft = {
          ...s.draft,
          agenda: s.draft.agenda.map((a) =>
            a.id === itemId
              ? { ...a, pinIds: a.pinIds.filter((id) => id !== pinId) }
              : a,
          ),
        };
        return { draft: touch(next) };
      }),

      addRequirement: (req) => {
        const id = uid();
        // No invented code. A blank one stays blank: naming is the user's
        // job, and "REQ-A1B2" pretending to be their scheme is worse than
        // an empty field (user, 2026-09-23).
        const code = req.code.trim();
        set((s) => {
          if (!s.draft) return s;
          const next: ReviewDraft = {
            ...s.draft,
            requirements: [...s.draft.requirements, { ...req, id, code }],
          };
          return { draft: touch(next) };
        });
        return id;
      },

      updateRequirement: (id, patch) => set((s) => {
        if (!s.draft) return s;
        const cleaned = patch; // taken as typed — see lib/activeReviewStore updateRequirement
        const next: ReviewDraft = {
          ...s.draft,
          requirements: s.draft.requirements.map((r) => r.id === id ? { ...r, ...cleaned } : r),
        };
        return { draft: touch(next) };
      }),

      removeRequirement: (id) => set((s) => {
        if (!s.draft) return s;
        const next: ReviewDraft = {
          ...s.draft,
          requirements: s.draft.requirements.filter((r) => r.id !== id),
        };
        return { draft: touch(next) };
      }),

      reorderRequirements: (fromIdx, toIdx) => set((s) => {
        if (!s.draft) return s;
        const arr = [...s.draft.requirements];
        if (fromIdx < 0 || fromIdx >= arr.length || toIdx < 0 || toIdx >= arr.length) return s;
        const [moved] = arr.splice(fromIdx, 1);
        arr.splice(toIdx, 0, moved);
        return { draft: touch({ ...s.draft, requirements: arr }) };
      }),


      addTeamMember: (member) => {
        const id = uid();
        set((s) => {
          if (!s.draft) return s;
          const next: ReviewDraft = {
            ...s.draft,
            team: [...s.draft.team, { ...member, id }],
          };
          return { draft: touch(next) };
        });
        return id;
      },

      updateTeamMember: (id, patch) => set((s) => {
        if (!s.draft) return s;
        const next: ReviewDraft = {
          ...s.draft,
          team: s.draft.team.map((m) => m.id === id ? { ...m, ...patch } : m),
        };
        return { draft: touch(next) };
      }),

      removeTeamMember: (id) => set((s) => {
        if (!s.draft) return s;
        const next: ReviewDraft = {
          ...s.draft,
          team: s.draft.team.filter((m) => m.id !== id),
        };
        return { draft: touch(next) };
      }),

      reorderTeam: (fromIdx, toIdx) => set((s) => {
        if (!s.draft) return s;
        const arr = [...s.draft.team];
        if (fromIdx < 0 || fromIdx >= arr.length || toIdx < 0 || toIdx >= arr.length) return s;
        const [moved] = arr.splice(fromIdx, 1);
        arr.splice(toIdx, 0, moved);
        return { draft: touch({ ...s.draft, team: arr }) };
      }),

      setLabel: (fieldId, value) => set((s) => {
        if (!s.draft) return s;
        const next: ReviewDraft = {
          ...s.draft,
          labels: { ...s.draft.labels, [fieldId]: value },
        };
        return { draft: touch(next) };
      }),

      clearLabel: (fieldId) => set((s) => {
        if (!s.draft) return s;
        const { [fieldId]: _removed, ...rest } = s.draft.labels;
        const next: ReviewDraft = { ...s.draft, labels: rest };
        return { draft: touch(next) };
      }),
    }),
    {
      name: 'vp_review_draft',
      version: 1,
      // v0 → v1: agenda items moved from { refType, refId } to { viewpointIds, pinIds }.
      // Old single-ref items become slides with that one item attached.
      migrate: (persisted: unknown, fromVersion: number) => {
        if (!persisted || typeof persisted !== 'object') return persisted;
        const p = persisted as Record<string, unknown>;
        if (!p.draft || typeof p.draft !== 'object') return persisted;
        let draft = p.draft as Record<string, unknown>;
        if (fromVersion < 1) {
          const agenda = ((draft.agenda as unknown[]) ?? []).map((raw) => {
            const r = (raw ?? {}) as Record<string, unknown>;
            if (Array.isArray(r?.viewpointIds) && Array.isArray(r?.pinIds)) return r;
            const viewpointIds = r?.refType === 'viewpoint' && r?.refId ? [r.refId] : [];
            const pinIds = r?.refType === 'pin' && r?.refId ? [r.refId] : [];
            const { refType: _rt, refId: _ri, ...rest } = r;
            return { ...rest, viewpointIds, pinIds };
          });
          draft = { ...draft, agenda };
        }
        if (!Array.isArray(draft.requirements)) {
          draft = { ...draft, requirements: [] };
        }
        if (!Array.isArray(draft.team)) {
          draft = { ...draft, team: [] };
        }
        if (!draft.labels || typeof draft.labels !== 'object') {
          draft = { ...draft, labels: {} };
        }
        if (typeof draft.listed !== 'boolean') {
          draft = { ...draft, listed: true };
        }
        return { ...p, draft };
      },
    },
  ),
);
