// Follow state, made visible from both sides.
//
// FollowersBadge (leader side, above the dock): who is locked to my camera.
// FollowingBadge (follower side, top of the canvas): a reminder that dragging
// is only a temporary nudge, with the one control that actually leaves.

import React from 'react';
import { clsx } from 'clsx';
import { useStore } from '../../store';
import { usePresence } from '../../lib/PresenceContext';
import { participantLabel } from '../../lib/identity';

const initial = (name: string) => (name.trim()[0] ?? '?').toUpperCase();

const pillClass =
  'flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/90 backdrop-blur-md border border-gray-200 shadow-sm';

const FollowersBadge: React.FC = () => {
  const { localUserId, remoteParticipantList } = usePresence();
  const leaderId = useStore(state => state.leaderId);
  const followingRemoteUserId = useStore(state => state.followingRemoteUserId);

  const followers = remoteParticipantList.filter(p => p.followingUserId === localUserId);
  if (followers.length === 0) return null;

  const isLeading = leaderId === 'USER' && !followingRemoteUserId;

  return (
    <div className={pillClass}>
      <span className="font-mono text-[10px] uppercase tracking-widest text-gray-500">
        {isLeading
          ? `Leading · ${followers.length} following`
          : `${followers.length} following you`}
      </span>
      <span className="flex items-center gap-1">
        {followers.map(p => (
          <span
            key={p.userId}
            title={
              p.followNudged
                ? `${participantLabel(p.name, p.guest)} — looking around`
                : participantLabel(p.name, p.guest)
            }
            className={clsx(
              'w-4 h-4 rounded-full flex items-center justify-center text-white text-[8px] font-bold shrink-0 transition-opacity',
              p.followNudged && 'opacity-30',
            )}
            style={{ backgroundColor: p.color }}
          >
            {initial(p.name)}
          </span>
        ))}
      </span>
    </div>
  );
};

export const FollowingBadge: React.FC<{ onFreeView: () => void }> = ({ onFreeView }) => {
  const followingRemoteUserId = useStore(state => state.followingRemoteUserId);
  const followNudged = useStore(state => state.followNudged);
  const { remoteParticipantList } = usePresence();

  if (!followingRemoteUserId) return null;

  const leader = remoteParticipantList.find(p => p.userId === followingRemoteUserId);
  const name = leader ? participantLabel(leader.name, leader.guest) : 'remote user';

  return (
    <div className={pillClass}>
      <span
        className="w-4 h-4 rounded-full flex items-center justify-center text-white text-[8px] font-bold shrink-0"
        style={{ backgroundColor: leader?.color ?? '#9ca3af' }}
      >
        {initial(name)}
      </span>
      <span className="font-mono text-[10px] text-gray-500">
        {followNudged ? (
          <>
            Following <span className="font-bold text-gray-900">{name}</span> — moving on your own ·
            snapping back
          </>
        ) : (
          <>
            Following <span className="font-bold text-gray-900">{name}</span>
          </>
        )}
      </span>
      <button
        onClick={onFreeView}
        className="font-mono text-[10px] uppercase tracking-wide px-2 py-0.5 rounded border border-gray-200 text-gray-500 hover:border-gray-400 hover:text-gray-900 transition-colors"
        title="Leave the follow and keep this view"
      >
        Free view
      </button>
    </div>
  );
};

export default FollowersBadge;
