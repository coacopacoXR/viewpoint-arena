import type * as Party from 'partykit/server';
import type { InsightCard, SpatialComment, LiveChatMessage, XRParticipantData } from '../types';
import type { ReviewDraft } from '../lib/reviewSetupStore';
import { verifyAccessToken, type VerifiedAccount } from './verifyJwt';
import {
  applySceneUpdate as reduceSceneUpdate,
  emptyScene,
  MAX_SCENE_MODELS,
  scenePermissions,
  type ModelEditors,
  type ModelRepresentation,
  type RoomScene,
  type SceneAuthority,
  type SceneRefusalReason,
  type SceneStatePayload,
  type SceneUpdate,
} from '../lib/scene/roomScene';
import {
  asModelEditors,
  asRepresentation,
  asRoomScene,
  asSceneUpdate,
  sceneFromLegacyReference,
  seededFromStorage,
} from '../lib/scene/sceneWire';
import { can, type Role } from '../lib/reviews/roles';
import { reviewIdOfPartyRoom } from '../lib/reviews/partyRoom';
import { ReviewFactsCache, roleFromFacts, type ReviewFactsSource } from './reviewRoles';

export type WebRTCSignalData =
  | { type: 'offer'; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; sdp: RTCSessionDescriptionInit }
  | { type: 'ice'; candidate?: RTCIceCandidateInit };

/**
 * What is on screen, by reference — the shape batch BA introduced, kept only so
 * a client that has not been updated can still be understood.
 *
 * `hash` is the SHA-256 the file was stored under (POST /api/models). Clients
 * fetch the bytes from /api/models/<hash> instead of receiving them here, which
 * is what removes the size limit a websocket imposes on a shared model: a room
 * used to carry up to 50 MB of base64 through this payload, held in the server's
 * memory and replayed to every connection that joined. `fileName` travels with
 * the hash because utils/modelLoader.ts dispatches on the extension, and `size`
 * is what a client shows while the download runs.
 *
 * This server no longer SENDS one — it holds a whole scene (RoomScene) and
 * relays that as SCENE_STATE. An arriving MODEL_CHANGE is translated into
 * "the scene is this one model", which is what the message always meant back
 * when the scene could only hold one; see sceneFromLegacyReference.
 */
export interface ModelReference {
  modelType: 'synth' | 'bicycle' | 'imported';
  hash?: string;
  fileName?: string;
  size?: number;
  /**
   * Which encoding of `hash` everybody loads: the uploaded file, or the GLB
   * convert-service tessellated from it. Optional, and absent on every message
   * an older client sent, where 'source' is the only answer it could have
   * meant — see ModelRepresentation in lib/scene/roomScene.ts for why this is a
   * room-wide fact rather than each client's own choice.
   */
  representation?: ModelRepresentation;
}

/**
 * A MODEL_CHANGE as it arrives, which may still carry bytes.
 *
 * `fileBase64` is declared only so the handler can recognise a payload from a
 * client that has not been updated and DROP it. Nothing stores that field and
 * nothing relays it.
 */
export interface IncomingModelChange extends ModelReference {
  fileBase64?: string;
}

export interface ParticipantPresence {
  userId: string;
  name: string;
  color: string;
  position: [number, number, number];
  lookAt: [number, number, number];
  sameRoom?: boolean;
  // Who this client's camera is locked to, and whether they are mid-nudge
  // (dragging their own view without leaving the follow). Optional so an
  // older client's payload stays valid — a missing field means "not following".
  followingUserId?: string | null;
  followNudged?: boolean;
  // True when this person is in the room without an account, on a deployment
  // whose identity block allows guests. Carried as a flag rather than baked
  // into `name`, so the suffix a UI adds never reaches stored data (tracker
  // items, audit rows, transcripts). Optional: an older client sends nothing,
  // which reads as "not a guest" — the only answer possible before identity.
  guest?: boolean;
  // The signed-in person's access token, sent by the client on the way IN and
  // deleted by the server before this payload is stored, queued, relayed or
  // persisted — see applyVerifiedIdentity. It is a bearer credential: anybody
  // who received it could be that person everywhere in the app, so no code path
  // may put it back on the wire. Optional, and never sent at all by a client on
  // a deployment whose identity.mode is 'none'.
  accessToken?: string;
  // The account behind this presence, stamped by the server from a token it
  // verified — the same id RLS's auth.uid() answers for that person. Never
  // taken from a client: a payload that arrives carrying one without a valid
  // token has it removed, so what another client reads here is either proven or
  // absent.
  accountId?: string;
}

type RoomMessage =
  | { type: 'PRESENCE'; payload: ParticipantPresence }
  | { type: 'LEAVE'; payload: { userId: string } }
  | { type: 'ROSTER'; payload: ParticipantPresence[] }
  | { type: 'PRESENTER_CHANGE'; payload: { agentId: string | null } }
  | { type: 'INSIGHT_CARD'; payload: InsightCard }
  | { type: 'LEADER_CHANGE'; payload: { userId: string | null } }
  | { type: 'BOARDROOM_COUNTDOWN'; payload: Record<string, never> }
  | { type: 'BOARDROOM_STATE'; payload: { active: boolean; leaderId: string | null; takeover: { enabled: boolean; approvedUserIds: string[] } } }
  | { type: 'ARENA_ENTRY'; payload: Record<string, never> }
  | { type: 'LASER_MOVE'; payload: { userId: string; position: [number, number, number] | null; targetId?: string | null; targetMeshName?: string | null; targetPartName?: string | null } }
  | { type: 'PRIVACY_MODE'; payload: { enabled: boolean } }
  | { type: 'LEADER_TAKEOVER'; payload: { userId: string } }
  | { type: 'MODEL_CHANGE'; payload: IncomingModelChange }
  | { type: 'SCENE_STATE'; payload: SceneStatePayload }
  | { type: 'SCENE_UPDATE'; payload: SceneUpdate }
  // "This room has never held a scene; here is the one its design review says it
  // should start from." Accepted once, and only from a connection that may change
  // the models — see the SCENE_SEED branch in onMessage.
  | { type: 'SCENE_SEED'; payload: RoomScene }
  | { type: 'SCENE_REFUSED'; payload: { reason: SceneRefusalReason } }
  | { type: 'SET_MODEL_EDITORS'; payload: { modelEditors: ModelEditors } }
  | { type: 'REVIEW_CONFIG'; payload: { config: ReviewDraft } }
  // Editing the review (batch BH). Requests come in, and the answer goes out —
  // EDITING_STATE to the whole room, the two others to the one connection that
  // needs them. The mirror of SCENE_UPDATE / SCENE_REFUSED: this server owns the
  // fact, so "only one person edits at a time" is not something two clients can
  // each believe differently.
  | { type: 'EDITING_START'; payload: { force?: boolean } }
  | { type: 'EDITING_STOP'; payload: Record<string, never> }
  | { type: 'EDITING_STATE'; payload: { editorUserId: string | null; editorName: string | null } }
  // 'busy' names a colleague, 'role' names the review's roster, and 'dropped' names
  // the LINE: this room is a variant the review has finished with, so there is no
  // edit to hand out to anybody (batch BX). One sentence each, in
  // components/review/ReviewEditingNotice.tsx.
  | { type: 'EDITING_REFUSED'; payload: { reason: 'busy' | 'role' | 'dropped'; editorName: string | null } }
  | { type: 'EDITING_TAKEN_OVER'; payload: { byName: string } }
  | { type: 'HOST_CHANGE'; payload: { hostId: string | null } }
  | { type: 'HOST_TRANSFER'; payload: { toUserId: string } }
  | { type: 'MEETING_END'; payload: Record<string, never> }
  | { type: 'TAKEOVER_SYNC'; payload: { enabled: boolean; approvedUserIds: string[] } }
  | { type: 'PRESENTER_REQUEST'; payload: { fromUserId: string; fromName: string } }
  | { type: 'PRESENTER_REQUEST_DENIED'; payload: { fromUserId: string } }
  | { type: 'TAKEOVER_ATTEMPT'; payload: { userId: string } }
  | { type: 'PRESENTER_CHANGED'; payload: { userId: string } }
  | { type: 'COMMENT_ADD'; payload: { comment: SpatialComment } }
  | { type: 'COMMENT_UPDATE'; payload: { id: string; updates: Partial<SpatialComment> } }
  | { type: 'COMMENT_DELETE'; payload: { id: string } }
  | { type: 'COMMENT_RESOLVE'; payload: { id: string } }
  | { type: 'COMMENT_ROSTER'; payload: { comments: SpatialComment[] } }
  | { type: 'WEBRTC_SIGNAL'; payload: { from: string; to: string; data: unknown } }
  | { type: 'LIVE_CHAT'; payload: LiveChatMessage }
  | { type: 'XR_PRESENCE'; payload: XRParticipantData }
  | { type: 'TRANSCRIPT_LINE'; payload: { id: string; agentId: string; text: string; timestamp: number; speakerName?: string; speakerId?: string; offsetMs?: number } }
  | { type: 'RECORDING_STATE'; payload: { recording: boolean; startedAt: number; byUserId: string; byName: string } }
  // Store this meeting's transcript on its session row. Host-only — the same rule
  // the Record button is offered under — and relayed to the room, because the
  // browser that ends the meeting is usually not the one that stopped the recording.
  | { type: 'TRANSCRIPT_KEEP'; payload: { keep: boolean; includePointing: boolean; byName: string } }
  | { type: 'POINTING_SEGMENT'; payload: { userId: string; userName: string; partId: string; partName: string; source: 'laser' | 'finger' | 'hover'; fromMs: number; toMs: number } }
  | { type: 'ADMIT'; payload: { userId: string } }
  | { type: 'DECLINE'; payload: { userId: string } }
  | { type: 'SET_JOIN_POLICY'; payload: { policy: 'open' | 'ask' } }
  | { type: 'JOIN_PENDING'; payload: Record<string, never> }
  | { type: 'JOIN_ADMITTED'; payload: Record<string, never> }
  | { type: 'JOIN_DECLINED'; payload: Record<string, never> }
  | { type: 'JOIN_REQUESTS'; payload: { pending: Array<{ userId: string; name: string; since: number; guest?: boolean }> } }
  | { type: 'JOIN_POLICY'; payload: { policy: 'open' | 'ask' } };

