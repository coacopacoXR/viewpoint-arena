import React, { useEffect, useRef, useState } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import ViewpointCanvas from '../components/Scene/ViewpointCanvas';
import Interface from '../components/UI/Interface';
import MobileRoomView from '../components/UI/MobileRoomView';
import ManagerPanel from '../components/UI/ManagerPanel';
import { useStore } from '../store';
import { usePartyPresence } from '../lib/usePartyPresence';
import { PresenceContext } from '../lib/PresenceContext';
import { useWebRTC } from '../lib/useWebRTC';
import { WebRTCContext } from '../lib/WebRTCContext';
import { useReviewSetupStore, createReviewDraft } from '../lib/reviewSetupStore';
import type { ReviewDraft } from '../lib/reviewSetupStore';
import { useActiveReviewStore } from '../lib/activeReviewStore';
import { consumeLocalEdit } from '../lib/reviewLocalEdit';
import { createReview, loadCuration, saveCuration } from '../lib/curationsRepo';
import { launchFromArrival } from '../lib/connectors/plm/roomArrival';
import { supabaseConfigured } from '../lib/supabase';
import { useIsMobile } from '../lib/useIsMobile';
import { RecordingProvider } from '../lib/RecordingContext';
import RemoteAudioSink from '../components/UI/RemoteAudioSink';
import { useJoinState } from '../lib/usePartyPresence';
import JoinWaitingRoom from '../components/UI/JoinWaitingRoom';
import { recordJoin, joinRoleFor, type ReviewRole } from '../lib/reviewParticipantsRepo';
import { droppedLineReason, lineIdFromSearch, partyRoomName, type ReviewLine } from '../lib/reviews/lines';
import { resolveLine } from '../lib/reviews/linesRepo';
import { ENTERED_ROOM_KEY, markRoomEntered, openLine } from '../lib/reviews/openLine';

function getMobileUserName(): string {
  try {
    const s = localStorage.getItem('vp_user');
    return s ? (JSON.parse(s).name || 'Guest') : 'Guest';
  } catch {
    return 'Guest';
  }
}

