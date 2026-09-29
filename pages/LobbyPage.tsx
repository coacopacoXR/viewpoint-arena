// The lobby: every design review on this install, as cards you can look inside.
//
// docs/plan/15-sessions-and-variants.md batch BO, built from the sketch the user
// approved in docs/plan/sketches/lobby.html. The page this replaces was a dark
// two-column screen — 420px of feature list and tracker statistics beside a name form —
// and the user's note on it was that it "sucks" and that what they wanted was to be able
// to see, from outside, what a design review looks like inside. So the marketing column
// is gone, the form is a chip in the top bar, and the page is a grid of reviews with a
// preview of the selected one beside it.
//
// WHAT IS DELIBERATELY UNCHANGED
//
// * THE NAME RULE. Nobody enters a room nameless. With no account behind this browser
//   the name field is drawn INLINE above the actions until it has something in it — not
//   hidden in the chip's menu, because a box you have to go looking for is a box nobody
//   fills in. With an account, the name is the account's and is not editable.
// * THE IDENTITY GATE AND mode 'none'. The gate is in App.tsx and still wraps this page;
//   `identityRequired(publicIdentityOf(config))` still decides whether "Mine" and
//   "Shared with me" mean anything, and on the default install with no accounts they do
//   not — the chips are still offered, they simply answer with what the install has.
// * THE INVITED-PREVIEW FLOW. Arriving with a room id in the router state preselects
//   that review and makes Join the primary button, including for a link-only review the
//   grid would not otherwise offer to a stranger.
// * A GUEST SEES ONLY WHAT THEY WERE INVITED TO. The grid is the review their link
//   named and nothing else; the old lobby hid its lists from a guest for exactly that
//   reason, and a card is a way in just as a list row was.
//
// "NEW SESSION" IS GONE. Batch BN made it write a design review row the same way "New
// design review" does, and left the two differing only in whether the room opens with
// Edit on — see components/lobby/LobbyActions.tsx. One button remains, and it opens the
// room with Edit on, because the person who just created a review is the one about to
// put a model in it.

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useIdentity, AVATAR_COLORS, type UserIdentity } from '../lib/identity';
import { signOutOfAccount } from '../lib/auth/useAuth';
import { identityRequired, publicIdentityOf } from '../lib/auth/authRules';
import { useConnectorConfig } from '../lib/config/ConfigContext';
import { getCurationSummary, createReview, type CurationSummary } from '../lib/curationsRepo';
import { useReviewSetupStore, createReviewDraft, reviewTitleFrom, NEW_REVIEW_TITLE } from '../lib/reviewSetupStore';
import { joinLineIdOf, markRoomEntered, roomHref } from '../lib/reviews/openLine';
import { can, resolveRole } from '../lib/reviews/roles';
import LobbyTopBar from '../components/lobby/LobbyTopBar';
import LobbyActions from '../components/lobby/LobbyActions';
import ReviewCard from '../components/lobby/ReviewCard';
import ReviewPreview from '../components/lobby/ReviewPreview';
import { parseJoinTarget } from '../lib/lobby/joinTarget';
import {
  filterReviews,
  useLobbyData,
  type LobbyFilter,
  type LobbyReview,
} from '../lib/lobby/useLobbyData';

/**
 * A review reached by a link the grid does not hold, as a card the grid can draw.
 *
 * The grid reads the sixty newest reviews; a link-only one older than that is still a
 * review somebody was invited to, and the invited-preview flow has to work for it. The
 * summary query answers no meetings and no lines, so the card says "no sessions yet" —
 * which is either true or unknowable from here, and the preview panel reads the detail.
 */
function fromSummary(summary: CurationSummary): LobbyReview {
  return {
    id: summary.id,
    title: summary.title,
    description: summary.description,
    thumbnail: summary.thumbnail ?? null,
    modelName: null,
    updatedAt: summary.updated_at,
    createdAt: summary.created_at,
    archived: false,
    listed: summary.listed,
    memberRole: null,
    mine: false,
    visited: false,
    lastVisitedAt: null,
    sessions: [],
    lines: [],
    openCards: { RISK: 0, ACTION: 0, RATIONALE: 0 },
    revision: null,
  };
}

const EMPTY_HINT = 'text-[11px] text-gray-500';

const LobbyPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const joinRoomId: string | undefined = (location.state as { joinRoomId?: string } | null)?.joinRoomId;
  // The LINE this browser was sent here to enter, when the arrival named one.
  //
  // lib/reviews/openLine puts it in the router state, and it is the reason this page
  // reads anything but the review: a room will not admit a browser that has no name, so
  // openLine sends a nameless one HERE with the review AND the line and lets this page
  // ask. Dropping the line on the way in — entering the review's main line instead —
  // would land somebody who pressed "Open" on Variant B in a different meeting looking
  // at a different model, with no idea the bounce had cost them anything.
  const joinLineId = joinLineIdOf(location.state);

  const [identity, setIdentity] = useIdentity();
  // An accountId in vp_user means the name came from a signed-in account: this page does
  // not edit it, it only shows who is signed in. A guest has no account, and may enter
  // the room they were invited to and nothing else.
  const accountId = identity?.accountId ?? null;
  const isGuest = identity?.guest === true;
  const accountName = accountId ? identity?.name ?? '' : null;

  // The deployment's identity block, not this browser's. Whether "Mine" can mean
  // anything at all is a property of the install: on the default 'none' there is no
  // account for a review to belong to.
  const { config } = useConnectorConfig();
  const deployment = useMemo(() => publicIdentityOf(config), [config]);
  const accountsOn = identityRequired(deployment);
  const signedIn = accountsOn && !!accountId && !isGuest;

  const [name, setName] = useState(accountName ?? (joinRoomId ? '' : (identity?.name ?? '')));
  const [color, setColor] = useState(identity?.color ?? AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]);
  const [role, setRole] = useState(identity?.role ?? '');
  const [joinCode, setJoinCode] = useState(joinRoomId ?? '');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(joinRoomId ?? null);

  const lobby = useLobbyData({ accountId: signedIn ? accountId : null, isGuest });

  // An admin of this install. The token this browser already holds is the authority, the
  // way lib/reviews/useReviewRole reads it — no extra request, and nothing here decides
  // anything: api/reviews/delete.ts checks the caller's own token against the roster and
  // hides a button is not the enforcement.
  const [installAdmin, setInstallAdmin] = useState(false);
  useEffect(() => {
    if (!accountsOn) { setInstallAdmin(false); return; }
    let cancelled = false;
    supabase.auth
      .getSession()
      .then(({ data }) => { if (!cancelled) setInstallAdmin(data.session?.user.app_metadata?.role === 'admin'); })
      .catch(() => { if (!cancelled) setInstallAdmin(false); });
    return () => { cancelled = true; };
  }, [accountsOn]);

  // The review an invitation named, when the grid does not already hold it.
  const [invitedOnly, setInvitedOnly] = useState<LobbyReview | null>(null);
  useEffect(() => {
    if (!joinRoomId) { setInvitedOnly(null); return; }
    let cancelled = false;
    void getCurationSummary(joinRoomId).then((summary) => {
      if (cancelled || !summary) return;
      setInvitedOnly(fromSummary(summary));
    });
    return () => { cancelled = true; };
  }, [joinRoomId]);

  /** Every review this page knows about, grid or not. */
  const all = useMemo(
    () => (invitedOnly && !lobby.reviews.some((review) => review.id === invitedOnly.id)
      ? [...lobby.reviews, invitedOnly]
      : lobby.reviews),
    [lobby.reviews, invitedOnly],
  );

  // A guest gets the review their link named and nothing else.
  const cards = useMemo(() => {
    if (isGuest) return all.filter((review) => review.id === joinRoomId);
    const shown = lobby.visible;
    // An invitation to a review the chips do not show — a link-only one, an archived one,
    // or one the grid's cap left out — still has to be previewable, because "you have
    // been invited to THIS" is the one thing the invited-preview flow must not lose. It
    // goes first so the panel opens on it rather than on whatever the grid starts with.
    if (joinRoomId && !shown.some((review) => review.id === joinRoomId)) {
      const invited = all.find((review) => review.id === joinRoomId);
      return invited ? [invited, ...shown] : shown;
    }
    return shown;
  }, [isGuest, lobby.visible, all, joinRoomId]);

  const counts = useMemo(
    () => ({
      mine: filterReviews(all, 'mine').length,
      shared: filterReviews(all, 'shared').length,
      all: filterReviews(all, 'all').length,
      archived: filterReviews(all, 'archived').length,
    }) as Record<LobbyFilter, number>,
    [all],
  );

  // The selection follows the grid: a review that is no longer shown stops being
  // selected, and an empty panel on a page full of cards is a page that looks broken.
  const selected = useMemo(() => {
    const inCards = cards.find((review) => review.id === selectedId) ?? null;
    if (inCards) return inCards;
    return cards[0] ?? all.find((review) => review.id === selectedId) ?? null;
  }, [cards, selectedId, all]);

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  // ─── Identity ───────────────────────────────────────────────────────────────

  function buildIdentity(): UserIdentity {
    const next: UserIdentity = { name: name.trim(), color, role: role || undefined };
    // Carry the session's own fields through: this form edits colour and role, it does
    // not decide who anyone is. Dropping accountId here would sign the person out of
    // their own lobby the moment they picked a new colour.
    if (accountId) next.accountId = accountId;
    if (isGuest) next.guest = true;
    return next;
  }

  /** True when this browser has no account behind its name, so the name is typed here. */
  const nameEditable = !accountId;
  // Once asked, the name field STAYS until this browser leaves the page: it used to
  // be shown only while the name was empty, so the first letter typed into it made it
  // disappear, and the person could neither finish their name nor press Enter.
  const [askedForName, setAskedForName] = useState(false);
  useEffect(() => {
    if (nameEditable && name.trim() === '') setAskedForName(true);
  }, [nameEditable, name]);
  const needsName = nameEditable && (askedForName || name.trim() === '');

  async function handleSignOut() {
    setError('');
    const failure = await signOutOfAccount();
    if (failure) { setError(failure); return; }
    // Nothing to navigate to: the IdentityGate hears the same SIGNED_OUT and swaps this
    // page for the sign-in page.
  }

  // ─── Entering a room ────────────────────────────────────────────────────────

  /**
   * Open a room, as the review's own permanent address.
   *
   * `roomHref` rather than a string built here, so a variant's `?line=` is spelled the
   * one way lib/reviews/lines spells it and the room resolves itself to the line the
   * link named instead of to its main line — and so `edit=1` is appended as a SECOND
   * parameter. It used to be `${path}?edit=1`, which on a path that already carried
   * `?line=` produced `?line=<id>?edit=1`: a line id nobody can resolve, so the room
   * quietly opened on the main line and the variant somebody pasted a link for looked
   * like it had never existed. `markRoomEntered` writes the same mark
   * lib/reviews/openLine writes, which is what lets a RELOAD of the room back in.
   */
  function enterRoom(roomId: string, options: { edit?: boolean; lineId?: string | null } = {}) {
    setIdentity(buildIdentity());
    markRoomEntered(roomId);
    navigate(roomHref(roomId, options.lineId ?? null, options.edit === true), {
      state: { fromLobby: true },
    });
  }

  /**
   * "+ New design review".
   *
   * The review is CREATED here rather than on arrival, because a room with no
   * review_curations row has nothing to edit: RoomPage seeds itself from loadCuration
   * and an absent row leaves the side panel empty. Writing the row first also means the
   * link in the address bar is the review's permanent one from the first moment it
   * exists, and that the creator owns it and may import into it.
   *
   * The room opens whether or not the write landed. An install with no database
   * configured — the default self-hosted one, which leaves VITE_SUPABASE_URL unset —
   * cannot write a row and never could; refusing to open the room there would take this
   * page's headline button away from exactly the install that has no other way to start
   * a review. So the draft is handed to lib/reviewSetupStore as well, which is where
   * RoomPage looks FIRST, and the room's own save-on-edit upserts the row later if a
   * database ever answers.
   */
  async function handleNewDesignReview(title: string) {
    if (!name.trim()) { setError('Enter your name first.'); return; }
    if (creating) return;
    setCreating(true);
    setError('');
    const reviewId = crypto.randomUUID();
    // '' — Enter on a field nobody filled in — creates the untitled review, which is
    // what this button did before it asked. Naming is offered, never required: the
    // person who wants a room now can name it from inside, in the Edit panel.
    const wanted = reviewTitleFrom(title, NEW_REVIEW_TITLE);
    const created = await createReview(reviewId, wanted);
    setCreating(false);
    useReviewSetupStore.getState().hydrateDraft(created ?? createReviewDraft(reviewId, wanted));
    enterRoom(reviewId, { edit: true });
  }

  /**
   * "Join" — a bare id, a path, or a whole pasted link including its variant.
   *
   * Nothing is created here: the review either exists already or the person who started
   * it created it, and minting a room out of a mistyped link is how a lobby fills up with
   * reviews nobody will ever open again.
   *
   * The line is the box's own when it names one and the arrival's otherwise: this is the
   * function a nameless browser bounced here by lib/reviews/openLine ends up in, and the
   * box is prefilled with the bare review id, which carries no `?line=`. Without that
   * second half the bounce would lose the variant the person was trying to open.
   */
  function handleJoin() {
    if (!name.trim()) { setError('Enter your name first.'); return; }
    const target = parseJoinTarget(joinCode);
    if (!target) { setError('Enter a room code or link.'); return; }
    setError('');
    enterRoom(target.roomId, { lineId: target.lineId ?? joinLineId });
  }

  // ─── Deletes ────────────────────────────────────────────────────────────────
  //
  // Both go through api/reviews/delete.ts, which removes the whole review — meetings,
  // cards, lines, roster, stored revisions — in one transaction. The old lobby deleted
  // the curation row at Supabase and left the rest behind.
  //
  // Who is offered them follows lib/reviews/roles.ts `deleteReview`: the owner and this
  // install's admins, and NOT its editors. On a deployment with no accounts there is
  // nobody to ask — no signed-in callers, no roster, no owner column anybody can fill —
  // so the endpoint takes the caller's own claim the way api/reviews/lines.ts takes the
  // meeting host's, and what guards the install is its front-door password. Every review
  // is deletable there, which is what the old lobby's trash icon on every saved curation
  // already allowed; the difference is that now the whole review goes.
  const mayDelete = (review: LobbyReview): boolean => !accountsOn || review.mine || installAdmin;

  /**
   * Who may NAME this review, and who may START A VARIANT of it — the same people,
   * because both are `editReview` in lib/reviews/roles.ts, and neither is `deleteReview`
   * (which is the owner's and this install's admins', and NOT its editors').
   *
   * Asked of that table rather than worked out here, for the reason
   * components/UI/Interface.tsx gives: `can('editReview')` keeps the four levels of
   * trust written down in one file, and a lobby that re-derived them would be a second
   * copy to drift. What the lobby cannot know is the meeting's host — there is no
   * meeting — so on a deployment with no accounts, where the host IS the editor, the
   * answer is the same one `mayDelete` already takes: whoever got past this install's
   * front door.
   */
  const mayEditReview = (review: LobbyReview): boolean => {
    if (isGuest) return false;
    if (!accountsOn) return true;
    return can(
      resolveRole({
        identityMode: deployment.mode,
        accountId: signedIn ? accountId : null,
        isGuest,
        members: accountId && review.memberRole ? [{ userId: accountId, role: review.memberRole }] : [],
        ownerId: review.mine && accountId ? accountId : null,
        isAdmin: installAdmin,
        isMeetingHost: false,
      }),
      'editReview',
    );
  };

  // The panel is showing the review an invitation named, so its button says "Join" and
  // it enters the LINE that invitation carried rather than the review's main one.
  const invitedTo = !!joinRoomId && selected?.id === joinRoomId;

  return (
    // Its own scroll container: index.html fixes the body and hides its overflow
    // for the 3D room, so a page that is taller than the window must scroll
    // itself (user, 2026-09-25: "in the lobby it is not possible to scroll down").
    <div
      className="h-full overflow-y-auto bg-[#f3f4f6] font-sans text-gray-900"
      data-testid="lobby-scroll"
      style={{ fontFamily: 'Inter, system-ui, sans-serif' }}
    >
      <div className="max-w-[1180px] mx-auto px-4 pb-12">
        <LobbyTopBar
          name={name}
          color={color}
          role={role}
          canSignOut={!!accountId}
          nameEditable={nameEditable}
          onName={(next) => { setName(next); setError(''); }}
          onColor={setColor}
          onRole={setRole}
          onSignOut={() => void handleSignOut()}
        />

        {/* The one field nobody may skip, drawn where it cannot be missed. */}
        {needsName && (
          <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 mb-3 max-w-md">
            <label htmlFor="lobby-name" className="block font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
              Your name
            </label>
            <input
              id="lobby-name"
              type="text"
              value={name}
              onChange={(event) => { setName(event.target.value); setError(''); }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                // Enter in the name field finishes whatever this browser came here to
                // do. With an invitation in the router state that is entering the
                // review — and the LINE — it named; without one it is starting a new
                // review, which is the page's headline button. The invited case used to
                // create a review too, so the natural thing to do after typing a name
                // was the one thing nobody arriving by a link wanted.
                if (joinRoomId) handleJoin();
                else void handleNewDesignReview('');
              }}
              placeholder="e.g. Alex Chen"
              maxLength={40}
              autoFocus
              data-testid="lobby-name-field"
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-900 outline-none focus:border-black placeholder:text-gray-300"
            />
            <p className="text-[11px] text-gray-400 mt-1.5">
              {joinRoomId
                ? 'You have been invited to a design review. Identify yourself to continue.'
                : 'Needed before you can start or join a design review.'}
            </p>
          </div>
        )}

        <LobbyActions
          filter={lobby.filter}
          onFilter={lobby.setFilter}
          counts={counts}
          joinValue={joinCode}
          onJoinValue={(next) => { setJoinCode(next); setError(''); }}
          onJoin={handleJoin}
          onNewReview={(title) => void handleNewDesignReview(title)}
          creating={creating}
          mayStart={!isGuest}
          showFilters={!isGuest}
        />

        {error && (
          <p className="mt-2.5 text-xs font-mono text-red-600" role="status">{error}</p>
        )}
        {isGuest && (
          <p className="mt-2.5 text-[11px] font-mono text-gray-500 leading-relaxed">
            You are here as a guest, so the only design review you can open is the one you were invited to.
          </p>
        )}

        <div className="grid gap-[18px] mt-[18px] items-start grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px]">
          {/* The grid */}
          <section aria-label="Design reviews">
            {lobby.loading ? (
              <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-56 rounded-lg border border-gray-200 bg-white animate-pulse" />
                ))}
              </div>
            ) : cards.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-300 bg-white px-5 py-10 text-center">
                <p className={EMPTY_HINT}>
                  {lobby.filter === 'archived'
                    ? 'No design reviews have been put away.'
                    : lobby.filter === 'mine'
                      ? 'Design reviews you own will appear here.'
                      : lobby.filter === 'shared'
                        ? 'Design reviews somebody else added you to will appear here.'
                        : isGuest
                          ? 'The design review you were invited to will appear here.'
                          : 'No design reviews yet.'}
                </p>
                {!isGuest && lobby.filter === 'all' && (
                  <p className="text-[10px] text-gray-400 mt-1.5">
                    Press <span className="font-semibold text-gray-600">New design review</span> to start one — it saves
                    as you go and appears here for anyone you share the link with.
                  </p>
                )}
              </div>
            ) : (
              <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
                {cards.map((review) => (
                  <ReviewCard
                    key={review.id}
                    review={review}
                    selected={selected?.id === review.id}
                    onSelect={() => setSelectedId(review.id)}
                  />
                ))}
              </div>
            )}
          </section>

          {/* The preview of the selected review. Sticky beside the grid, and below it on
              a screen too narrow to hold both — the sketch's own breakpoint. */}
          <div className="lg:sticky lg:top-3 min-w-0">
            {selected ? (
              <ReviewPreview
                key={selected.id}
                review={selected}
                invited={invitedTo}
                mayDelete={mayDelete(selected)}
                mayEdit={mayEditReview(selected)}
                isMeetingHost={!accountsOn}
                accountsOn={accountsOn}
                onOpen={() => enterRoom(selected.id, { lineId: invitedTo ? joinLineId : null })}
                // Every "open a line" inside the panel goes through the lobby's own
                // door rather than through lib/reviews/openLine, because this page has
                // a name to write first: openLine refuses to invent one and would
                // bounce back here, and a bounce from the panel that is already here
                // is a button that appears to do nothing.
                onOpenLine={(lineId) => enterRoom(selected.id, { lineId })}
                onDeleted={() => {
                  lobby.forget(selected.id);
                  setSelectedId(null);
                  lobby.refresh();
                }}
                onChanged={lobby.refresh}
              />
            ) : (
              <div className="rounded-lg border border-dashed border-gray-300 bg-white px-5 py-10 text-center">
                <p className={EMPTY_HINT}>Select a design review to see inside it.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default LobbyPage;
