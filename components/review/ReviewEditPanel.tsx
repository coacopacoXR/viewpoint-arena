// The room's Edit panel: the curation tabs, in the side panel where Capture ·
// Comments · Chat usually is.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH. This is what "prepare the review
// inside its room" looks like once the separate curate page is gone — the same
// tabs, the same components, rendering against the review the room is holding
// rather than against a draft only this browser had.
//
// Two deliberate choices:
//
//   • DARK, unlike the panel it replaces. The tabs were written for the curate
//     page's #111 sidebar and are one copy, not two re-themed ones; giving the
//     Edit panel the same surface is cheaper than a theme prop on six components,
//     and it makes "the meeting is paused, you are editing" obvious at a glance
//     from anywhere in the room. The amber strip above says the same thing in
//     words.
//   • The tab order is Agenda · Views · Pins · Requirements · Labels · People,
//     which is the order the user approved in the sketch and NOT the curate page's
//     (Asset first). The Asset tab has no equivalent here: its model picker is the
//     model tree's job, its transform is the amber strip's, and its "+ Revision"
//     is BB's import flow.
//
// There is no Asset tab and no People tab on a deployment without accounts.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Camera, ListOrdered, MapPin, Pencil, Scale, Tags, Trash2, Users, X } from 'lucide-react';
import { clsx } from 'clsx';
import { useStore } from '../../store';
import { useActiveReviewStore } from '../../lib/activeReviewStore';
import { usePresence } from '../../lib/PresenceContext';
import { identityRequired, publicIdentityOf } from '../../lib/auth/authRules';
import { useConnectorConfig } from '../../lib/config/ConfigContext';
import { createReview, loadCuration } from '../../lib/curationsRepo';
import { deleteReview } from '../../lib/reviews/deleteClient';
import { resetLineCache } from '../../lib/reviews/linesRepo';
import { MAX_REVIEW_TITLE, type ReviewDraft } from '../../lib/reviewSetupStore';
import { AgendaTab } from './AgendaTab';
import { LabelsTab } from './LabelsTab';
import PeopleTab from './PeopleTab';
import { PinsTab } from './PinsTab';
import { RequirementsTab } from './RequirementsTab';
import { ViewsTab } from './ViewsTab';
import { useActiveReviewActions } from './useActiveReviewActions';

type EditTabId = 'agenda' | 'views' | 'pins' | 'requirements' | 'labels' | 'people';

/**
 * The label a pin dropped in the room starts with.
 *
 * A placeholder to rename, in the row's own label box. Empty would have worked —
 * pinToLiveComment falls back to 'Pinned comment' — but a blank input in a list of
 * named pins reads as a pin that failed to load rather than one to name.
 */
const NEW_PIN_LABEL = 'New pin';

/**
 * The tabs, in the order they are shown.
 *
 * `accountsOnly` is what makes the People tab disappear on the default install
 * rather than appear and fail: with identity.mode 'none' there are no accounts, so
 * there is no roster to list and no email address that could resolve to one.
 */
const TABS: Array<{ id: EditTabId; label: string; ariaLabel: string; icon: React.ReactNode; accountsOnly?: boolean }> = [
  { id: 'agenda',       label: 'Agenda', ariaLabel: 'Agenda',       icon: <ListOrdered size={12} /> },
  { id: 'views',        label: 'Views',  ariaLabel: 'Viewpoints',   icon: <Camera size={12} /> },
  { id: 'pins',         label: 'Pins',   ariaLabel: 'Pins',         icon: <MapPin size={12} /> },
  { id: 'requirements', label: 'Reqs',   ariaLabel: 'Requirements', icon: <Scale size={12} /> },
  { id: 'labels',       label: 'Labels', ariaLabel: 'Labels',       icon: <Tags size={12} /> },
  { id: 'people',       label: 'People', ariaLabel: 'People',       icon: <Users size={12} />, accountsOnly: true },
];

/**
 * "Delete design review" — the owner's and this install's administrators', and NOT
 * its editors' (`deleteReview` in lib/reviews/roles.ts).
 *
 * An inline confirm in the same panel that offered the action, naming the review,
 * because a delete that does not say what it is about to remove is a delete that
 * gets pressed by accident. Deliberately NOT window.confirm: it cannot be styled to
 * the panel it belongs to, it cannot be tested, and it freezes the room behind it
 * while it waits.
 *
 * What goes is the whole review — its meetings, the cards raised in them, its lines,
 * its roster and its stored revisions — in one transaction, through
 * api/reviews/delete.ts. Stored model FILES stay, because they are content-addressed
 * and another review may be showing the same bytes.
 */