const RoomPage: React.FC = () => {
  const { roomId } = useParams<{ roomId: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  // The PLM launch this arrival carries, if it carries one (T5.3), and the room it
  // arrived at — a room can be navigated to from another room without this
  // component remounting, and a launch belongs to one arrival only. Captured on the
  // first render rather than read inside an effect: both uses below are about
  // ARRIVING, and re-reading location later would make the room's own seed depend
  // on a navigation. See lib/connectors/plm/roomArrival.ts for the two spellings a
  // launch arrives in.
  const [arrival] = useState(() => ({
    roomId: roomId ?? '',
    launch: launchFromArrival(location.state, location.search),
  }));
  const arrivalLaunch = arrival.roomId === roomId ? arrival.launch : null;

  // Guard: if arriving directly (not from lobby), redirect to lobby to set identity
  useEffect(() => {
    // A launch is the third way in, and the one that must not be sent back:
    // pages/LaunchPage.tsx asked for the name itself, and a bounce to the lobby
    // would drop the router state carrying the resolved document — the only thing
    // that says which Onshape document this room was opened for. Recorded as a
    // deliberate entry the way the lobby and the identity gate record one, so a
    // reload of the room is let back in too: by then the launch has been handled
    // and its state cleared, so there is nothing left to say where this came from.
    if (arrivalLaunch !== null && roomId) {
      markRoomEntered(roomId);
      return;
    }
    const enteredRoom = sessionStorage.getItem(ENTERED_ROOM_KEY);
    const fromLobby = (location.state as { fromLobby?: boolean } | null)?.fromLobby;
    if (!fromLobby && enteredRoom !== roomId) {
      navigate('/', { state: { joinRoomId: roomId }, replace: true });
    }
  }, [roomId, arrivalLaunch]);

  // ─── Which line of the design review this room is on ────────────────────────
  // docs/plan/15-sessions-and-variants.md batch BK. `/room/<reviewId>` is the MAIN
  // line, so every link already in circulation opens the room it always did;
  // `/room/<reviewId>?line=<lineId>` is one of its variants.
  //
  // The line decides the PartyKit room name, and that is why this resolves BEFORE
  // the socket is opened rather than alongside it: a variant's meetings are held in
  // `<reviewId>~<letter>`, with their own presence, their own audio and their own
  // scene on the room server, and connecting to the review's own room first "for a
  // moment" would put this person in the main line's meeting — visible to it,
  // audible to it, and able to move its model — until the read landed. So while a
  // `?line=` is unresolved the room is connected to nothing, which the join gate
  // already renders as a waiting room.
  //
  // A room with no `?line=` does not wait: it is the main line whether or not the
  // database has a row saying so, and `resolveLine` fills that row in behind it.
  const lineParam = lineIdFromSearch(location.search);
  const [lineState, setLineState] = useState<{ ready: boolean; line: ReviewLine | null }>(
    () => ({ ready: lineParam === null, line: null }),
  );
  // Reset DURING the render in which the address changed, and not in the effect below.
  // Batch BX: switching line from inside a room — main → variant, variant → variant,
  // variant → main — is a navigation to the same route with a different `?line=`, so
  // this component does not remount and `lineState` would still be holding the line
  // this room was on a moment ago. One frame of that is one frame in which the socket
  // opens on the room that was just left, which is exactly the cross-line presence and
  // audio the sequencing above exists to prevent. Setting state while rendering is
  // React's own answer to "derived state must not survive a prop change": it discards
  // this render and starts again with the new value, committing nothing in between.
  const [resolvedFor, setResolvedFor] = useState<string | null>(lineParam);
  if (resolvedFor !== lineParam) {
    setResolvedFor(lineParam);
    setLineState({ ready: lineParam === null, line: null });
  }
  useEffect(() => {
    if (!roomId) return;
    // No database to ask, so there is no line to resolve — and an ad-hoc room has
    // no review to have one. The socket opens on the room id, as it always did.
    if (!supabaseConfigured) {
      setLineState({ ready: true, line: null });
      return;
    }
    let cancelled = false;
    void (async () => {
      const line = await resolveLine(roomId, lineParam);
      if (cancelled) return;
      // Into the store as well as into state: the meeting flush numbers the session
      // on it, the Capture panel lists the cards it is carrying, and
      // lib/scene/showCurationModel starts the scene from its last meeting.
      useStore.getState().setActiveLine(line);
      setLineState({ ready: true, line });
    })();
    return () => { cancelled = true; };
  }, [roomId, lineParam]);

  // The room's session, REMOUNTED whenever the line it is on changes.
  //
  // Not an optimisation and not a convenience: a line is a different PartyKit room, a
  // different scene, a different set of carried-over cards, a different Edit lock and a
  // different name on the chip, and every one of those is owned by an effect or a ref
  // below whose dependency list has no line in it — because until batch BX a room could
  // not change line without a page load. Keying the session on the address's `?line=`
  // makes a switch from inside a room behave exactly like the arrival it is: the old
  // session disconnects and releases its Edit lock, the store's review and line are
  // cleared by its unmount, and the new one seeds, connects and resolves its own
  // carried-over cards from scratch. The key is the PARAMETER and not the resolved
  // line's id, so a room that is still resolving its line does not mount twice.
  return (
    <RoomSession
      key={`${roomId ?? ''}|${lineParam ?? ''}`}
      roomId={roomId ?? ''}
      line={lineState.line}
      lineReady={lineState.ready}
      arrivalLaunch={arrivalLaunch}
    />
  );
};

/**
 * One visit to one line of one design review.
 *
 * Everything here assumes the line is fixed for the lifetime of the component, which is
 * what the key in RoomPage above guarantees. `lineReady` false means the line named by
 * the address has not been read yet, and while it has not the socket is connected to
 * nothing — see the sequencing comment above.
 */
const RoomSession: React.FC<{
  roomId: string;
  line: ReviewLine | null;
  lineReady: boolean;
  arrivalLaunch: ReturnType<typeof launchFromArrival>;
}> = ({ roomId, line: resolvedLine, lineReady, arrivalLaunch }) => {
  const navigate = useNavigate();
  const isMeetingEnded = useStore(state => state.isMeetingEnded);
  const isBoardroomMode = useStore(state => state.isBoardroomMode);

  // Stable mobile detection: keyed off UA + pointer capability rather than viewport
  // width, so a narrow desktop window never flips into the mobile UI mid-session.
  const isMobile = useIsMobile();

  // The reason this room's line was dropped, or null when it was not. Read off the
  // line row that was already resolved to name the PartyKit room, so a room opened by
  // its address says why in its first frame rather than after a second read.
  const dropped = droppedLineReason(resolvedLine);

  const presence = usePartyPresence(lineReady ? partyRoomName(roomId, resolvedLine) : undefined);
  const joinState = useJoinState();

  // Seed the active review for this room:
  //   1. Put the draft the lobby handed over on screen at once, so the room is
  //      not empty while the row is read. It is a copy of the row the lobby just
  //      wrote, and on an install with no database it is the only copy there is.
  //   2. Then read the row — the copy everybody else has been editing, and the
  //      one a review saved in an earlier visit lives in — and adopt it. The row
  //      wins, and from that moment the handover draft is dropped: it described
  //      the review as it was when the lobby created it, and nothing in the room
  //      ever updates it, so a later visit that seeded from it again would put an
  //      older review on screen and in front of everybody else in the room.
  // Then broadcast to other participants.
  //
  // `roomId` is the ONLY reactive dependency (plus `arrivalLaunch`, and `lineReady`
  // which flips once). usePartyPresence builds a fresh object every
  // render, so listing it re-ran the seed on every render of the room and put the
  // lobby's draft back over whatever the review had become since. That is how a
  // view saved from the amber strip was gone again a moment later, and how the
  // stale draft — not the edit — was what reached the database. The broadcast is
  // read through a ref, the way components/UI/Interface.tsx reads the sender of
  // its own ?edit=1 request, for exactly this reason.
  const broadcastReviewConfigRef = useRef(presence.broadcastReviewConfig);
  useEffect(() => {
    broadcastReviewConfigRef.current = presence.broadcastReviewConfig;
  });
  // The draft the seed put in the store. Seeding is not editing: nothing here
  // raises the local-edit mark the persistence subscriber below needs, so walking
  // into a room never writes the row back over whatever somebody else has just
  // saved. The ref is what tells the read below apart from an edit made while it
  // was in flight.
  const seededDraftRef = useRef<ReviewDraft | null>(null);
  useEffect(() => {
    if (!roomId) return;
    // Not before the line is known. Seeding is what puts the review's scene up
    // (lib/activeReviewStore → showReviewScene), and which scene that is depends on
    // which line this room is on — seeding first would start a variant's meeting on
    // the main line's model. A room with no `?line=` is ready on the first render,
    // so nothing it does is delayed by this.
    if (!lineReady) return;
    let cancelled = false;
    let stopRetrying: (() => void) | undefined;

    const broadcastWhenReady = (draft: ReviewDraft) => {
      stopRetrying?.();
      stopRetrying = undefined;
      if (broadcastReviewConfigRef.current(draft)) return;
      const id = setInterval(() => {
        if (broadcastReviewConfigRef.current(draft)) clearInterval(id);
      }, 250);
      const stop = setTimeout(() => clearInterval(id), 5000);
      stopRetrying = () => { clearInterval(id); clearTimeout(stop); };
    };

    const seed = (draft: ReviewDraft) => {
      seededDraftRef.current = draft;
      useActiveReviewStore.getState().setConfig(draft);
      // This room is holding a design review, not an ad-hoc session: the meeting
      // that ends here is recorded against it (lib/trackerBridge).
      useStore.getState().setActiveReviewId(roomId);
      broadcastWhenReady(draft);
    };

    const localDraft = useReviewSetupStore.getState().draft;
    const handedOver = localDraft !== null && localDraft.reviewId === roomId;
    if (handedOver) seed(localDraft);

    // A PLM launch (T5.3) arrives for a review nothing has written yet:
    // pages/LaunchPage.tsx mints the id and navigates, and the setup address that
    // used to create the review on arrival is a redirect now. So the room brings it
    // into existence the way the lobby's "New design review" does — and only for an
    // arrival that says it was launched. An ad-hoc session with no row is still
    // exactly that: a room with no review in it. A handover draft means the review
    // was created on the way here, so there is nothing left to make.
    const launched = handedOver ? null : arrivalLaunch;

    // Where there is no database to read, the read is skipped: the handover draft
    // above is the whole story on such an install, and a request to a client that
    // was built with placeholder credentials can only fail and log. It is also why
    // the drop below happens only once a row has actually come back — with no row,
    // that draft is the only copy of the review this browser has.
    if (!supabaseConfigured) {
      // With no row to read there is nothing else to seed from, and a launch with
      // no review in the store has nowhere to record its document.
      if (launched !== null) seed(createReviewDraft(roomId));
    } else {
      void (async () => {
        const remote = await loadCuration(roomId);
        if (cancelled) return;
        if (!remote) {
          if (launched === null) return;
          // Row first, then the room — the lobby's order, for its two reasons.
          // createReview also claims the owner, which on a deployment with
          // accounts is what lets this person be GRANTED the Edit their launch
          // link asked for; without it they are a participant in a review nobody
          // owns and the document browser would never open. And a write that did
          // not land still leaves the room with a review to edit, which the
          // save-on-edit subscriber below upserts later if a database ever
          // answers.
          const created = await createReview(roomId);
          if (cancelled) return;
          seed(created ?? createReviewDraft(roomId));
          return;
        }
        // The row is the truth from here on, so the copy the lobby handed over has
        // finished its job — in this visit and in every later one. Left in
        // localStorage it would seed the next visit with a review that predates
        // everything anybody has saved since, and the seed broadcasts, so it would
        // hand that older copy to everybody else in the room as well.
        if (useReviewSetupStore.getState().draft?.reviewId === roomId) {
          useReviewSetupStore.getState().discardDraft();
        }
        // The row exists, so this room holds the review whether or not the seed
        // below runs. Found live (batch BL): opening a variant from the Sessions
        // map remounts the room with a review config already in the store, the
        // guard below returns, and without this the variant's meetings were
        // recorded with no review and no line.
        useStore.getState().setActiveReviewId(roomId);
        // Somebody in this room has already changed the review — a write made in
        // the moment before the read landed. That copy is what the subscriber
        // below is about to save, so the row must not replace it.
        const current = useActiveReviewStore.getState().config;
        if (current !== null && current !== seededDraftRef.current) return;
        seed(remote);
      })();
    }

    return () => { cancelled = true; stopRetrying?.(); };
  }, [roomId, arrivalLaunch, lineReady]);

  // Persist in-room edits to viewpoints / pins / agenda back to the cloud
  // (debounced). Only one screen writes through at a time — everybody else gets
  // the latest via PartyKit's REVIEW_CONFIG broadcast and doesn't need to push.
  //
  // Who that one screen is widened in batch BH, when the curation tabs moved into
  // the room: it used to be the meeting host alone, because the only in-room edits
  // were a renamed viewpoint or pin. With Edit on, an owner or an editor who is
  // NOT the host is the one changing the review, and a subscriber that listened
  // only to the host would have thrown their work away on the next reload. So:
  // the host, or whoever the room server says has Edit.
  //
  // Being one of those two is necessary but NOT sufficient, which batch BH3 found
  // the hard way. The review this screen holds also changes when a REVIEW_CONFIG
  // arrives from somebody else, when the room seeds itself from the lobby's
  // handover draft, and when the row is read back on entry — and a subscriber that
  // saved on any of those wrote a copy it had not authored over one somebody else
  // had just saved. With two people in the room that emptied a review one of them
  // had already saved a view into. So the question is not "did the review change"
  // but "did I change it": every editing action marks it (lib/reviewLocalEdit),
  // the mark is taken here, and nothing else writes.
  //
  // The whole review still goes, not a diff of it. Two people editing at once is
  // already impossible — Edit is one lock the room server hands out (batch BH) —
  // so last writer wins, and the last writer is by definition somebody who was
  // editing.
  const sessionHostId = useStore(state => state.sessionHostId);
  const reviewEditing = useStore(state => state.reviewEditing);
  const localUserId = presence.localUserId;
  useEffect(() => {
    if (!roomId) return;
    const isHost = sessionHostId === localUserId || sessionHostId === null;
    const iAmEditing = reviewEditing !== null && reviewEditing.userId === localUserId;
    if (!isHost && !iAmEditing) return;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let pending: ReviewDraft | null = null;
    const flush = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = undefined;
      if (!pending) return;
      const draft = pending;
      pending = null;
      saveCuration(draft);
    };
    const unsub = useActiveReviewStore.subscribe((state, prev) => {
      if (!state.config || state.config === prev.config) return;
      if (state.config.reviewId !== roomId) return;
      // Taken at the moment of the change rather than at the flush: the copy that
      // goes is the one this screen was holding when its owner made the edit, and
      // a copy that arrives from the room a moment later leaves it alone.
      if (!consumeLocalEdit()) return;
      // debounce per-writer via a moving timer keyed off the config object
      pending = state.config;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flush, 1000);
    });
    return () => {
      // Flushed rather than dropped. Unsubscribing now happens every time Edit
      // changes hands, and Done is pressed within a second of the last edit far
      // more often than not — a cleanup that only cleared the timer would lose
      // exactly the change the person just made.
      flush();
      unsub();
    };
  }, [roomId, sessionHostId, localUserId, reviewEditing]);

  // "The reviews I have been part of" (docs/plan/13-identity.md batch AZ).
  // Written once per room entry, and only for somebody this deployment signed
  // in: recordJoin is the one place that knows what that means, and it does
  // nothing at all for a guest or for an install on identity.mode 'none'. It
  // also cannot break the room — every failure is logged and dropped there.
  const recordedRef = useRef<{ roomId: string; role: ReviewRole } | null>(null);
  useEffect(() => {
    // Not before this: a person parked in the waiting room has not taken part
    // in anything yet, and a declined one never does.
    const role = joinRoleFor({
      admitted: joinState === 'admitted',
      sessionHostId,
      localUserId: presence.localUserId,
    });
    if (!roomId || !role) return;
    const recorded = recordedRef.current;
    // Once per room entry, plus one correction: JOIN_ADMITTED reaches the
    // client a message before HOST_CHANGE, so the first write can predate this
    // client learning that it is the host. The upsert never downgrades a role,
    // so the second write can only be the upgrade.
    if (recorded?.roomId === roomId && (recorded.role === role || role !== 'host')) return;
    recordedRef.current = { roomId, role };
    void recordJoin(roomId, role);
  }, [roomId, joinState, sessionHostId, presence.localUserId]);

  // Clear active review when leaving the room so it doesn't leak across sessions.
  useEffect(() => {
    return () => {
      useActiveReviewStore.getState().setConfig(null);
      // Cleared with the config, for the same reason: a meeting ended from the
      // lobby's demo, or from the next room this browser opens, must not be
      // recorded against the review that was open a moment ago.
      useStore.getState().setActiveReviewId(null);
      // And not onto the line that review was on, either: the next room is on its
      // own line, and a stale one would number its first session on the last
      // review's.
      useStore.getState().setActiveLine(null);
    };
  }, []);

  const webrtc = useWebRTC({
    localUserId: presence.localUserId,
    remoteParticipantList: presence.remoteParticipantList,
    broadcastWebRTCSignal: presence.broadcastWebRTCSignal,
    registerWebRTCSignalHandler: presence.registerWebRTCSignalHandler,
    active: joinState === 'admitted',
    isBoardroomMode,
  });

  // PresenceContext wraps BOTH mobile and desktop so ViewpointCanvas works in both.
  // RecordingProvider sits inside WebRTCContext (it reads localStream /
  // remoteStreams) and outside the layout so both the sidebar ConversationPanel
  // and the Manager Workspace share one recorder instance.
  return (
    <PresenceContext.Provider value={presence}>
    <WebRTCContext.Provider value={webrtc}>
    <RecordingProvider>
      <RemoteAudioSink />
      {joinState !== 'admitted' ? (
        <JoinWaitingRoom roomId={roomId} />
      ) : (
        <>
          {dropped && <DroppedLineBanner reason={dropped} onMainLine={() => openLine(navigate, roomId, null)} />}
          {isMobile ? (
            <MobileRoomView
              roomId={roomId}
              userName={getMobileUserName()}
            />
          ) : (
            <DesktopRoomLayout isMeetingEnded={isMeetingEnded} />
          )}
        </>
      )}
    </RecordingProvider>
    </WebRTCContext.Provider>
    </PresenceContext.Provider>
  );
};

