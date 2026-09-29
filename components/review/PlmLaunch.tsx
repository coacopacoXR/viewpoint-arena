// The PLM launch, in the room it opened (T5.3).
//
// docs/plan/14-rooms-models-admin-ai.md batch BG. pages/LaunchPage.tsx validates a
// deep link from a PLM system, lets the configured adapter resolve it, and hands
// the result to the review's setup address; pages/ReviewSetupRedirect.tsx turns
// that address into `/room/<id>?edit=1` and passes the router state through. This
// is what meets that state. It used to be the AssetTab of pages/ReviewSetupPage.tsx,
// which batch BH deleted when the curation tabs moved into the room — and until
// now nothing replaced it, so a launch opened an empty room: a document nobody had
// recorded and a model nobody had offered.
//
// What a launch does, in order:
//
//   1. Take the arrival out of the address bar and the history state, so a reload
//      cannot replay it. A replay is not harmless: an Onshape link that names an
//      element imports that element the moment the document browser opens.
//   2. Record the document as a reference of the review — through an
//      activeReviewStore mutator, because that is what marks the review as edited
//      by THIS browser, and RoomPage's subscriber saves a mark and nothing else.
//   3. Onshape: open the document browser inside Edit mode, so the part is picked
//      in the room and lands in the room's own scene. Any other source: say why
//      there is no geometry to import, in the words the deleted page used.
//
// The OAuth round-trip is a SECOND arrival for the same launch, with no state at
// all — see lib/connectors/plm/roomArrival.ts. It is answered from the query string
// the return-to carried, which is why the return-to points at this room rather
// than at /launch: /launch mints a fresh review id, and returning there would
// abandon the room the launch just created.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Box, ExternalLink, X } from 'lucide-react';
import { useStore } from '../../store';
import { usePresence } from '../../lib/PresenceContext';
import { useActiveReviewStore } from '../../lib/activeReviewStore';
import { PLM_SOURCE_LABELS, plmReferenceUrl, type PLMLaunch } from '../../lib/connectors/plm/launchParams';
import { launchFromArrival, roomLaunchReturnTo, withoutLaunchParams } from '../../lib/connectors/plm/roomArrival';
import { handSceneImportFile } from '../../lib/scene/importHandoff';
import OnshapeBrowser from '../UI/OnshapeBrowser';
import { useActiveReviewActions } from './useActiveReviewActions';

/**
 * Why a launch from anything but Onshape has no model to offer.
 *
 * The deleted setup page's copy, kept because it is the honest version: it says
 * what is missing and what to do instead rather than pretending a reference is a
 * model.
 */
const LAUNCH_NOTES: Record<'teamcenter' | 'mock', string> = {
  // api/teamcenter/export does not exist yet, so TeamcenterPLMAdapter's
  // exportGeometry throws not-implemented. Said plainly rather than faked.
  teamcenter:
    'Geometry import from Teamcenter is not available yet. The document is recorded as a reference of this review — export it from Teamcenter, then import the file from the model tree to review it in 3D.',
  mock:
    'This review was opened from the mock PLM connector, which has no geometry to import. The document is recorded as a reference of this review — import a file from the model tree to review it in 3D.',
};

// Fixed copy, and the only copy: a launch link's ids are attacker-influenced, so
// nothing here interpolates one. The document's own URL is rendered by the
// reference a person opens in the review, not by this card, and
// lib/connectors/plm/launchParams.ts built and encoded it.
const ONSHAPE_WAITING =
  'This review was opened from an Onshape document, which is recorded in its references. The document browser opens as soon as the room gives you Edit.';
const ONSHAPE_CLOSED =
  'The Onshape document is recorded in this review’s references. Open it again to pick the assembly or part studio to review in 3D.';
const ONSHAPE_IMPORTED =
  'The part you picked is going into the room’s scene — the model tree has it from here. The document stays recorded in this review’s references.';
const ONSHAPE_NO_SCENE =
  'The model could not be handed to the room’s scene, because the model tree is not on this screen. Import it from the model tree instead.';

/** The arrival, captured once: what it carries, and what to leave in its place. */
interface Arrival {
  launch: PLMLaunch | null;
  /** This room's address with the launch parameters taken back out of it. */
  clearTo: string;
}