const DeleteReviewRow: React.FC<{ reviewId: string; title: string }> = ({ reviewId, title }) => {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const name = title.trim() || 'this design review';

  const run = async () => {
    setBusy(true);
    setError(null);
    const result = await deleteReview(reviewId);
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? 'That could not be deleted.');
      return;
    }
    // The review's lines are gone, and every reader — the map, the tracker's line
    // filter, a room's own chip — resolves through the cache that still holds them.
    resetLineCache();
    // Out of the room. RoomPage's unmount clears the config, the review id and the
    // line, so nothing of this review leaks into the next room this browser opens.
    navigate('/');
  };

  if (!confirming) {
    return (
      <div className="shrink-0 rounded-lg border border-white/10 bg-[#111] p-1.5">
        <button
          onClick={() => { setConfirming(true); setError(null); }}
          className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-[10px] font-bold uppercase tracking-wide text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
        >
          <Trash2 size={12} />
          Delete design review
        </button>
        {error && <p className="px-2 pt-1 text-[10px] text-red-400 leading-snug" role="status">{error}</p>}
      </div>
    );
  }

  return (
    <div
      className="shrink-0 rounded-lg border border-red-500/30 bg-red-500/5 p-3 flex flex-col gap-2"
      data-testid="delete-review"
    >
      <p className="text-[11px] text-gray-300 leading-snug">
        Delete “{name}” and everything in it — its sessions, its cards and its stored
        models? This cannot be undone.
      </p>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => void run()}
          disabled={busy}
          className="px-3 py-1.5 rounded bg-red-600 text-white text-[10px] font-bold uppercase tracking-wide hover:bg-red-700 transition-colors disabled:opacity-40"
        >
          {busy ? 'Deleting…' : 'Delete'}
        </button>
        <button
          onClick={() => setConfirming(false)}
          disabled={busy}
          className="px-3 py-1.5 rounded border border-white/15 text-gray-400 text-[10px] font-bold uppercase tracking-wide hover:text-white transition-colors disabled:opacity-40"
        >
          Cancel
        </button>
      </div>
      {error && <p className="text-[10px] text-red-400 leading-snug" role="status">{error}</p>}
    </div>
  );
};

/**
 * The review's name, as the first thing in the panel that edits it.
 *
 * Batch BQ. Until now nothing anywhere wrote `review_curations.title`, so every
 * review was "Untitled design review" and the only way to tell two of them apart in
 * the lobby was the model behind them. The name sits ABOVE the tabs rather than
 * among them because it is not a section of the review, it is what the review is
 * called, and a tab called "Name" would be the sixth of six things to look in.
 *
 * Inline rather than a dialog for the reason the panel's delete gives: it cannot be
 * styled to the panel that offered it, and it freezes the room behind it.
 *
 * WHO MAY. Not gated here, deliberately: this panel is rendered only while the room
 * server has granted THIS browser the review's Edit, which is
 * `can(role, 'editReview')` — the owner and the editors, and on a deployment with no
 * accounts the meeting host. A second check would be a second copy of a rule that
 * lib/reviews/roles.ts already answers.
 *
 * The write goes through the same `actions` as every other field in this panel, so
 * it is marked as this browser's edit (batch BH3), saved by RoomPage's subscriber and
 * broadcast as REVIEW_CONFIG: everybody in the room gets the new name, including the
 * one shown in the room's own top-left corner.
 */
