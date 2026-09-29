// How a ROOM is handed a PLM launch (T5.3), and how it hands one back.
//
// pages/LaunchPage.tsx validates a deep link, lets the configured adapter resolve
// it, and navigates to the review's setup address with `{ plmLaunch: { source, doc } }`
// in router state. pages/ReviewSetupRedirect.tsx turns that address into
// `/room/<id>?edit=1` and passes the state through — batch BH deleted the setup
// page that used to meet it, so the room is where a launch lands now.
//
// There are TWO arrivals, and only the first has any state:
//
//   1. the redirect chain above, which carries the resolved document in the
//      history state;
//   2. the Onshape OAuth round-trip. The browser left the app and came back to an
//      ADDRESS, and a full page load has no router state at all — so the return-to
//      the document browser is given carries the same validated ids in the query
//      string, and a room arriving with those and no state is the same launch
//      coming back rather than a new one. `parseLaunchParams` validates them
//      exactly as it validated the original link, which is why the way back needs
//      no adapter and no second resolution.
//
// Both spellings are read here, in one place, because two callers need the same
// answer: pages/RoomPage.tsx (a launch may have to bring the review into
// existence) and components/review/PlmLaunch.tsx (which records the document and
// opens the browser).

import {
  LAUNCH_PARAM_KEYS,
  buildLaunchSearch,
  isLaunchError,
  parseLaunchParams,
  type PLMLaunch,
} from './launchParams.ts';

/**
 * The ids a launch handed over, validated again on the way in.
 *
 * The state was written by our own LaunchPage, so this is not distrust of it — it
 * is the contract launchParams.ts keeps: `buildLaunchSearch` and
 * `plmReferenceUrl` build URLs out of these ids, and only ids that passed the
 * shape check may reach them. Running the same validator over the state keeps that
 * true for the one path that did not come through a query string, and it costs a
 * round trip through two pure functions.
 */
function validated(launch: PLMLaunch): PLMLaunch | null {
  // A hand-edited history entry can hold anything, including a launch with no
  // document in it; buildLaunchSearch would throw on that rather than refuse it.
  if (launch.doc === undefined || launch.doc === null) return null;
  const parsed = parseLaunchParams(buildLaunchSearch(launch.source, launch.doc));
  return isLaunchError(parsed) ? null : parsed;
}

/** The launch this room arrival carries, or null when the arrival is not one. */
export function launchFromArrival(state: unknown, search: string): PLMLaunch | null {
  const carried = (state as { plmLaunch?: PLMLaunch } | null)?.plmLaunch;
  // The state wins. An arrival can only carry both if something built the address
  // by hand, and treating that as one launch rather than two is the reading that
  // cannot record the same document twice.
  if (carried) {
    return validated(carried);
  }
  const parsed = parseLaunchParams(search);
  return isLaunchError(parsed) ? null : parsed;
}

/**
 * Where the Onshape OAuth round-trip returns to.
 *
 * THE SAME ROOM, with Edit on — not `/launch?...`, which is what the deleted setup
 * page returned to. /launch mints a fresh crypto.randomUUID() every time it runs,
 * so sending the user back there would abandon the room the launch just created,
 * with its reference in it, and start another one. The launch ids travel in the
 * address because the round trip drops the router state that carried them.
 */
export function roomLaunchReturnTo(roomId: string, launch: PLMLaunch): string {
  const launchSearch = buildLaunchSearch(launch.source, launch.doc);
  return `/room/${encodeURIComponent(roomId)}?edit=1&${launchSearch.slice(1)}`;
}

/**
 * The room's own query string with the launch parameters taken back out of it.
 *
 * Called once the room has acted, with `replace`. A reload must not replay the
 * launch, and this is the half of that guarantee the address bar can break: an
 * Onshape link that names an element imports that element the moment the document
 * browser opens, so a launch left in the URL is a model imported again on every
 * reload. `edit=1` stays — Edit is what the launch asked for, and it is not
 * something a reload should quietly take away.
 */
export function withoutLaunchParams(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of LAUNCH_PARAM_KEYS) params.delete(key);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}