const PRESENTER_COOLDOWN = 1500; // ms — server-authoritative cooldown between presenter changes

// Where the admitted set is kept between restarts, and how many of the most
// recent admissions are worth keeping.
const ADMITTED_KEY = 'admitted-user-ids';
const MAX_PERSISTED_ADMISSIONS = 200;

// Where the on-screen model is kept between restarts. See persistCurrentModel
// for why this one is persisted when almost nothing else here is.
//
// Written by batch BA and no longer written now — a room that upgrades finds its
// model under this key and onStart translates it into a scene. Kept as a name so
// that translation has something to read.
const MODEL_KEY = 'current-model';

// Where the scene is kept between restarts, and with it who may change it.
const SCENE_KEY = 'room-scene';

/**
 * A persisted or received model reference, or null when it is not one.
 *
 * Strict in one deliberate direction: a room server that stored its model
 * BEFORE models were synced by reference wrote the base64 bytes into room
 * storage along with it. Restoring that record would replay up to 50 MB to
 * every connection that joins — the exact thing the reference shape exists to
 * stop — so a record carrying `fileBase64` is dropped rather than rescued. The
 * room comes back with no model and the next import puts one up, which is
 * recoverable; a partykit container that runs out of memory on restart is not.
 *
 * An 'imported' record with no hash is refused for the same reason: there would
 * be nothing for a client to fetch, so replaying it would tell every joiner to
 * render a model that does not exist.
 */
function asModelReference(value: unknown): ModelReference | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.fileBase64 === 'string') return null;
  const modelType = record.modelType;
  if (modelType !== 'synth' && modelType !== 'bicycle' && modelType !== 'imported') return null;
  const hash = typeof record.hash === 'string' && record.hash !== '' ? record.hash : undefined;
  if (modelType === 'imported' && !hash) return null;
  return {
    modelType,
    hash,
    fileName: typeof record.fileName === 'string' ? record.fileName : undefined,
    size: typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : undefined,
    // Read by sceneWire's own reader, so the value that reaches
    // sceneFromLegacyReference is one that reader already accepts. A string
    // nobody wrote is dropped rather than relayed, which leaves the reference
    // meaning 'source' — the file every client can already open.
    representation: asRepresentation(record.representation) ?? undefined,
  };
}

/**
 * How long one room believes what it read about its own line's status.
 *
 * REVIEW_FACTS_TTL_MS's number, for its reason: making a change to a review takes
 * effect in a room within a minute of somebody making it, and nobody drops a variant
 * mid-sentence. A room that has just been told its line is dropped keeps believing it
 * for longer than this in practice, because nothing un-drops a line.
 */
const LINE_STATUS_TTL_MS = 60_000;

/**
 * Whether one variant of one review has been dropped, read from PostgREST.
 *
 * docs/plan/15-sessions-and-variants.md batch BX. A dropped variant is kept on the
 * session map for the record, and its room name still resolves, so its room is still
 * reachable by an address somebody typed or a link they kept. Without this the room
 * server would go on applying, persisting and relaying scene changes there — and
 * lib/scene/keepPlacements would go on writing them into the review's saved positions
 * for a line nobody is exploring any more. The refusal belongs HERE rather than in the
 * browser, because a browser's refusal is one devtools panel away from not being one.
 *
 * The same read party/reviewRoles.ts makes, for the same two reasons: it is open to the
 * anon key (a participant's own screen renders the review's lines too, so this is not a
 * privileged channel), and it answers FALSE — "not dropped, carry on" — on any failure.
 * Fail-OPEN is the right direction for this one and is deliberately the opposite of
 * readReviewFacts' fail-closed: there, an unreadable roster would make a review's models
 * editable by whoever was standing in the room, while here an unreadable line status
 * costs one dropped variant's model being changeable for as long as PostgREST is down —
 * and a room server that refused every scene change whenever the database hiccuped would
 * turn an outage into a meeting nobody could hold.
 */
async function readLineDropped(
  restUrl: string,
  anonKey: string,
  reviewId: string,
  letter: string,
): Promise<boolean> {
  if (!reviewId || !letter || !anonKey) return false;
  try {
    const response = await fetch(
      `${restUrl}/review_lines?review_id=eq.${encodeURIComponent(reviewId)}` +
        `&letter=eq.${encodeURIComponent(letter)}&select=status`,
      { headers: { 'Authorization': `Bearer ${anonKey}`, 'apikey': anonKey } },
    );
    if (!response.ok) return false;
    const rows = await response.json();
    if (!Array.isArray(rows)) return false;
    // Read as "any row says dropped" rather than "the first row says dropped": a
    // review has at most one line per letter (unique (review_id, kind, letter)), so
    // this is one row in practice, and answering on any of them is the direction that
    // keeps a record a record.
    return rows.some((row) => (row as { status?: unknown }).status === 'dropped');
  } catch {
    // Unreachable, a runtime without fetch, a body that is not JSON, a database that
    // has not had review_lines at all. All of them are "carry on".
    return false;
  }
}

export default class RoomServer implements Party.Server {
  participants = new Map<string, ParticipantPresence>();
  // Ordered by first PRESENCE — index 0 is always the session host
  joinOrder: string[] = [];
  // Maps PartyKit connection ID → app userId (populated on first PRESENCE from that conn)
  connToUser = new Map<string, string>();
  // Server-authoritative presenter tracking (boardroom)
  boardroomLeaderId: string | null = null;
  lastPresenterChange = 0;
  // Takeover-mode policy — held server-side so late joiners get a consistent view
  takeoverModeEnabled = false;
  takeoverApprovedUserIds: string[] = [];
  // What is on screen: every model in the room's scene, each by reference (a
  // hash, a name, a line and a revision), plus which built-in is up when there
  // are none. Persisted to room storage (SCENE_KEY) so a restart does not drop
  // it, and relayed whole to every connection on every change. Never the bytes
  // — see ModelReference.
  //
  // Held HERE rather than on the clients, and changed only by an operation
  // applied to this copy, because the alternative is two people who each send
  // "the scene is this list" and the second one silently undoes the first: they
  // were both working from a list that was already out of date.
  scene: RoomScene = emptyScene();
  // Whether this room's scene has EVER been set. Persisted with the scene, and sent
  // with it, so a client can tell "a room somebody cleared" from "a room nobody has
  // put anything in yet" — which an empty list alone cannot say. The second one is a
  // room that should start from its design review's stored models, and a client that
  // may change the models is what puts them there (SCENE_SEED). Once true it stays
  // true: a room emptied on purpose must not be refilled from the database behind the
  // person who emptied it. See SceneStatePayload.seeded.
  sceneSeeded = false;
  // Who may change the models. Enforced here rather than only by hiding a
  // button: the websocket is the thing that has to say no, because a button
  // anybody can put back with devtools is not a permission.
  modelEditors: ModelEditors = 'host';
  // Persisted curated review config (viewpoints, pins, agenda…)
  reviewConfig: ReviewDraft | null = null;
  // Who has the review's Edit switch on, or null when nobody does.
  //
  // Held HERE rather than on the clients because "only one person edits at a
  // time" is a claim about the room, and a claim two clients each keep locally is
  // two claims that can disagree. The name is taken from `participants` — which
  // applyVerifiedIdentity has already vouched for — and never from the message
  // that asked, so one client cannot put somebody else's name on the banner.
  //
  // NOT persisted to room storage, unlike the scene and the admitted set: a
  // container restart drops the socket of whoever was editing too, so a room that
  // came back "being edited" by somebody who is no longer connected would be a
  // banner nobody could clear. Coming back with nobody editing is both the safe
  // answer and the true one.
  editing: { userId: string; name: string } | null = null;
  // Persisted spatial comments for late joiners
  comments: SpatialComment[] = [];
  // Whether the room is currently in boardroom mode — sent to late joiners
  isBoardroomMode = false;
  // Persisted recording state for late joiners (section B: per-speaker mics).
  // Null when no recording is in progress.
  recordingState: { recording: boolean; startedAt: number; byUserId: string; byName: string } | null = null;
  // Whether this meeting's transcript is to be stored on its session row, and
  // whether "where people were pointing at" is part of it (batch BU).
  //
  // Kept here rather than left to the client that chose it because the chooser and
  // the writer are not usually the same browser: one meeting is recorded once, by
  // whoever pressed End, and the button is pressed by whoever stopped the
  // recording. Null is the default and means "do not store it" — a room that never
  // saw the button records the meeting exactly as it did before.
  //
  // NOT persisted to room storage: the transcript it decides the fate of lives in
  // one browser's memory and dies with the page, so a room that came back holding
  // the choice would be a promise about a transcript nobody has any more.
  transcriptKeep: { keep: boolean; includePointing: boolean; byName: string } | null = null;
  // Per-link join policy. 'ask' (default) means new arrivals must be admitted
  // by the host; 'open' lets anyone through. NOT persisted to Supabase in
  // batch M2 — a PartyKit room that hibernates comes back at 'ask', which is
  // the safe direction.
  joinPolicy: 'open' | 'ask' = 'ask';
  // UserIds that have been admitted through the knock gate.
  admitted = new Set<string>();
  // Pending knock queue: userId → { userId, name, since }.
  pending = new Map<string, { userId: string; name: string; since: number; guest?: boolean }>();
  // Live connection objects keyed by connection id, for targeted sends.
  connections = new Map<string, Party.Connection>();
  // Connection ids that have already been told they are in and handed the
  // room state, so a reconnect gets it once and a chatty client does not
  // get the whole bundle on every PRESENCE.
  stateSent = new Set<string>();
  // Whether we have already logged that audit is not configured (ANON_KEY
  // empty). Logged once per server instance, not per admission.
  private auditNotConfiguredLogged = false;
  // Verified access tokens, per connection: the token string that was checked
  // and the promise that check produced. Presence arrives about ten times a
  // second and the answer only changes when the token does (a refresh, an hour
  // apart), so checking every frame would be an HMAC per frame per participant
  // for nothing. The PROMISE is what is cached, so two frames that arrive while
  // the first check is still in flight share one verification instead of
  // starting a second. Dropped in onClose: a closed connection's credential has
  // no business staying in memory.
  private verifiedTokens = new Map<
    string,
    { token: string; result: Promise<VerifiedAccount | null> }
  >();
  // What each connection's token PROVED, kept beside the token cache because the
  // presence payload it stamps is not the place to look for it later: that object
  // is relayed to everybody, and `isAdmin` is this server's business alone.
  // Populated only from a token this server verified, so it is never a claim a
  // client made. Dropped in onClose with the token it came from.
  private verifiedAccounts = new Map<string, { accountId: string; isAdmin: boolean }>();
  // The review's owner and roster, read from PostgREST with the anon key and
  // believed for sixty seconds. Lazily built, because a deployment on
  // identity.mode 'none' — the default install — must not make the room server
  // talk to a database it has no reason to. See party/reviewRoles.ts.
  private reviewFactsCache: ReviewFactsCache | null = null;
  // Whether we have already logged that a role lookup could not be made. Once per
  // server instance, like the audit and identity lines.
  private roleLookupNotConfiguredLogged = false;
  // Whether we have already logged that identity is switched on but cannot be
  // verified (JWT_SECRET empty). Once per server instance, like the audit line.
  private identityNotConfiguredLogged = false;
  // Whether we have already logged that a MODEL_CHANGE was dropped. Once per
  // server instance: an un-updated client sends one per import, and a room that
  // retries would otherwise fill the container's log with the same line.
  private modelChangeDropLogged = false;
  // Whether this room is on a line the review has dropped, and when it was last
  // asked. Cached with the same shape as ReviewFactsCache — the PROMISE, so two scene
  // changes arriving while the first read is in flight share one round trip — but not
  // with the same gate: dropping a variant is something the meeting host may do on the
  // default install, where identityRequired() is false and no roster is ever read, so
  // hanging this off the roster cache would have left exactly that install unprotected.
  // See readLineDropped for why a failure to read allows rather than refuses.
  private droppedLineCache: { at: number; promise: Promise<boolean> } | null = null;