const ReviewTitleRow: React.FC<{ title: string; onRename: (next: string) => void }> = ({ title, onRename }) => {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);

  const open = () => { setValue(title); setEditing(true); };
  const close = () => setEditing(false);
  const save = () => {
    setEditing(false);
    // An empty field keeps the name the review had, which is the store's rule
    // (lib/reviewSetupStore.reviewTitleFrom) and not this component's: the same
    // answer has to hold for the lobby's rename and for a room's.
    onRename(value);
  };

  return (
    <div className="shrink-0 rounded-lg border border-white/10 bg-[#111] px-2.5 py-2" data-testid="review-title-row">
      <p className="font-mono text-[9px] font-bold text-gray-500 uppercase tracking-widest mb-1">
        Design review
      </p>
      {editing ? (
        <div className="flex items-center gap-1.5">
          <input
            value={value}
            autoFocus
            maxLength={MAX_REVIEW_TITLE}
            aria-label="Name this design review"
            data-testid="review-title-field"
            placeholder="e.g. Door hinge, rev C"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save();
              if (event.key === 'Escape') close();
            }}
            className="flex-1 min-w-0 rounded border border-white/20 bg-black/40 px-2 py-1 text-[12px] text-gray-100 outline-none focus:border-white/50"
          />
          <button
            onClick={save}
            data-testid="review-title-save"
            className="shrink-0 px-2 py-1 rounded bg-white text-black text-[10px] font-bold uppercase tracking-wide hover:bg-gray-200 transition-colors"
          >
            Save
          </button>
          <button
            onClick={close}
            title="Cancel"
            aria-label="Cancel"
            className="shrink-0 px-1.5 py-1 rounded border border-white/15 text-gray-400 hover:text-white transition-colors"
          >
            <X size={12} />
          </button>
        </div>
      ) : (
        <button
          onClick={open}
          data-testid="review-title-edit"
          title="Rename this design review"
          className="w-full flex items-center gap-1.5 text-left group"
        >
          <span className="flex-1 min-w-0 truncate text-[13px] font-semibold text-gray-100">{title}</span>
          <Pencil size={12} className="shrink-0 text-gray-600 group-hover:text-gray-300 transition-colors" />
        </button>
      )}
    </div>
  );
};

