// Where /review/:id/setup goes now.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH. The curate page is gone — its
// tabs are the room's side panel with Edit on — but its ADDRESS is still out
// there: in bookmarks, in the links a tracker and a PLM launch wrote, in the
// messages people sent each other last week. A removed route in a single-page app
// answers with the lobby, so every one of those links would have quietly landed
// somewhere else and left the person wondering where their review went.
//
// `replace` because the setup page is not a place anybody should be able to go
// back to: the browser's Back button from the room should return to wherever they
// were before it, not to an address that no longer exists.
//
// The review is NOT created here, which is the difference between this and the
// lobby's "New design review": arriving at a setup address means a review with
// that id was already meant to exist. If it does not, the room says so.

import React from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';

const ReviewSetupRedirect: React.FC = () => {
  const { reviewId } = useParams<{ reviewId: string }>();
  const location = useLocation();
  // A malformed address has nothing to redirect to. The lobby is the app's own
  // answer to "there is nowhere to go", and it is where an unmatched route lands.
  if (!reviewId) return <Navigate to="/" replace />;
  // The navigation STATE goes with it. The PLM "Launch in Arena" flow arrives at
  // this address carrying `{ plmLaunch: { source, doc } }`, and dropping it here
  // would silently throw away the one thing that says which Onshape document the
  // room was opened for.
  return <Navigate to={`/room/${reviewId}?edit=1`} replace state={location.state} />;
};

export default ReviewSetupRedirect;