const PlmLaunch: React.FC = () => {
  const { roomId } = useParams<{ roomId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { localUserId } = usePresence();
  const actions = useActiveReviewActions();

  const reviewEditing = useStore((s) => s.reviewEditing);
  // MINE, not "somebody is": the document browser puts a model in the room's
  // scene, which is a change to the review, so it belongs to the amber strip's
  // session and not to the meeting.
  const iAmEditing = reviewEditing !== null && reviewEditing.userId === localUserId;

  // The review the room is holding, as an id rather than as the draft: the launch
  // waits for the room's own seed, and depending on the object would re-run this
  // on every edit anybody makes.
  const configReviewId = useActiveReviewStore((s) => s.config?.reviewId ?? null);

  // Captured on the first render and never read again. A launch is an ARRIVAL: the
  // effect below navigates, so reading location inside it would make it depend on
  // its own navigation, and on every other one the room makes.
  const [arrival] = useState<Arrival>(() => ({
    launch: launchFromArrival(location.state, location.search),
    clearTo: `${location.pathname}${withoutLaunchParams(location.search)}`,
  }));

  const [launch, setLaunch] = useState<PLMLaunch | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const handledRef = useRef(false);
  const importedRef = useRef(false);

  // The writer is read through a ref and is NOT a dependency, for the reason
  // components/UI/Interface.tsx reads the sender of its own ?edit=1 request the
  // same way: useActiveReviewActions is built from usePresence, which returns a
  // fresh object every render, so listing it would mean "run on every render" —
  // and this effect runs the launch.
  const addReferenceRef = useRef(actions.addReference);
  useEffect(() => {
    addReferenceRef.current = actions.addReference;
  });

  useEffect(() => {
    const arrived = arrival.launch;
    if (arrived === null || handledRef.current) return;
    // Wait for the room's own review. RoomPage seeds asynchronously — the lobby's
    // handover draft, then the row it read, and for a launch with no row yet the
    // review it creates — and a reference written before that lands is a reference
    // the seed replaces. A child's effects run before its parent's, so on the
    // first render this is always the early return; the config arriving is what
    // fires the launch. Waiting is also what makes StrictMode's double mount
    // harmless together with the ref above, which is set synchronously: one
    // arrival records one document, however many times React mounts this.
    if (roomId === undefined || configReviewId !== roomId) return;
    handledRef.current = true;

    // Out of the address bar and the history state before anything that can fail.
    // `edit=1` stays — Edit is what the launch asked for.
    navigate(arrival.clearTo, { replace: true, state: null });

    const { source, doc } = arrived;
    const name = `${PLM_SOURCE_LABELS[source]} document`;
    const url = plmReferenceUrl(source, doc);
    // Not recorded twice. The OAuth return is a second arrival for the SAME
    // launch, and by then the first arrival's reference is in the review — read
    // back out of the row the room re-seeded itself from.
    const references = useActiveReviewStore.getState().config?.asset.references ?? [];
    if (!references.some((ref) => ref.name === name && ref.url === url)) {
      addReferenceRef.current({ name, url });
    }

    setLaunch(arrived);
    if (source === 'onshape') {
      // The browser is what this launch is for, and it opens as soon as the room
      // gives this person Edit — see `browser` below. Until then the card says so,
      // rather than the launch looking like it did nothing.
      setBrowserOpen(true);
      setNote(ONSHAPE_WAITING);
      return;
    }
    setNote(LAUNCH_NOTES[source]);
  }, [arrival, roomId, configReviewId, navigate]);

  const handleImported = useCallback((file: File) => {
    // Set before the outcome is known: the browser closes itself straight after
    // this, and the card must not then say "pick a part" over the result of the
    // pick somebody just made.
    importedRef.current = true;
    // SceneTree's pipeline and not a second one: it shares the file, parses it,
    // asks beside / replace / revision and writes the revision row. False means no
    // scene panel is mounted to take it, and a model Onshape spent a minute
    // translating is not something to drop without a word.
    if (handSceneImportFile(file)) {
      setNote(ONSHAPE_IMPORTED);
      return;
    }
    setNote(ONSHAPE_NO_SCENE);
  }, []);

  const closeBrowser = useCallback(() => {
    setBrowserOpen(false);
    // Closing without a part picked is the normal way out of a document browser,
    // and it leaves the launch half-done: say what it did record, and how to
    // finish it. An import that was attempted already said what happened.
    if (!importedRef.current) setNote(ONSHAPE_CLOSED);
  }, []);

  const onshape = launch !== null && launch.source === 'onshape' ? launch : null;
  // Edit mode, and this person's. Until the room grants it the browser waits and
  // the card says so, rather than opening a picker whose import the room would
  // refuse.
  const browser = onshape !== null && browserOpen && iAmEditing && roomId !== undefined
    ? {
        document: { id: onshape.doc.id, workspaceId: onshape.doc.workspaceId },
        elementId: onshape.doc.elementId,
        // The same room with Edit on, carrying the launch ids — the round trip has
        // no router state to carry them in.
        returnTo: roomLaunchReturnTo(roomId, onshape),
      }
    : null;

  // The card is the launch's own trace in the room: why there is no geometry to
  // import, or how to finish picking one. Behind the document browser rather than
  // underneath it — one thing to look at at a time — and gone for good once
  // dismissed, which is why the copy is set when it happens rather than derived
  // from what is open.
  const cardNote = browser === null ? note : null;

  if (launch === null && note === null) return null;

  return (
    <>
      {/* Wrapped rather than left bare: Interface's root opts the whole overlay
          out of the pointer, and a modal that cannot be clicked is a modal that
          cannot be closed. The wrapper has no transform or filter, so the
          browser's own `fixed inset-0` still covers the window. */}
      {browser !== null && (
        <div className="pointer-events-auto">
          <OnshapeBrowser
            onClose={closeBrowser}
            onImported={handleImported}
            initialDocument={browser.document}
            initialElementId={browser.elementId}
            signInReturnTo={browser.returnTo}
          />
        </div>
      )}

      {cardNote !== null && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[190] w-[440px] max-w-[calc(100vw-3rem)] pointer-events-auto">
          <div className="flex items-start gap-2.5 px-4 py-3 rounded-lg bg-amber-50 border border-amber-300 shadow-lg">
            <Box size={14} className="text-amber-600 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-[9px] font-bold uppercase tracking-widest text-amber-700 mb-1">
                {launch === null ? 'Launched from your PLM' : `Opened from ${PLM_SOURCE_LABELS[launch.source]}`}
              </p>
              <p className="text-[11px] leading-relaxed text-amber-900">{cardNote}</p>
              {onshape !== null && browser === null && iAmEditing && (
                <button
                  onClick={() => { setNote(null); setBrowserOpen(true); }}
                  className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-amber-400 text-black text-[10px] font-bold uppercase tracking-wide hover:bg-amber-300 transition-colors"
                >
                  <ExternalLink size={11} /> Open the Onshape document
                </button>
              )}
            </div>
            <button
              onClick={() => setNote(null)}
              className="text-amber-500 hover:text-amber-800 transition-colors shrink-0"
              title="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default PlmLaunch;
