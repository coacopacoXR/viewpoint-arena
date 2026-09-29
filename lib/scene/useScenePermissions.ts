// What this participant may do to the room's scene, asked from the browser.
//
// Lived inside components/UI/SceneTree.tsx until batch BI put a second control on
// screen that changes the models — the empty room's "Try a sample". Two controls
// asking the same question in two places is how the tree and the canvas drift
// apart, and the whole point of lib/scene/roomScene.scenePermissions is that there
// is ONE rule the browser and the room server both ask. So the gathering of the
// four facts moved out beside it, and the tree imports it like anybody else.

import { useStore } from '../../store';
import { usePresence } from '../PresenceContext';
import { useActiveReviewStore } from '../activeReviewStore';
import { useReviewRole } from '../reviews/useReviewRole';
import { describeSceneRefusal, scenePermissions } from './roomScene';

/**
 * The browser's answer to the two scene-permission questions, with the reason
 * behind a refusal already in words.
 *
 * The room server enforces this and answers SCENE_REFUSED when it disagrees;
 * reading the same rule here is what lets a control say so BEFORE the click rather
 * than after it. A disabled button with a reason beats one that appears to do
 * nothing.
 *
 * "The same rule" is literal. lib/scene/roomScene.scenePermissions is ONE function
 * and party/room.server.ts calls it too, out of the four facts gathered here — the
 * review's roster via lib/reviews/useReviewRole, the "who may change models"
 * setting, this person, and the meeting host. It used to be two rules: batch BC
 * moved the server to deciding by ROLE when identities are on, and the tree went on
 * asking only "am I the meeting host", so an owner who made a colleague an editor,
 * reloaded, and let that colleague arrive first was shown "Import locked" in their
 * own review while the server would have allowed the import.
 */
export function useScenePermissions() {
  const modelEditors = useStore(state => state.modelEditors);
  const sessionHostId = useStore(state => state.sessionHostId);
  // The room's review, which is the room's own id — the same string the room
  // server passes to party/reviewRoles. Null in an ad-hoc session, where there
  // is no roster and a signed-in person is a participant, which is what the
  // server resolves for that room too.
  const reviewId = useActiveReviewStore(state => state.config?.reviewId ?? null);
  const { localUserId } = usePresence();
  const { role, rolesApply } = useReviewRole({ reviewId, sessionHostId, localUserId });
  const permissions = scenePermissions({
    // Null on identity.mode 'none' — the room server's own spelling of "this
    // deployment resolves no roles". There the meeting host is the authority
    // and the "who may change models" setting widens it, exactly as before.
    role: rolesApply ? role : null,
    modelEditors,
    userId: localUserId || null,
    hostId: sessionHostId,
  });
  return {
    canChangeModels: permissions.mayChangeModels,
    maySetModelEditors: permissions.maySetModelEditors,
    modelEditors,
    reason: permissions.changeRefusal === null
      ? null
      : describeSceneRefusal(permissions.changeRefusal),
  };
}