/**
 * The banner over a room that is on a line nobody is exploring any more.
 *
 * Batch BX. A dropped variant is kept for the record and its address keeps working, so
 * the room is still reachable — by a bookmark, by a link somebody pasted into a chat
 * three weeks ago, by a browser history entry. What it is NOT is a meeting: the room
 * server refuses scene changes and refuses to hand out Edit on a dropped line's room,
 * because a change made here would be written into a slot of the review's positions
 * that nothing else reads and into cards that have already moved or already closed.
 * A room that quietly ignored every drag would be worse than one that said why.
 *
 * The reason is the one stored on the line's own row — the same sentence the cards it
 * closed carry — and the way out is the main line, which is the one line of a review
 * that is always still being explored.
 */
const DroppedLineBanner: React.FC<{ reason: string | null; onMainLine: () => void }> = ({ reason, onMainLine }) => (
  <div
    className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] max-w-[min(92vw,640px)] flex items-center gap-3 px-3 py-2 rounded-md border border-gray-300 bg-white shadow-lg pointer-events-auto"
    role="status"
    data-testid="dropped-line-banner"
  >
    <p className="text-[11px] text-gray-700 leading-snug">
      <span className="font-semibold">This variant was dropped{reason ? `: ${reason}` : '.'}</span>{' '}
      It is kept for the record, and its model can no longer be changed.
    </p>
    <button
      onClick={onMainLine}
      className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded border border-black bg-black text-white text-[10px] font-semibold hover:bg-gray-800"
    >
      Go to the main line
    </button>
  </div>
);