  constructor(readonly room: Party.Room) {}

  /**
   * Admissions outlive a restart of this server.
   *
   * Everything else here is deliberately in-memory: a room that comes back
   * empty is a room nobody is in. The admitted set is different, because the
   * container is restarted for upgrades while meetings are running, and
   * without this the first person to reconnect becomes host and everyone else
   * lands back in the queue — the host re-admitting colleagues who never left
   * (seen live 2026-09-23: guest bounced to the waiting room, host shown
   * "Maria wants to join" for someone already in the meeting).
   *
   * onStart runs before the first connection, so the set is restored before
   * any knock is judged. Storage is per room and persisted to the volume the
   * compose file already mounts; if it is unavailable, every path below
   * behaves exactly as it did before, which is the pre-restart-safety
   * behaviour rather than a broken one.
   *
   * The join policy is NOT restored: it goes back to 'ask', which is the safe
   * direction, and a host who wanted an open link can say so again.
   *
   * The scene IS restored, for the same reason as the admitted set: an upgrade
   * restarts this container during a meeting, and a room that came back with
   * nobody's models in it would leave every reconnecting participant staring at
   * an empty canvas while the review carries on about a bracket. What is
   * restored is a hash, a name, a line and a revision per model — restoring it
   * costs one small read, and the bytes stay in the store they were uploaded to.
   *
   * A record written before models were synced by reference carries those bytes
   * inline and is dropped instead; see asModelReference. A record written by
   * batch BA, which held ONE model rather than a list, is translated into the
   * one-model scene it always meant, so a room that upgrades mid-review keeps
   * the model it was looking at.
   */
  async onStart() {
    try {
      const saved = await this.room.storage.get<string[]>(ADMITTED_KEY);
      if (Array.isArray(saved)) {
        for (const userId of saved) {
          if (typeof userId === 'string' && userId) this.admitted.add(userId);
        }
      }
    } catch {
      // No storage on this runtime — carry on with an empty set.
    }
    try {
      const saved = await this.room.storage.get(SCENE_KEY);
      if (typeof saved === 'object' && saved !== null) {
        const record = saved as Record<string, unknown>;
        const scene = asRoomScene(record);
        if (scene) {
          this.scene = scene;
          // 'host' when the record predates the setting, which is the default
          // and the safe direction: a room that comes back permissive is a room
          // where anybody can swap the product under discussion.
          this.modelEditors = asModelEditors(record.modelEditors) ?? 'host';
          // A record from a build that had no seed path infers the flag from what it
          // holds; see seededFromStorage.
          this.sceneSeeded = seededFromStorage(record, scene);
        }
      }
    } catch {
      // No storage on this runtime — the room comes back with no models, which
      // is what it did before, and the next import puts one up.
    }
    if (this.scene.models.length > 0 || this.scene.builtIn !== null) return;
    try {
      const legacy = asModelReference(await this.room.storage.get(MODEL_KEY));
      const translated = legacy ? sceneFromLegacyReference(legacy) : null;
      if (translated) {
        this.scene = translated;
        // A batch-BA record is a room that was holding a model, so it is not a room
        // waiting to be started from its review.
        this.sceneSeeded = true;
      }
    } catch {
      // Same as above: nothing to restore from, so the room starts empty.
    }
  }

  /**
   * Write the admitted set back. Fire-and-forget: an admission must not wait
   * on a disk write, and a failed write costs a re-admission after a restart,
   * not a broken room. Capped so a long-lived room cannot grow it without
   * bound; a Set keeps insertion order, so the oldest go first.
   */
  private persistAdmitted(): void {
    try {
      const ids = [...this.admitted].slice(-MAX_PERSISTED_ADMISSIONS);
      void this.room.storage.put(ADMITTED_KEY, ids).catch(() => {});
    } catch {
      // No storage on this runtime.
    }
  }

  /**
   * Write the scene, and who may change it, back — the way persistAdmitted does.
   *
   * Fire-and-forget for the same reason: a scene change must not wait on a disk
   * write, and a failed write costs a late joiner the models until somebody
   * changes the scene again, not a broken room. There is no cap to apply beyond
   * MAX_SCENE_MODELS, enforced on the way in, because there is nothing here that
   * grows on its own — this is a hash, a name, a line, a revision and a position
   * per model, which is the whole benefit of syncing by reference.
   */
  private persistScene(): void {
    try {
      void this.room.storage.put(SCENE_KEY, this.sceneStatePayload()).catch(() => {});
    } catch {
      // No storage on this runtime.
    }
  }

  /**
   * Drop a MODEL_CHANGE this room cannot use, and say why once.
   *
   * Once per server instance rather than once per message: an un-updated client
   * sends one of these per import, and a room where three people have not
   * reloaded would otherwise write the same line to the container's log every
   * time any of them touched the model button.
   */
  private dropModelChange(reason: string): void {
    if (this.modelChangeDropLogged) return;
    this.modelChangeDropLogged = true;
    console.log(`[room] dropped a MODEL_CHANGE: ${reason}`);
  }

  /** The scene, who may change it, and whether it was ever set — what SCENE_STATE carries and storage keeps. */
  private sceneStatePayload(): SceneStatePayload {
    return {
      models: this.scene.models,
      builtIn: this.scene.builtIn,
      modelEditors: this.modelEditors,
      seeded: this.sceneSeeded,
    };
  }

  /**
   * The review's owner and roster, cached — or null when this deployment has no
   * identities to look up.
   *
   * Built on first use rather than in onStart, so a room on the default install
   * (identity.mode 'none') never constructs one and never reads ANON_KEY for this.
   * The source is a FUNCTION of the cache's argument for the same reason: the
   * environment is read at lookup time, exactly as envValue does everywhere else
   * in this file.
   */
  private reviewFactsCacheFor(): ReviewFactsCache | null {
    if (!this.identityRequired()) return null;
    if (this.reviewFactsCache) return this.reviewFactsCache;

    const source = (): ReviewFactsSource | null => {
      const anonKey = this.envValue('ANON_KEY');
      if (!anonKey) {
        if (!this.roleLookupNotConfiguredLogged) {
          this.roleLookupNotConfiguredLogged = true;
          console.log(
            '[roles] ANON_KEY is not set — this room cannot read the review\'s ' +
              'members, so nobody in it is an owner or an editor and only the ' +
              '"who may change models" setting can allow a change',
          );
        }
        return null;
      }
      // PostgREST serves its tables at the ROOT, and `/rest/v1/` is the prefix
      // nginx-proxy rewrites away for the browser. The same fact the audit write
      // above depends on, and for the same reason: posting to the prefixed path
      // from inside the compose network is a 404.
      const restUrl = (this.envValue('REST_URL') || 'http://rest:3000').replace(/\/+$/, '');
      return { restUrl, anonKey };
    };

    // The review's roster, also in a variant's room (`<reviewId>~A`).
    this.reviewFactsCache = new ReviewFactsCache(reviewIdOfPartyRoom(this.room.id), source);
    return this.reviewFactsCache;
  }