const ReviewEditPanel: React.FC<{
  reviewId: string;
  /** Called after a People write, so the room can re-read its own role. */
  onRosterChanged?: () => void;
  /**
   * Whether "Delete design review" belongs on the panel at all.
   *
   * Decided by the room, not here: lib/reviews/roles.ts says `deleteReview` is the
   * owner's and this install's admins', and NOT its editors' — so the person who may
   * change the review is not automatically the person who may unmake it. Hiding it
   * is not the enforcement (api/reviews/delete.ts checks the caller's own token
   * against the roster); it is the panel not offering a tool that would be refused.
   */
  mayDeleteReview?: boolean;
}> = ({ reviewId, onRosterChanged, mayDeleteReview = false }) => {
  const config = useActiveReviewStore((s) => s.config);
  const jumpToViewpoint = useActiveReviewStore((s) => s.jumpToViewpoint);
  const actions = useActiveReviewActions();
  const { config: connectorConfig } = useConnectorConfig();

  // ─── Edit always has a review to edit (batch BN) ────────────────────────────
  // A room opened from the lobby's "New session" had no review_curations row, and an
  // admin — or, on an install with no accounts, the meeting host — still got the Edit
  // button, because `can(role, 'editReview')` is about the PERSON and not about
  // whether a row exists. The panel then said "This room has no design review to edit
  // yet" and stopped there: views and pins could not be saved, and a participant in
  // the same room was told "Import locked" because nobody owned it.
  //
  // So the row is created here, the way pages/RoomPage.tsx creates it for a PLM
  // launch: `createReview(roomId)`, which also claims the owner on a deployment with
  // accounts — and owning it is what makes the review importable and what makes the
  // Edit this person was just granted mean something. Then the room is seeded from the
  // result and everybody else in it is told, which is RoomPage's own `seed` path.
  //
  // WHY HERE AND NOT IN RoomPage. This panel is only mounted while THIS person has
  // Edit, which the room server granted — so "the panel is open and there is no
  // review" is exactly the condition to fix, and fixing it here cannot create a row
  // for a room nobody is editing.
  const [ensure, setEnsure] = useState<'idle' | 'setting-up' | 'failed'>('idle');
  // Bumped by Retry: `ensure` itself cannot be a dependency, because setting it to
  // 'setting-up' would cancel the run that just set it.
  const [attempt, setAttempt] = useState(0);
  const ensuringRef = useRef(false);
  const stopBroadcastRef = useRef<(() => void) | undefined>(undefined);
  // Read through a ref and never listed as a dependency: usePartyPresence builds a
  // fresh object on every render, so listing it would re-run the effect below on
  // every render of the room. See lib/usePartyPresence.ts.
  const { broadcastReviewConfig } = usePresence();
  const broadcastRef = useRef(broadcastReviewConfig);
  useEffect(() => {
    broadcastRef.current = broadcastReviewConfig;
  });
  useEffect(() => () => stopBroadcastRef.current?.(), []);

  /**
   * Tell the rest of the room about a review this screen just brought into being.
   *
   * Retried for a few seconds rather than sent once, the way pages/RoomPage.tsx does
   * it: Edit is normally granted over an open socket, so the first attempt lands, but
   * a send that silently did not go would leave this screen holding a review nobody
   * else in the room can see.
   */
  const broadcastWhenReady = useCallback((draft: ReviewDraft) => {
    stopBroadcastRef.current?.();
    stopBroadcastRef.current = undefined;
    if (broadcastRef.current(draft)) return;
    const interval = setInterval(() => {
      if (broadcastRef.current(draft)) clearInterval(interval);
    }, 250);
    const timeout = setTimeout(() => clearInterval(interval), 5000);
    stopBroadcastRef.current = () => { clearInterval(interval); clearTimeout(timeout); };
  }, []);

  useEffect(() => {
    if (config !== null || ensuringRef.current) return;
    ensuringRef.current = true;
    setEnsure('setting-up');
    let cancelled = false;
    void (async () => {
      // READ BEFORE CREATING. RoomPage's own read of this row may still be in
      // flight, and `createReview` upserts: writing an empty draft over a row that
      // does exist would empty a review somebody else has already saved into, which
      // is batch BH3's bug arriving by a new door.
      const existing = await loadCuration(reviewId);
      if (cancelled) return;
      const draft = existing ?? (await createReview(reviewId));
      if (cancelled) return;
      if (!draft) {
        ensuringRef.current = false;
        setEnsure('failed');
        return;
      }
      // Seeding is not editing. `setConfig` forgets the local-edit mark before it
      // writes, so RoomPage's save-on-edit subscriber does not upsert the row back
      // over the one just created.
      useActiveReviewStore.getState().setConfig(draft);
      // This room is holding a design review now, so the meeting that ends here is
      // recorded against it — the same two writes RoomPage's `seed` makes.
      useStore.getState().setActiveReviewId(reviewId);
      broadcastWhenReady(draft);
    })();
    return () => {
      cancelled = true;
      ensuringRef.current = false;
    };
  }, [config, reviewId, attempt, broadcastWhenReady]);

  const accountsOn = useMemo(
    () => identityRequired(publicIdentityOf(connectorConfig)),
    [connectorConfig],
  );
  const tabs = useMemo(
    () => TABS.filter((tab) => accountsOn || !tab.accountsOnly),
    [accountsOn],
  );

  const [tab, setTab] = useState<EditTabId>('agenda');
  // Which pin's notes are open. Local to the panel and not to the review: it is
  // where this person's eye is, not a fact anybody else needs.
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);

  // ─── Placing a pin (batch BI) ───────────────────────────────────────────────
  // The click belongs to the room's ONE raycast, inside the canvas
  // (components/Scene/SpatialComments, in its 'placing-pin' mode), and it answers
  // through the main store's pending triple: a point, the node id under it, and
  // that node's name. Turning the three into a review pin happens here, because a
  // pin is a fact about the REVIEW — so it goes through `actions`, which marks the
  // edit, broadcasts it to the room and lets RoomPage's subscriber save it (batch
  // BH3). Two stores and one click, and neither grows a second raycast that could
  // resolve a part name differently from the first.
  const commentMode = useStore((s) => s.commentMode);
  const setCommentMode = useStore((s) => s.setCommentMode);
  const setPendingComment = useStore((s) => s.setPendingComment);
  const pendingPoint = useStore((s) => s.pendingCommentPosition);
  const pendingNodeId = useStore((s) => s.pendingCommentNodeId);
  const pendingNodeName = useStore((s) => s.pendingCommentNodeName);
  const pinDropActive = commentMode === 'placing-pin';

  const cancelPinMode = () => {
    setCommentMode('none');
    setPendingComment(null, null, null);
  };

  useEffect(() => {
    if (!pinDropActive || !pendingPoint) return;
    actions.addPin({
      label: NEW_PIN_LABEL,
      worldPos: [pendingPoint.x, pendingPoint.y, pendingPoint.z],
      modelId: null,
      meshIndex: pendingNodeId,
      partName: pendingNodeName,
      severity: 'info',
    });
    // Open the pin just added, so its notes are showing and the new row is the one
    // the eye lands on rather than one to hunt for in a list. Read back from the
    // store rather than returned by the write: every ReviewDraftActions write
    // answers void, and addPin appends, so the last pin is the new one.
    const pins = useActiveReviewStore.getState().config?.pins ?? [];
    setSelectedPinId(pins.length > 0 ? pins[pins.length - 1].id : null);
    setTab('pins');
    setCommentMode('none');
    setPendingComment(null, null, null);
  }, [pinDropActive, pendingPoint, pendingNodeId, pendingNodeName, actions, setCommentMode, setPendingComment]);

  // Leaving Edit while the drop is still armed would leave the canvas banner up and
  // the next click on the model placing a pin nobody is watching for.
  useEffect(() => () => {
    const state = useStore.getState();
    if (state.commentMode === 'placing-pin') {
      state.setCommentMode('none');
      state.setPendingComment(null, null, null);
    }
  }, []);

  // The panel is only rendered while Edit is on, and the tabs cannot exist without a
  // review to read. While the row this room did not have is being created the panel
  // says that is what is happening; only if the create fails does it say so, plainly,
  // with a way to try again.
  //
  // The old dead end here — "This room has no design review to edit yet", with nothing
  // to press — was reached by every room the lobby's "New session" opened: an admin (or,
  // on an install with no accounts, the meeting host) was granted Edit and then could
  // not save a view or a pin, and a participant in the same room was told import was
  // locked because nobody owned the review.
  if (!config) {
    return (
      <div className="flex-1 min-h-0 bg-[#111] rounded-lg border border-white/10 p-5 flex flex-col gap-3">
        {ensure === 'failed' ? (
          <>
            <p className="text-[11px] text-gray-300 leading-relaxed" role="status">
              Could not create the design review for this room. Check the connection and try again.
            </p>
            <button
              onClick={() => setAttempt((n) => n + 1)}
              className="self-start px-3 py-1.5 rounded border border-white/20 text-[10px] font-bold uppercase tracking-wide text-gray-200 hover:border-white/50 hover:text-white transition-colors"
            >
              Retry
            </button>
          </>
        ) : (
          <p className="text-[11px] text-gray-400 leading-relaxed" role="status">
            Setting up this design review…
          </p>
        )}
      </div>
    );
  }

  // A tab that only exists with accounts, selected before accounts were known
  // about (a config that arrived late), falls back rather than rendering nothing.
  const visible = tabs.some((t) => t.id === tab) ? tab : 'agenda';

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2">
      <ReviewTitleRow title={config.title} onRename={actions.setTitle} />

      <div
        role="tablist"
        aria-label="Review sections"
        className="shrink-0 grid grid-cols-3 gap-1 rounded-lg border border-white/10 bg-[#111] p-1"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={visible === t.id}
            aria-label={t.ariaLabel}
            onClick={() => setTab(t.id)}
            className={clsx(
              'flex items-center justify-center gap-1 py-1.5 rounded text-[10px] font-bold uppercase tracking-wide transition-colors',
              visible === t.id
                ? 'bg-white text-black'
                : 'text-gray-500 hover:text-gray-300 hover:bg-white/5',
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        aria-label={TABS.find((t) => t.id === visible)?.ariaLabel}
        className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-white/10 bg-[#111] custom-scrollbar"
      >
        {visible === 'agenda' && (
          <AgendaTab
            agenda={config.agenda}
            viewpoints={config.viewpoints}
            pins={config.pins}
            onJumpViewpoint={(vp) => jumpToViewpoint(vp.id)}
            onSelectPin={(id) => { setSelectedPinId(id); setTab('pins'); }}
            actions={actions}
          />
        )}
        {visible === 'views' && (
          <ViewsTab
            viewpoints={config.viewpoints}
            onJump={(vp) => jumpToViewpoint(vp.id)}
            actions={actions}
          />
        )}
        {visible === 'pins' && (
          <PinsTab
            pins={config.pins}
            selectedId={selectedPinId}
            onSelect={setSelectedPinId}
            onEnterPinMode={() => setCommentMode('placing-pin')}
            pinDropActive={pinDropActive}
            onCancelPinMode={cancelPinMode}
            actions={actions}
          />
        )}
        {visible === 'requirements' && (
          <RequirementsTab requirements={config.requirements} actions={actions} />
        )}
        {visible === 'labels' && <LabelsTab labels={config.labels} actions={actions} />}
        {visible === 'people' && <PeopleTab reviewId={reviewId} onRosterChanged={onRosterChanged} />}
      </div>

      {/* Last, and only for the people the endpoint would let act: unmaking the
          review is not one more edit, so it does not sit among the tabs. */}
      {mayDeleteReview && <DeleteReviewRow reviewId={reviewId} title={config.title} />}
    </div>
  );
};

export default ReviewEditPanel;