// Desktop-only: viewport + Interface overlay, with an optional resizable
// split-screen Manager workspace on the right (host-only, toggled from the
// Review popup). Width is persisted to localStorage so the layout sticks
// between sessions.
const MANAGER_WIDTH_KEY = 'vp_manager_width';
const MIN_VIEWPORT = 480;
const MIN_MANAGER  = 320;

const DesktopRoomLayout: React.FC<{ isMeetingEnded: boolean }> = ({ isMeetingEnded }) => {
  const managerMode = useActiveReviewStore((s) => s.managerMode);
  const containerRef = useRef<HTMLDivElement>(null);
  const [managerWidth, setManagerWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem(MANAGER_WIDTH_KEY));
    return Number.isFinite(stored) && stored >= MIN_MANAGER ? stored : 480;
  });
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Persist width.
  useEffect(() => {
    localStorage.setItem(MANAGER_WIDTH_KEY, String(managerWidth));
  }, [managerWidth]);

  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: managerWidth };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current || !containerRef.current) return;
      const dx = ev.clientX - dragRef.current.startX;
      const next = dragRef.current.startWidth - dx; // dragging left grows the panel
      const containerWidth = containerRef.current.clientWidth;
      const clamped = Math.max(MIN_MANAGER, Math.min(containerWidth - MIN_VIEWPORT, next));
      setManagerWidth(clamped);
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div ref={containerRef} className="flex w-full h-screen bg-[#F2F2F2] overflow-hidden select-none">
      {/* Left: 3D viewport + UI overlay. Flexes to fill remaining space. */}
      <div className="relative flex-1 min-w-0">
        {!isMeetingEnded && <ViewpointCanvas />}
        <div className="absolute inset-0 z-10 pointer-events-none">
          <Interface />
        </div>
      </div>

      {managerMode && (
        <>
          {/* Drag handle */}
          <div
            onMouseDown={onDragStart}
            className="w-1.5 bg-gray-200 hover:bg-gray-400 cursor-col-resize shrink-0 transition-colors"
            title="Drag to resize"
          />
          {/* Right: Manager workspace */}
          <div className="shrink-0 h-full" style={{ width: managerWidth }}>
            <ManagerPanel />
          </div>
        </>
      )}
    </div>
  );
};

export default RoomPage;