  /**
   * The role this connection holds in the design review, or null when this
   * deployment has no roles.
   *
   * Null means "judge it the way batch BB did", which is the whole of the
   * compatibility story here: identity.mode 'none' never gets a role, so it keeps
   * the host-only rule it has always had, down to the refusal reason it is sent.
   *
   * The account comes from `verifiedAccounts`, which is populated only from a
   * token this server verified — never from a presence payload, which is why
   * applyVerifiedIdentity deletes the `accountId` a client claimed. A connection
   * whose token did not verify has no entry, resolves to 'guest', and may not
   * change the models.
   */
  private async roleFor(connId: string): Promise<Role | null> {
    const cache = this.reviewFactsCacheFor();
    if (!cache) return null;

    const account = this.verifiedAccounts.get(connId);
    const senderUserId = this.connToUser.get(connId) ?? null;
    const facts = await cache.get();
    return roleFromFacts(facts, {
      accountId: account?.accountId ?? null,
      isAdmin: account?.isAdmin === true,
      isMeetingHost: senderUserId !== null && senderUserId === this.computeHost(),
    });
  }

  /**
   * Whether this connection is still in the room, asked again after an await.
   *
   * The knock gate at the top of onMessage already answered this once, but
   * judging a scene change on a deployment with accounts can take a round trip to
   * the database the first time it is asked (party/reviewRoles.ts). In that window
   * the sender can disconnect, or be sent back to the waiting room by the host.
   * Their change must not land afterwards: an answer that was true when it was
   * asked is not an answer that is true now, and the room's scene is the one thing
   * here that everybody else is looking at.
   */
  private stillAdmitted(connId: string): boolean {
    const userId = this.connToUser.get(connId);
    return userId !== undefined && this.admitted.has(userId);
  }

  /**
   * The four facts both scene questions are decided from.
   *
   * Gathered here rather than answered here: the rule is ONE function,
   * lib/scene/roomScene.scenePermissions, and the browser asks that same function
   * about the same four facts before it disables a button. Two rules would be two
   * chances to disagree, and they did — an owner who was not the meeting host was
   * told "Import locked" by their own model tree while the server would have
   * allowed the change.
   */
  private async sceneAuthorityFor(connId: string): Promise<SceneAuthority> {
    return {
      // Null when this deployment has no identities to resolve a role from, which
      // is what makes scenePermissions fall back to batch BB's host rule.
      role: await this.roleFor(connId),
      modelEditors: this.modelEditors,
      userId: this.connToUser.get(connId) ?? null,
      hostId: this.computeHost(),
    };
  }

  /**
   * Whether this room is on a line the design review has DROPPED.
   *
   * One predicate, and every refusal that depends on it — a scene change, a seed, a
   * model import, who may change models, and the Edit lock — asks this rather than
   * reading a line row itself, so the six places cannot drift into six opinions about
   * whether the record in front of them is still live.
   *
   * Only a VARIANT room can answer true, and it answers without a read for a main-line
   * one: the room name carries the letter (`<reviewId>~A`, lib/reviews/lines.partyRoomName),
   * and a main line has no status to be dropped by. That is also what keeps the default
   * install and every ad-hoc room — no ANON_KEY, no review_lines, no database at all —
   * on the path they were on before, paying nothing.
   *
   * Believed for a minute, which is REVIEW_FACTS_TTL_MS's own number and the same shape
   * of trade: dropping a variant takes effect in its room within a minute of the meeting
   * doing it, and nobody drops a variant mid-sentence. A `true` is never wrong to keep
   * believing, because nothing un-drops a line.
   */
  private async droppedLine(): Promise<boolean> {
    const roomId = this.room.id ?? '';
    const cut = roomId.indexOf('~');
    if (cut === -1) return false;
    const reviewId = roomId.slice(0, cut);
    const letter = roomId.slice(cut + 1);
    if (!reviewId || !letter) return false;

    const cached = this.droppedLineCache;
    if (cached && Date.now() - cached.at < LINE_STATUS_TTL_MS) return cached.promise;

    const anonKey = this.envValue('ANON_KEY');
    if (!anonKey) return false;
    const restUrl = (this.envValue('REST_URL') || 'http://rest:3000').replace(/\/+$/, '');
    const promise = readLineDropped(restUrl, anonKey, reviewId, letter);
    this.droppedLineCache = { at: Date.now(), promise };
    return promise;
  }

  /** Why this connection may not change the models, or null when it may. */
  private async sceneRefusalFor(connId: string): Promise<SceneRefusalReason | null> {
    // The ROOM first, and before anybody's role is looked up: this is a fact about the
    // line the room is on rather than about the person asking, and answering it second
    // would tell the review's owner "only the host can change the models" in a room
    // where the real answer is that nobody can.
    if (await this.droppedLine()) return 'dropped-line';
    const { changeRefusal } = scenePermissions(await this.sceneAuthorityFor(connId));
    return changeRefusal;
  }

  /**
   * Tell ONE connection that its change was refused, and why.
   *
   * Targeted rather than relayed: the room does not need to hear that somebody
   * tried, and the person who tried needs to hear it or their screen would sit
   * there looking as though the click did nothing. Nothing else happens — the
   * scene is untouched, so there is no SCENE_STATE to send and no reason for
   * anybody else's screen to change.
   */
  private refuseScene(conn: Party.Connection, reason: SceneRefusalReason): void {
    conn.send(JSON.stringify({ type: 'SCENE_REFUSED', payload: { reason } } as RoomMessage));
  }

  /**
   * Apply one operation to this room's scene, then tell everybody the result.
   *
   * Relayed to the sender too, and that is the point of the design: there is one
   * copy of the list, it lives here, and every client — including the one that
   * asked for the change — learns what the scene now is from this message rather
   * than from its own optimistic guess. A client that was refused, or that asked
   * for something another client had already done, ends up correct either way.
   */
  private applySceneUpdate(update: SceneUpdate, sender: Party.Connection): void {
    if (update.op === 'add' && this.scene.models.length >= MAX_SCENE_MODELS) {
      this.refuseScene(sender, 'scene-full');
      return;
    }
    const next = reduceSceneUpdate(this.scene, update);
    // The reducer returns the same object when the operation changed nothing —
    // an unknown id, a duplicate add, a flag that already had that value. There
    // is then nothing to write and nothing to say: relaying a scene nobody's
    // copy differs from would redraw every participant's model tree for nothing.
    if (next === this.scene) return;
    this.scene = next;
    // Whatever this room was before, it is a room that has now held a scene.
    this.sceneSeeded = true;
    this.persistScene();
    this.relay(JSON.stringify({ type: 'SCENE_STATE', payload: this.sceneStatePayload() } as RoomMessage));
  }

  /**
   * Start a room that has NEVER held a scene from the one a client computed for it.
   *
   * The gap this closes: a room server sends its scene on connect even when it is
   * empty, and the client replaces its own with what arrives — batch BB's rule, and
   * the right one for a room that is the live space. But a brand new variant room has
   * never held anything, and neither has a main room whose server storage is gone, so
   * "empty" arrived as an order rather than as an absence, and the models the review
   * has in its history were wiped off the client that had just built them. Nothing
   * ever put them back: the variant of a review with two imported models showed "No
   * model yet", and went on showing it after a reload.
   *
   * So the flag travels with the scene, and an unseeded room is a room that asks. The
   * asking is answered by a client that may change the models — the SAME permission
   * SCENE_UPDATE is judged by, because a seed is a scene change that happens to be the
   * first one, and a participant who could put a model up by joining an empty room
   * could put one up at all. It is accepted once, because the point of the flag is that
   * the room's first scene is a fact about the room rather than about whoever asked
   * last; later seeds are refused with a reason the client drops without showing it.
   *
   * The payload is rebuilt field by field like every other one (lib/scene/sceneWire),
   * capped like an `add`, and an empty offer is ignored rather than accepted: a client
   * whose read of the review came back with nothing has not seeded the room, and one
   * that can answer better must still be able to.
   */
  private async seedScene(payload: unknown, sender: Party.Connection): Promise<void> {
    if (this.sceneSeeded) {
      this.refuseScene(sender, 'already_seeded');
      return;
    }
    const refusal = await this.sceneRefusalFor(sender.id);
    if (refusal) {
      this.refuseScene(sender, refusal);
      return;
    }
    if (!this.stillAdmitted(sender.id)) return;
    // Asked again, and here it matters: judging the sender can take a round trip to the
    // database the first time, and two people opening the same empty variant room at
    // the same moment both offer its review's models. The first one in wins and the
    // second is told — its own screen is then corrected by the SCENE_STATE the winner
    // caused, which is relayed to everybody including them.
    if (this.sceneSeeded) {
      this.refuseScene(sender, 'already_seeded');
      return;
    }
    const scene = asRoomScene(payload);
    if (!scene) {
      this.refuseScene(sender, 'unreadable-update');
      return;
    }
    if (scene.models.length === 0 && scene.builtIn === null) return;
    this.scene = { models: scene.models.slice(0, MAX_SCENE_MODELS), builtIn: scene.builtIn };
    this.sceneSeeded = true;
    this.persistScene();
    this.relay(JSON.stringify({ type: 'SCENE_STATE', payload: this.sceneStatePayload() } as RoomMessage));
  }

  private computeHost(): string | null {
    return this.joinOrder[0] ?? null;
  }

  private boardroomStatePayload() {
    return {
      active: this.isBoardroomMode,
      leaderId: this.boardroomLeaderId,
      takeover: {
        enabled: this.takeoverModeEnabled,
        approvedUserIds: this.takeoverApprovedUserIds,
      },
    };
  }

  private resetBoardroomState() {
    this.isBoardroomMode = false;
    this.boardroomLeaderId = null;
    this.takeoverModeEnabled = false;
    this.takeoverApprovedUserIds = [];
    this.lastPresenterChange = 0;
  }

  // ─── Editing the review ─────────────────────────────────────────────────────

  private editingStatePayload() {
    return {
      editorUserId: this.editing?.userId ?? null,
      editorName: this.editing?.name ?? null,
    };
  }

