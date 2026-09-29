// IdentityGate — shows the page that was asked for, or the sign-in page.
//
// Sits inside AccessGate (the deployment password comes first: it is the
// shared front door, this is the per-person one) and wraps the routes, so every
// route is covered by one decision instead of each page carrying its own.
//
// The trick that keeps sign-in painless: this gate renders SignInPage AT the URL
// that was asked for and never navigates away from it. When useAuth reports a
// session the gate simply renders its children, so the path and its
// location.state — the joinRoomId a room link carries — are still there. A
// "return to" URL would have to be serialised, and would lose the state object.
//
// With identity.mode 'none' (the default, and every install made before
// identity existed) this renders its children and nothing else: useAuth is not
// called into Supabase at all, and the routes mount unchanged.

import React, { useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useConnectorConfig } from '../../lib/config/ConfigContext';
import { useAuth, type GuestIdentity } from '../../lib/auth/useAuth';
import { guestRoomIdFor, identityRequired, publicIdentityOf } from '../../lib/auth/authRules';
import SignInPage from '../../pages/SignInPage';

export const IdentityGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { config, loading } = useConnectorConfig();
  const identity = useMemo(() => publicIdentityOf(config), [config]);
  const auth = useAuth(identity);
  const location = useLocation();
  const navigate = useNavigate();

  const handleGuest = useCallback(
    (guest: GuestIdentity) => {
      const roomId = guestRoomIdFor(location.pathname, location.state);
      if (!roomId) return;
      // The same two things LobbyPage.enterRoom does before it navigates, so
      // RoomPage's own "did you come from the lobby?" guard lets a guest in
      // instead of bouncing them back out to the lobby.
      sessionStorage.setItem('vp_enteredRoom', roomId);
      auth.joinAsGuest(guest);
      if (location.pathname !== `/room/${roomId}`) {
        navigate(`/room/${roomId}`, { state: { fromLobby: true }, replace: true });
      }
    },
    [auth, location.pathname, location.state, navigate],
  );

  // While the config is unknown the mode is unknown, so nothing is decided yet.
  // Same neutral state AccessGate renders — blank, not the sign-in form, which
  // would flash at a signed-in person on every reload.
  if (loading) return null;
  if (!identityRequired(identity)) return <>{children}</>;
  if (auth.status === 'loading') return null;
  if (auth.status === 'signedIn') return <>{children}</>;

  // Signed out, or already a guest. A guest only gets back in where a guest is
  // allowed: the room they were invited to. Every other route — starting a
  // session, curating, the tracker, admin — sends them to the sign-in page.
  const roomId = guestRoomIdFor(location.pathname, location.state);
  const guestsAllowedHere = identity.allowGuests && roomId !== null;
  if (auth.status === 'guest' && guestsAllowedHere) return <>{children}</>;

  return (
    <SignInPage
      methods={identity.methods}
      guestRoomId={guestsAllowedHere ? roomId : null}
      onGuest={handleGuest}
    />
  );
};