  /**
   * Whether this connection may turn Edit on.
   *
   * The same two-rule shape as sceneRefusalFor, because it is the same question
   * asked about a different tool. WITHOUT accounts the meeting host may edit and
   * nobody else can — which is exactly what the old curate page amounted to once
   * it moved into the room, and the same answer HOST_CHANGE already gave the
   * client, so the button it hides and the refusal here are one judgement made
   * twice rather than two that can disagree. WITH accounts it is the person's
   * role in the review: owners and editors, not participants and not guests.
   *
   * Async because the first ask on a deployment with accounts reads the roster
   * (party/reviewRoles.ts). Callers re-check stillAdmitted afterwards, as the
   * scene path does, for the same reason.
   */
  private async mayEditReview(connId: string): Promise<boolean> {
    const userId = this.connToUser.get(connId);
    const role = await this.roleFor(connId);
    if (role === null) {
      return userId !== undefined && userId === this.computeHost();
    }
    return can(role, 'editReview');
  }

  /**
   * Whether this connection may record the meeting — and so may decide what happens
   * to its transcript.
   *
   * The server's half of RecordingContext's `canRecord`, which is
   * `isHost && captureProvider !== 'mock'`. Only the host half is answerable here:
   * which capture provider a deployment configured is client config this server does
   * not hold, and a deployment on 'mock' never records at all, so it never sends the
   * message either. What is left is the half worth enforcing — a guest or a
   * participant who crafts a TRANSCRIPT_KEEP frame must not be able to decide that a
   * meeting's transcript is stored on the review's session row, where every person
   * who can open the map can later read and download it.
   */
  private mayRecordMeeting(connId: string): boolean {
    const userId = this.connToUser.get(connId);
    return userId !== undefined && userId === this.computeHost();
  }

  /**
   * Turn Edit on for this connection, or say why it cannot.
   *
   * ONE editor at a time, and the room is told who. A second owner or editor who
   * presses Edit while somebody else is editing is refused with that person's
   * name, so what they see is "Robin is editing — ask them, or take over" rather
   * than a button that appears to do nothing. Taking over is then their explicit
   * second act: the first editor is told by name that it happened, because
   * silently dropping somebody out of edit mode mid-drag is how two people end up
   * fighting over the same model without either knowing why.
   *
   * EDITING_STATE is relayed to the sender too — as SCENE_STATE is — so the
   * client's own edit mode is something the room confirmed rather than something
   * it assumed.
   */
  private async startEditing(conn: Party.Connection, force: boolean): Promise<void> {
    const userId = this.connToUser.get(conn.id);
    if (!userId) return;

    // The room's own line first, and before this person's role: a dropped variant is a
    // record, and this server is the one place that hands out the Edit lock, so handing
    // it out here would be an offer the room cannot honour — the lock would turn on, the
    // tools would appear, and every change made with them would then be refused by
    // sceneRefusalFor. `force` is not an answer to it either, because taking the lock
    // away from a colleague is a different question from whether there is a lock to give.
    if (await this.droppedLine()) {
      conn.send(JSON.stringify({
        type: 'EDITING_REFUSED',
        payload: { reason: 'dropped', editorName: null },
      } as RoomMessage));
      return;
    }

    if (!(await this.mayEditReview(conn.id))) {
      conn.send(JSON.stringify({
        type: 'EDITING_REFUSED',
        payload: { reason: 'role', editorName: this.editing?.name ?? null },
      } as RoomMessage));
      return;
    }
    // Asked again: judging it can take a round trip, and a person who left the
    // room during it must not turn Edit on afterwards. See stillAdmitted.
    if (!this.stillAdmitted(conn.id)) return;

    const current = this.editing;
    if (current && current.userId !== userId) {
      if (!force) {
        conn.send(JSON.stringify({
          type: 'EDITING_REFUSED',
          payload: { reason: 'busy', editorName: current.name },
        } as RoomMessage));
        return;
      }
      // Told to the person being displaced, and only to them: the room hears
      // about it through the EDITING_STATE that follows, which already carries
      // the new editor's name.
      this.sendToUser(current.userId, {
        type: 'EDITING_TAKEN_OVER',
        payload: { byName: this.participants.get(userId)?.name ?? 'Somebody' },
      });
    }

    this.editing = { userId, name: this.participants.get(userId)?.name ?? '' };
    this.audit('review_editing', { actorName: this.editing.name, actorId: userId, detail: force ? 'takeover' : 'start' });
    this.relay(JSON.stringify({ type: 'EDITING_STATE', payload: this.editingStatePayload() } as RoomMessage));
  }

  /**
   * Turn Edit off.
   *
   * Only the person editing can stop it, which is what makes a stray or replayed
   * EDITING_STOP from somebody else unable to end a colleague's session. A stop
   * from anyone else does not change the lock, but the sender is told who holds it:
   * a browser that believes it is editing when it is not (found live, 2026-09-26 —
   * it left a room mid-edit and carried the flag into the next one) pressed Done
   * and heard nothing, so Done looked broken. The answer goes to that connection
   * only; the room hears nothing.
   */
  private stopEditing(conn: Party.Connection): void {
    const userId = this.connToUser.get(conn.id);
    if (!userId || this.editing?.userId !== userId) {
      conn.send(JSON.stringify({ type: 'EDITING_STATE', payload: this.editingStatePayload() } as RoomMessage));
      return;
    }
    this.clearEditing();
  }

  /** Release the lock and tell the room, including whoever held it. */
  private clearEditing(): void {
    if (!this.editing) return;
    this.editing = null;
    this.relay(JSON.stringify({ type: 'EDITING_STATE', payload: this.editingStatePayload() } as RoomMessage));
  }

  private sendRoomState(conn: Party.Connection) {
    conn.send(JSON.stringify({
      type: 'ROSTER',
      payload: Array.from(this.participants.values()),
    } as RoomMessage));
    conn.send(JSON.stringify({
      type: 'HOST_CHANGE',
      payload: { hostId: this.computeHost() },
    } as RoomMessage));
    // The scene always goes, even when it is empty: it carries `modelEditors`
    // too, and a participant who arrives before anybody has imported anything
    // still needs to know whether the import button is theirs to press. Empty AND
    // never seeded is also how a room asks a client to start it from its design
    // review's stored models — see seedScene.
    conn.send(JSON.stringify({
      type: 'SCENE_STATE',
      payload: this.sceneStatePayload(),
    } as RoomMessage));
    if (this.reviewConfig) {
      conn.send(JSON.stringify({ type: 'REVIEW_CONFIG', payload: { config: this.reviewConfig } } as RoomMessage));
    }
    // Only while somebody is editing. An arrival who got no EDITING_STATE is in a
    // room nobody is editing, which is the state the client starts in anyway, so
    // the common case sends nothing at all.
    if (this.editing) {
      conn.send(JSON.stringify({ type: 'EDITING_STATE', payload: this.editingStatePayload() } as RoomMessage));
    }
    conn.send(JSON.stringify({ type: 'COMMENT_ROSTER', payload: { comments: this.comments } } as RoomMessage));
    conn.send(JSON.stringify({
      type: 'BOARDROOM_STATE',
      payload: this.boardroomStatePayload(),
    } as RoomMessage));
    if (this.recordingState) {
      conn.send(JSON.stringify({
        type: 'RECORDING_STATE',
        payload: this.recordingState,
      } as RoomMessage));
    }
    // The transcript choice, for a browser that arrives after it was made. Without
    // this the host's own reload between Stop and End would silently drop it, and
    // "saved with this meeting" would have been a promise the room forgot.
    if (this.transcriptKeep) {
      conn.send(JSON.stringify({
        type: 'TRANSCRIPT_KEEP',
        payload: this.transcriptKeep,
      } as RoomMessage));
    }
  }

  /**
   * Relay to the room — admitted connections only.
   *
   * `room.broadcast` reaches every open socket, which quietly undoes the gate:
   * a person parked at the door was receiving other people's PRESENCE, and by
   * the same route would have received the live transcript, the comments and
   * the pointing segments of a meeting nobody had let them into (found live
   * 2026-09-23 by reading the guest's websocket frames). Every relay goes
   * through here instead, so admission is the single thing that decides what
   * leaves the server. The only exception is JOIN_POLICY, which is not room
   * content and which the waiting room itself describes.
   */
  private relay(data: string, without: string[] = []) {
    const excluded = [...without];
    for (const connId of this.connections.keys()) {
      const uid = this.connToUser.get(connId);
      if (!uid || !this.admitted.has(uid)) excluded.push(connId);
    }
    this.room.broadcast(data, excluded);
  }

  private broadcastJoinRequests() {
    const list = Array.from(this.pending.values());
    const hostId = this.computeHost();
    if (!hostId) return;
    for (const [connId, userId] of this.connToUser) {
      if (userId === hostId && this.admitted.has(userId)) {
        const conn = this.connections.get(connId);
        if (conn) {
          conn.send(JSON.stringify({
            type: 'JOIN_REQUESTS',
            payload: { pending: list },
          } as RoomMessage));
        }
      }
    }
  }

  private sendToUser(userId: string, msg: RoomMessage) {
    const json = JSON.stringify(msg);
    for (const [connId, uid] of this.connToUser) {
      if (uid === userId) {
        const conn = this.connections.get(connId);
        if (conn) conn.send(json);
      }
    }
  }

  /**
   * Tell every connection of an admitted userId that it is in, and hand it the
   * room state — once per connection. JOIN_ADMITTED goes first so the client
   * can leave the waiting room before the state arrives.
   *
   * Every admitted connection must hear this, not just a brand new
   * participant: a reload or a dropped socket reconnects with the same userId,
   * which is already in `admitted`, and the client's join state starts again at
   * 'joining' on the new socket. Without this the host who refreshes their own
   * room sits on "Connecting…" for ever (found live 2026-09-23).
   */
  private deliverAdmission(userId: string) {
    for (const [connId, uid] of this.connToUser) {
      if (uid !== userId || this.stateSent.has(connId)) continue;
      const conn = this.connections.get(connId);
      if (!conn) continue;
      this.stateSent.add(connId);
      conn.send(JSON.stringify({ type: 'JOIN_ADMITTED', payload: {} } as RoomMessage));
      this.sendRoomState(conn);
    }
  }

  /**
   * Record a grant event (admission, decline, policy change) to the audit
   * table via PostgREST. Fire-and-forget: a failed write must never delay or
   * block an admission. When ANON_KEY is empty, skip silently (one log line
   * per server instance, not per event).
   */
  private audit(
    action: string,
    fields: {
      actorName?: string;
      actorId?: string;
      subjectName?: string;
      subjectId?: string;
      detail?: string;
    },
  ): void {
    const anonKey = this.envValue('ANON_KEY');
    if (!anonKey) {
      if (!this.auditNotConfiguredLogged) {
        this.auditNotConfiguredLogged = true;
        console.log('[audit] ANON_KEY not set — audit log disabled for this room server');
      }
      return;
    }
    // PostgREST serves its tables at the ROOT. `/rest/v1/` is the prefix
    // nginx-proxy rewrites away for the browser, and posting to it from
    // inside the compose network is a 404 — which a fire-and-forget write
    // would have swallowed for ever (checked against the running container).
    const restUrl = (this.envValue('REST_URL') || 'http://rest:3000').replace(/\/+$/, '');
    try {
      void fetch(`${restUrl}/audit_events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${anonKey}`,
          'apikey': anonKey,
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          action,
          room_id: this.room.id,
          actor_name: fields.actorName ?? '',
          actor_id: fields.actorId ?? '',
          subject_name: fields.subjectName ?? '',
          subject_id: fields.subjectId ?? '',
          detail: fields.detail ?? '',
        }),
      }).catch(() => {});
    } catch {
      // Synchronous throw from fetch (network down, stub in tests): swallow.
    }
  }

  /**
   * A variable this room server was started with.
   *
   * `room.env`, not `process.env`: room code runs inside workerd, which does
   * not inherit the container's environment. PartyKit puts `--var` values here
   * (deploy/partykit-entrypoint.sh passes them). process.env stays as a
   * fallback for tests and for any runtime that does populate it.
   */
  private envValue(name: string): string | undefined {
    const fromRoom = this.room.env?.[name];
    return typeof fromRoom === 'string' ? fromRoom : process.env[name];
  }

  /**
   * Whether this deployment asks the room server to prove who people are.
   *
   * Anything other than 'none' counts as on, including a value this code has
   * never heard of: a typo in .env should cost an operator a room full of
   * "(guest)" labels they come and ask about, not silently go back to trusting
   * typed names. docker-compose.yml defaults the variable to 'none', so a
   * deployment that never set it gets exactly the pre-identity behaviour.
   */
  private identityRequired(): boolean {
    const mode = this.envValue('IDENTITY_MODE');
    return Boolean(mode) && mode !== 'none';
  }

  /**
   * The verification for one connection's current token, computed at most once
   * per distinct token string. See `verifiedTokens` for why.
   */
  private verifiedToken(
    connId: string,
    token: string,
    secret: string,
  ): Promise<VerifiedAccount | null> {
    const cached = this.verifiedTokens.get(connId);
    if (cached && cached.token === token) return cached.result;
    const result = verifyAccessToken(token, secret);
    this.verifiedTokens.set(connId, { token, result });
    return result;
  }

  /**
   * Replace the self-asserted half of a PRESENCE payload with what a verified
   * access token proves, and remove the token itself.
   *
   * Mutates the payload in place, and that is the whole point: this object is
   * what the handler parsed, and every read of it below — the participants map,
   * the knock queue, the ROSTER a late joiner is handed, the relay to everyone
   * else — happens after this returns. There is therefore no path by which the
   * token reaches another client or the room's persisted storage, and no path
   * by which a name the server did not vouch for is relayed as though it had.
   *
   * The token is deleted on EVERY path, identity 'none' and a payload that
   * carried no token included: dropping a credential because the server
   * happens not to need it is how it ends up relayed by the next change to
   * this file. `accountId` goes the same way, for the same reason — it is
   * stamped here and only from a token this server verified, so a value a
   * client claimed for itself is never handed to anybody else.
   *
   * Returns null rather than a resolved promise when there is nothing to
   * check. `await` on an already-resolved promise still defers the rest of the
   * handler by a microtask, and a room server that relayed every presence of
   * every default install one tick later than it received it would be paying
   * for a feature that is switched off.
   */
  private applyVerifiedIdentity(
    connId: string,
    payload: ParticipantPresence,
  ): Promise<void> | null {
    const raw = payload.accessToken;
    const token = typeof raw === 'string' && raw !== '' ? raw : undefined;
    delete payload.accessToken;
    delete payload.accountId;
    // Cleared on every presence, and only re-set below from a token that verified
    // on THIS one: a session that expires mid-meeting must stop conferring the
    // owner's powers on the next message, and a cached token verdict is keyed by
    // the token string so a refresh re-verifies anyway.
    this.verifiedAccounts.delete(connId);

    if (!this.identityRequired()) return null;

    const secret = this.envValue('JWT_SECRET');
    if (!secret) {
      // Fail closed, and say so once: everybody in the room reads as a guest
      // until the operator wires the secret through, which is visible in the
      // participant list rather than hidden in a room that looks fine.
      if (!this.identityNotConfiguredLogged) {
        this.identityNotConfiguredLogged = true;
        console.log(
          '[identity] IDENTITY_MODE is set but JWT_SECRET is not — ' +
            'no access token can be verified, so every participant is marked as a guest',
        );
      }
      payload.guest = true;
      return null;
    }

    if (!token) {
      payload.guest = true;
      return null;
    }

    return this.verifiedToken(connId, token, secret).then((verified) => {
      if (!verified) {
        // Expired, forged, or for another audience. The person keeps the name
        // they typed and is marked as a guest, which is what the host's knock
        // prompt and the participant list already render as "not proven".
        payload.guest = true;
        return;
      }
      payload.name = verified.name;
      payload.guest = false;
      payload.accountId = verified.sub;
      // And the role this server will judge their scene changes by. Kept here
      // rather than on the payload: `isAdmin` is a permission, and the payload is
      // relayed to everybody in the room.
      this.verifiedAccounts.set(connId, {
        accountId: verified.sub,
        isAdmin: verified.role === 'admin',
      });
    });
  }

  onConnect(conn: Party.Connection) {
    this.connections.set(conn.id, conn);
    // Before the connection has identified itself via PRESENCE we can only
    // send the current join policy. The full room state bundle is deferred
    // until the connection is admitted through the knock gate.
    conn.send(JSON.stringify({
      type: 'JOIN_POLICY',
      payload: { policy: this.joinPolicy },
    } as RoomMessage));
  }

  async onMessage(message: string, sender: Party.Connection): Promise<void> {
    let msg: RoomMessage;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    // Map the connection to its userId early so the gate and onClose agree.
    // PRESENCE is the only message that establishes this mapping; LEAVE only
    // needs it for cleanup, and is also allowed through the gate.
    if (msg.type === 'PRESENCE') {
      this.connToUser.set(sender.id, msg.payload.userId);
      // Who this connection really is, settled BEFORE anything reads the
      // payload: the knock queue, the roster and every relay below must see a
      // name the server vouched for, and none of them may ever see the token
      // that proved it. Awaited only when there was something to verify — see
      // applyVerifiedIdentity for why every other path stays synchronous.
      const verification = this.applyVerifiedIdentity(sender.id, msg.payload);
      if (verification) await verification;
    }

    // Knock gate: a connection that has not been admitted may only send
    // PRESENCE (the knock itself) and LEAVE. Everything else is dropped.
    const senderUserId = this.connToUser.get(sender.id);
    if (senderUserId && !this.admitted.has(senderUserId) && msg.type !== 'PRESENCE' && msg.type !== 'LEAVE') {
      return;
    }

    if (msg.type === 'PRESENCE') {
      const { userId, name } = msg.payload;

      // Already admitted — normal presence update, relay to others.
      if (this.admitted.has(userId)) {
        const isNew = !this.participants.has(userId);
        this.participants.set(userId, msg.payload);

        // A reconnecting connection (reload, dropped socket) is admitted
        // already but has been told nothing yet. No-op once it has.
        this.deliverAdmission(userId);

        if (isNew) {
          this.joinOrder.push(userId);
          this.relay(JSON.stringify({
            type: 'HOST_CHANGE',
            payload: { hostId: this.computeHost() },
          } as RoomMessage));
        }

        this.relay(JSON.stringify(msg), [sender.id]);
        return;
      }

      // Not yet admitted — apply the knock-gate rules.

      // Expire stale pending entries (older than 5 minutes) while we're here.
      const now = Date.now();
      for (const [pid, entry] of this.pending) {
        if (now - entry.since > 5 * 60 * 1000) {
          this.pending.delete(pid);
        }
      }

      // Rule 1: open policy → admit immediately.
      // Rule 2: nobody is in the room → admit immediately, and this userId
      //         becomes the host (it is first in joinOrder). Two cases, one
      //         rule: the very first arrival has nobody to ask, and a waiter
      //         whose host closed the tab would otherwise wait forever.
      //         Keyed on live participants, NOT on `admitted` — that set keeps
      //         past admissions so a reload does not need re-admitting, and so
      //         it never empties.
      if (this.joinPolicy === 'open' || this.participants.size === 0) {
        this.admitted.add(userId);
        this.persistAdmitted();
        this.pending.delete(userId);

        // Now treat this as a normal first PRESENCE for an admitted user.
        const isNew = !this.participants.has(userId);
        this.participants.set(userId, msg.payload);

        if (isNew) {
          this.joinOrder.push(userId);
        }

        this.deliverAdmission(userId);

        // Broadcast presence to the rest of the room (normal join).
        this.relay(JSON.stringify(msg), [sender.id]);

        if (isNew) {
          this.relay(JSON.stringify({
            type: 'HOST_CHANGE',
            payload: { hostId: this.computeHost() },
          } as RoomMessage));
        }

        // If the queue changed, tell the host.
        this.broadcastJoinRequests();
        return;
      }

      // Rule 3: park in pending. Idempotent — only notify the host when the
      // entry is new or what the knock prompt shows them changed.
      const guest = msg.payload.guest === true;
      const existing = this.pending.get(userId);
      if (!existing || existing.name !== name || (existing.guest ?? false) !== guest) {
        this.pending.set(userId, { userId, name, since: existing?.since ?? now, guest });
        this.sendToUser(userId, { type: 'JOIN_PENDING', payload: {} });
        this.broadcastJoinRequests();
      }

    } else if (msg.type === 'ADMIT') {
      // Host-only: admit a pending userId.
      const senderId = this.connToUser.get(sender.id);
      if (senderId !== this.computeHost() || !this.admitted.has(senderId)) return;

      const { userId } = msg.payload;
      const pendingEntry = this.pending.get(userId);
      if (!pendingEntry) return;
      const subjectName = pendingEntry.name;
      this.pending.delete(userId);
      this.admitted.add(userId);
      this.persistAdmitted();

      this.deliverAdmission(userId);

      // Audit: host admitted someone.
      const hostPresence = this.participants.get(senderId);
      this.audit('admitted', {
        actorName: hostPresence?.name ?? '',
        actorId: senderId,
        subjectName,
        subjectId: userId,
      });

      // Broadcast a synthetic PRESENCE so the room sees the new participant.
      // We don't have the full presence payload here, but the newly admitted
      // client will send its own PRESENCE on the next animation frame.
      this.broadcastJoinRequests();

    } else if (msg.type === 'DECLINE') {
      // Host-only: decline a pending userId.
      const senderId = this.connToUser.get(sender.id);
      if (senderId !== this.computeHost() || !this.admitted.has(senderId)) return;

      const { userId } = msg.payload;
      const pendingEntry = this.pending.get(userId);
      if (!pendingEntry) return;
      const subjectName = pendingEntry.name;
      this.pending.delete(userId);

      // Audit: host declined someone.
      const hostPresence = this.participants.get(senderId);
      this.audit('declined', {
        actorName: hostPresence?.name ?? '',
        actorId: senderId,
        subjectName,
        subjectId: userId,
      });

      this.sendToUser(userId, { type: 'JOIN_DECLINED', payload: {} });
      this.broadcastJoinRequests();

    } else if (msg.type === 'SET_JOIN_POLICY') {
      // Host-only: change the join policy.
      const senderId = this.connToUser.get(sender.id);
      if (senderId !== this.computeHost() || !this.admitted.has(senderId)) return;

      this.joinPolicy = msg.payload.policy;

      // Audit: host changed the join policy.
      const hostPresence = this.participants.get(senderId);
      this.audit('join_policy', {
        actorName: hostPresence?.name ?? '',
        actorId: senderId,
        detail: this.joinPolicy,
      });

      // Switching to 'open' drains the queue — admit everyone pending.
      if (this.joinPolicy === 'open') {
        for (const [userId] of this.pending) {
          this.pending.delete(userId);
          this.admitted.add(userId);
          this.persistAdmitted();
          this.deliverAdmission(userId);
        }
      }

      // Everyone, waiters included: the policy is what the waiting room and
      // the invite popup describe, and it is not room content.
      this.room.broadcast(JSON.stringify({
        type: 'JOIN_POLICY',
        payload: { policy: this.joinPolicy },
      } as RoomMessage));
      this.broadcastJoinRequests();

    } else if (msg.type === 'HOST_TRANSFER') {
      // Move target to front of join order → they become new host
      const { toUserId } = msg.payload;
      this.joinOrder = [toUserId, ...this.joinOrder.filter(id => id !== toUserId)];
      this.relay(JSON.stringify({
        type: 'HOST_CHANGE',
        payload: { hostId: this.computeHost() },
      } as RoomMessage));

    } else if (msg.type === 'LEADER_TAKEOVER') {
      // Host-initiated presenter change (or accepted request). Authoritative on the
      // server so the sender + every other client end up agreeing on the leader.
      const { userId } = msg.payload;
      // Allow only if the requested user is actually a known participant — guards
      // against stale UI clicks for users who just left.
      if (!this.participants.has(userId)) return;
      this.boardroomLeaderId = userId;
      this.lastPresenterChange = Date.now();
      // Broadcast to ALL connections (no exclude) so the sender's UI updates too.
      this.relay(JSON.stringify(msg));

    } else if (msg.type === 'TAKEOVER_ATTEMPT') {
      // Server validates cooldown + approval and broadcasts authoritative
      // PRESENTER_CHANGED to ALL clients (including the attempter).
      const now = Date.now();
      const { userId } = msg.payload;
      if (
        this.takeoverModeEnabled &&
        this.takeoverApprovedUserIds.includes(userId) &&
        this.participants.has(userId) &&
        userId !== this.boardroomLeaderId &&
        now - this.lastPresenterChange > PRESENTER_COOLDOWN
      ) {
        this.boardroomLeaderId = userId;
        this.lastPresenterChange = now;
        this.relay(JSON.stringify({
          type: 'PRESENTER_CHANGED',
          payload: { userId },
        } as RoomMessage));
      }
      // If gated out (cooldown, not approved, already presenter), silently ignore

    } else if (msg.type === 'TAKEOVER_SYNC') {
      // Host-driven policy update. Persist on the server so late joiners and
      // re-entries see a consistent state, and prune stale userIds.
      const { enabled, approvedUserIds } = msg.payload;
      this.takeoverModeEnabled = enabled;
      this.takeoverApprovedUserIds = approvedUserIds.filter(id => this.participants.has(id));
      // Echo the pruned list to everyone so clients stay in lock-step
      this.relay(JSON.stringify({
        type: 'TAKEOVER_SYNC',
        payload: { enabled: this.takeoverModeEnabled, approvedUserIds: this.takeoverApprovedUserIds },
      } as RoomMessage));

    } else if (msg.type === 'SCENE_UPDATE') {
      // The room's scene, changed by one operation rather than replaced by one
      // list. Validated first: this payload came from a browser and is about to
      // be written into room state, into persisted storage, and out to every
      // other connection, so a field this server has never heard of must not be
      // able to ride along.
      const refusal = await this.sceneRefusalFor(sender.id);
      if (refusal) {
        this.refuseScene(sender, refusal);
        return;
      }
      // Asked again, because judging it may have taken a round trip and the
      // sender may no longer be in the room. See stillAdmitted.
      if (!this.stillAdmitted(sender.id)) return;
      const update = asSceneUpdate(msg.payload);
      if (!update) {
        this.refuseScene(sender, 'unreadable-update');
        return;
      }
      this.applySceneUpdate(update, sender);

    } else if (msg.type === 'SCENE_SEED') {
      // A client answering the "this room has never held a scene" that its own
      // SCENE_STATE carried. Judged, validated and applied in one place; see seedScene.
      await this.seedScene(msg.payload, sender);

    } else if (msg.type === 'SET_MODEL_EDITORS') {
      // A step above the scene itself: whoever may change the models decides what
      // everybody else's import button does, so letting somebody without the
      // right set it would have been letting them grant themselves that right.
      //
      // The right is scenePermissions' other answer — the meeting host WITHOUT
      // accounts, the review's owners and editors WITH them, exactly as the same
      // function tells the browser. lib/reviews/roles.ts's `setModelEditors` is
      // the row that says so.
      const senderId = this.connToUser.get(sender.id);
      // A dropped line's room has no models anybody may change, so there is no
      // setting to choose the people who may. Refused with the room's own reason
      // rather than with a role one, for the reason sceneRefusalFor gives.
      if (await this.droppedLine()) {
        this.refuseScene(sender, 'dropped-line');
        return;
      }
      const authority = await this.sceneAuthorityFor(sender.id);
      const { editorsRefusal } = scenePermissions(authority);
      // Admission is a fact about this connection rather than a rule about who
      // may do what, so it stays here — and it is only the no-accounts branch
      // that ever asked it, which is where batch BB put it.
      const notAdmitted: SceneRefusalReason | null =
        authority.role === null && senderId !== undefined && !this.admitted.has(senderId)
          ? 'host-only-setting'
          : null;
      const refusal = editorsRefusal ?? notAdmitted;
      if (refusal) {
        this.refuseScene(sender, refusal);
        return;
      }
      if (!this.stillAdmitted(sender.id)) return;
      const editors = asModelEditors(msg.payload.modelEditors);
      if (!editors) {
        this.refuseScene(sender, 'unreadable-update');
        return;
      }
      this.modelEditors = editors;
      this.persistScene();
      this.audit('model_editors', {
        actorName: this.participants.get(senderId)?.name ?? '',
        actorId: senderId,
        detail: Array.isArray(editors) ? `named:${editors.length}` : editors,
      });
      this.relay(JSON.stringify({
        type: 'SCENE_STATE',
        payload: this.sceneStatePayload(),
      } as RoomMessage));

    } else if (msg.type === 'MODEL_CHANGE') {
      // A client that has not been updated still sends the file itself. Dropped
      // rather than relayed or stored: this server keeps the scene in memory and
      // replays it to every connection that joins, so accepting it would put up
      // to 50 MB per import back on exactly the path the reference shape
      // removed. Nothing the sender can see breaks — their own screen already
      // shows the model they imported — and the line in the log names the cause.
      if (typeof msg.payload.fileBase64 === 'string') {
        this.dropModelChange(
          'it carried fileBase64, which means that client has not been updated. ' +
            'Models travel as a hash now (docs/plan/14-rooms-models-admin-ai.md).',
        );
        return;
      }
      // Validated, and then rebuilt rather than stored as received: a field this
      // handler has never heard of must not be able to ride into room state,
      // into persisted storage, or out to every other connection.
      const reference = asModelReference(msg.payload);
      if (!reference) {
        this.dropModelChange('it was not a model reference this server could read.');
        return;
      }
      // Permission is checked on the translated change, not waived because the
      // message arrived in the old shape: an un-updated client is still a client,
      // and "who may change models" would mean nothing to one that had not
      // reloaded since the setting was introduced.
      const refusal = await this.sceneRefusalFor(sender.id);
      if (refusal) {
        this.refuseScene(sender, refusal);
        return;
      }
      if (!this.stillAdmitted(sender.id)) return;
      const translated = sceneFromLegacyReference(reference);
      if (!translated) {
        this.dropModelChange('it could not be read as a model this room could fetch.');
        return;
      }
      // "The scene is this one model", which is what the message always meant
      // when the scene could only hold one. Replaces whatever was there, so a
      // room with an old client in it behaves the way that client expects.
      this.scene = translated;
      this.sceneSeeded = true;
      this.persistScene();
      this.relay(JSON.stringify({
        type: 'SCENE_STATE',
        payload: this.sceneStatePayload(),
      } as RoomMessage));

    } else if (msg.type === 'EDITING_START') {
      // Somebody pressed Edit. Answered by the room rather than assumed by the
      // client, so "only one person edits at a time" is a fact about the room.
      await this.startEditing(sender, msg.payload.force === true);

    } else if (msg.type === 'EDITING_STOP') {
      this.stopEditing(sender);

    } else if (msg.type === 'REVIEW_CONFIG') {
      this.reviewConfig = msg.payload.config;
      this.relay(JSON.stringify(msg), [sender.id]);

    } else if (msg.type === 'COMMENT_ADD') {
      this.comments.push(msg.payload.comment);
      this.relay(JSON.stringify(msg), [sender.id]);

    } else if (msg.type === 'COMMENT_UPDATE') {
      const { id, updates } = msg.payload;
      const idx = this.comments.findIndex((c) => c.id === id);
      if (idx !== -1) {
        this.comments[idx] = { ...this.comments[idx], ...updates };
      }
      this.relay(JSON.stringify(msg), [sender.id]);

    } else if (msg.type === 'COMMENT_DELETE') {
      this.comments = this.comments.filter((c) => c.id !== msg.payload.id);
      this.relay(JSON.stringify(msg), [sender.id]);

    } else if (msg.type === 'COMMENT_RESOLVE') {
      const idx = this.comments.findIndex((c) => c.id === msg.payload.id);
      if (idx !== -1) {
        this.comments[idx] = { ...this.comments[idx], resolved: true };
      }
      this.relay(JSON.stringify(msg), [sender.id]);

    } else if (msg.type === 'WEBRTC_SIGNAL') {
      // Relay to all peers; client filters by `to` field
      this.relay(JSON.stringify(msg), [sender.id]);

    } else if (msg.type === 'BOARDROOM_COUNTDOWN') {
      // Seed boardroom state. Leader defaults to the current host until someone
      // is explicitly promoted via LEADER_TAKEOVER or TAKEOVER_ATTEMPT.
      this.isBoardroomMode = true;
      this.boardroomLeaderId = this.computeHost();
      // Clean slate for takeover policy each entry — host re-enables explicitly
      this.takeoverModeEnabled = false;
      this.takeoverApprovedUserIds = [];
      this.lastPresenterChange = Date.now();
      this.relay(JSON.stringify(msg), [sender.id]);

    } else if (msg.type === 'ARENA_ENTRY') {
      // Leaving boardroom — wipe all boardroom state so the next entry is clean
      this.resetBoardroomState();
      this.relay(JSON.stringify(msg), [sender.id]);

    } else if (msg.type === 'RECORDING_STATE') {
      // Persist for late joiners. Only the host should send this, but the
      // server does not enforce that — the client-side RecordingContext
      // gates it behind canRecord (host-only). Broadcasting to ALL (no
      // exclude) so the sender's own indicator stays in sync.
      this.recordingState = msg.payload;
      this.relay(JSON.stringify(msg));

    } else if (msg.type === 'TRANSCRIPT_KEEP') {
      // ENFORCED, where its neighbour above is not: RECORDING_STATE only moves the
      // room's own indicator and the client already gates the button, while this one
      // decides that a meeting's transcript is written to the review's session row,
      // where everybody who can open the map can read it and download it later. That
      // is a decision about stored content, so it is the same rule the Record button
      // is offered under and the server is what applies it (see mayRecordMeeting).
      if (!this.mayRecordMeeting(sender.id)) return;
      // Rebuilt field by field rather than relayed as it arrived: a frame from the
      // wire is not a payload, and this one is stored and then handed to every
      // connection in the room. A missing or wrong-typed field answers the default —
      // `false`, and an empty name — instead of throwing in the message loop.
      const wire = msg.payload as { keep?: unknown; includePointing?: unknown; byName?: unknown } | undefined;
      this.transcriptKeep = {
        keep: wire?.keep === true,
        includePointing: wire?.includePointing === true,
        byName: typeof wire?.byName === 'string' ? wire.byName.slice(0, 100) : '',
      };
      // To the room including the sender, as EDITING_STATE is: the panel's pressed
      // state is then the room's answer rather than the click's assumption.
      this.relay(JSON.stringify({ type: 'TRANSCRIPT_KEEP', payload: this.transcriptKeep } as RoomMessage));

    } else if (msg.type === 'TRANSCRIPT_LINE') {
      // Server-authoritative speaker stamp: overwrite speakerId with the
      // connection's own userId so nobody can forge a line as somebody
      // else. This closes a hole that existed before section B — the old
      // passthrough relay trusted the client-supplied speakerName/id.
      const userId = this.connToUser.get(sender.id);
      if (userId) {
        msg.payload.speakerId = userId;
      }
      this.relay(JSON.stringify(msg), [sender.id]);

    } else if (msg.type === 'POINTING_SEGMENT') {
      // Same trust model as TRANSCRIPT_LINE: the server stamps userId from
      // the connection so one client cannot forge segments as another.
      const userId = this.connToUser.get(sender.id);
      if (userId) {
        msg.payload.userId = userId;
      }
      this.relay(JSON.stringify(msg), [sender.id]);

    } else if (
      msg.type === 'PRESENTER_CHANGE' ||
      msg.type === 'INSIGHT_CARD' ||
      msg.type === 'LEADER_CHANGE' ||
      msg.type === 'LASER_MOVE' ||
      msg.type === 'PRIVACY_MODE' ||
      msg.type === 'MEETING_END' ||
      msg.type === 'PRESENTER_REQUEST' ||
      msg.type === 'PRESENTER_REQUEST_DENIED' ||
      msg.type === 'LIVE_CHAT' ||
      msg.type === 'XR_PRESENCE'
    ) {
      this.relay(JSON.stringify(msg), [sender.id]);
    }
  }

  onClose(conn: Party.Connection) {
    this.connections.delete(conn.id);
    this.stateSent.delete(conn.id);
    // The connection's access token, and the verdict on it, go with it. A
    // reconnect arrives with its own token and is verified again.
    this.verifiedTokens.delete(conn.id);
    this.verifiedAccounts.delete(conn.id);
    const userId = this.connToUser.get(conn.id);
    this.connToUser.delete(conn.id);

    // Drop any pending knock entry for this connection.
    if (userId) {
      const wasPending = this.pending.has(userId);
      this.pending.delete(userId);
      if (wasPending) {
        this.broadcastJoinRequests();
      }
    }

    if (!userId || !this.participants.has(userId)) return;

    this.participants.delete(userId);
    this.joinOrder = this.joinOrder.filter(id => id !== userId);

    // An editor who leaves releases the lock, and the room is told at once.
    // Without this the banner "Robin is editing the review" would outlive Robin
    // for as long as the room stayed awake, and nobody could press Edit again
    // without being told somebody who is gone is busy.
    if (this.editing?.userId === userId) {
      this.clearEditing();
    }

    // Prune the leaving user out of any boardroom approvals/leadership so the
    // remaining room doesn't chase a ghost.
    let takeoverChanged = false;
    if (this.takeoverApprovedUserIds.includes(userId)) {
      this.takeoverApprovedUserIds = this.takeoverApprovedUserIds.filter(id => id !== userId);
      takeoverChanged = true;
    }

    let leaderChanged = false;
    if (this.boardroomLeaderId === userId) {
      this.boardroomLeaderId = this.computeHost();
      this.lastPresenterChange = Date.now();
      leaderChanged = true;
    }

    this.relay(JSON.stringify({
      type: 'LEAVE',
      payload: { userId },
    } as RoomMessage));

    this.relay(JSON.stringify({
      type: 'HOST_CHANGE',
      payload: { hostId: this.computeHost() },
    } as RoomMessage));

    if (takeoverChanged) {
      this.relay(JSON.stringify({
        type: 'TAKEOVER_SYNC',
        payload: { enabled: this.takeoverModeEnabled, approvedUserIds: this.takeoverApprovedUserIds },
      } as RoomMessage));
    }

    if (leaderChanged && this.boardroomLeaderId) {
      this.relay(JSON.stringify({
        type: 'LEADER_TAKEOVER',
        payload: { userId: this.boardroomLeaderId },
      } as RoomMessage));
    }

    // The admission is deliberately NOT revoked here. PartySocket reconnects
    // on its own after a network blip, and a browser reload keeps the same
    // userId (sessionStorage), so revoking would send the host to the back of
    // their own queue for refreshing the page. A new tab gets a new userId and
    // knocks like any other arrival, and a room with nobody left in it admits
    // its next knock by rule 2 — so nothing stays locked.

    // Send the pending queue to the new host (if any) so they see waiters
    // immediately after a host transfer.
    if (this.pending.size > 0) {
      this.broadcastJoinRequests();
    }
  }
}
