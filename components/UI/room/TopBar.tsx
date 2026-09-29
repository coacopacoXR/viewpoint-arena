// The top bar: how you point, and how the room is run.
//
// Highlight granularity stays visible — it is used constantly — while the two
// set-and-forget pointer toggles fold into Pointer ▾. To the right of the
// divider are the room controls that used to be a row in the top-right corner.
//
// The bar has to FIT, and what it has to fit is not the window: since batch BQ2 it
// is laid out between the room's left block (logo, lobby, the review's name) and the
// side panel, so the width it gets depends on the panel being open and on the review
// being named. A window media query cannot know either, and the one this bar used
// (`min-width: 1500px`) was wrong in both directions — labels at 1600px with the
// panel open ran under it, and no labels at 1280px with the panel closed threw away
// space that was there. So the bar MEASURES the box it was given and sheds labels,
// least-used first, until it fits; see TOP_BAR_DROP_ORDER.

import React from 'react';
import {
  Crosshair, Users, Share2, Shield, ShieldOff, MonitorPlay, Pencil, Milestone,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useStore } from '../../../store';
import { usePresence } from '../../../lib/PresenceContext';
import { useCompactLevel } from '../../../lib/useCompactLevel';
import SharePanel from '../SharePanel';
import XRButton from '../XRButton';
import StartVariant from '../../review/StartVariant';
import LineChip from './LineChip';
import PointerMenu from './PointerMenu';

/**
 * The order the bar sheds its labels in, least-used first.
 *
 * Index 0 goes at compact level 1, and so on: at level N every control in the first N
 * entries is icon-only, with its word still in `title` so a hover says what it is. Edit,
 * Sessions and Variant are last because they are the three that name what the meeting is
 * doing rather than how it is pointed at, and a bar of unlatched icons is a bar nobody
 * can read at a glance on a shared screen.
 *
 * Exported because the test that pins the order reads it: "drops the least-used first"
 * is a claim about a list, and a list a test cannot see is a list that can be reordered
 * by accident.
 */
export const TOP_BAR_DROP_ORDER = [
  'privacy',
  'boardroom',
  'share',
  'pointer',
  'highlight',
  'people',
  'variant',
  'sessions',
  'edit',
] as const;

/** A control whose label the bar can shed. */
export type TopBarButton = (typeof TOP_BAR_DROP_ORDER)[number];

/** The compact level at which this control's label goes. Level 0 is "everything labelled". */
export function dropLevelOf(control: TopBarButton): number {
  return TOP_BAR_DROP_ORDER.indexOf(control) + 1;
}

/** The level at which there is nothing left to shed. */
export const TOP_BAR_MAX_COMPACT = TOP_BAR_DROP_ORDER.length;

// The measuring loop itself is lib/useCompactLevel, shared with the amber Editing strip
// that replaces this bar while somebody has Edit on — the two are handed the same box by
// the room's header row and neither can ask a window how wide it is.

type Tone = 'idle' | 'on' | 'danger';

const RoomButton: React.FC<{
  onClick: () => void;
  title: string;
  icon: React.ReactNode;
  label: string;
  tone?: Tone;
  trailing?: React.ReactNode;
  /** The level at which the label goes. Omitted for a control that keeps its word. */
  dropAt?: number;
  /** The bar's current compact level. */
  level?: number;
}> = ({ onClick, title, icon, label, tone = 'idle', trailing, dropAt, level = 0 }) => (
  <button
    onClick={onClick}
    title={title}
    className={clsx(
      'h-9 px-2 shrink-0 flex items-center gap-1.5 rounded-sm border transition-all pointer-events-auto',
      tone === 'on'
        ? 'bg-black text-white border-black'
        : tone === 'danger'
          ? 'bg-red-600 text-white border-red-600 hover:bg-red-700'
          : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400 hover:text-black'
    )}
  >
    {icon}
    {(dropAt === undefined || level < dropAt) && (
      <span className="text-[10px] font-bold uppercase tracking-wide">{label}</span>
    )}
    {trailing}
  </button>
);

interface TopBarProps {
  isHost: boolean;
  roomId?: string;
  showShare: boolean;
  onToggleShare: () => void;
  showParticipants: boolean;
  onToggleParticipants: () => void;
  onOpenDeicticExplainer: () => void;
  /**
   * Whether the Edit button belongs on the bar at all.
   *
   * Decided by lib/reviews/roles.ts through lib/reviews/useReviewRole, not here:
   * on a deployment with accounts it is the person's role in THIS review, and on
   * the default install with none it is the meeting host. Hidden rather than
   * disabled, because a control greyed out for somebody who will never have it is
   * a question the room then has to answer — and the room server would refuse the
   * press anyway.
   */
  canEditReview?: boolean;
  /** Ask the room for Edit. The answer arrives as state, not as a return value. */
  onEditReview?: () => void;
  /**
   * Open the map of this design review's sessions, or undefined when there is no
   * review to have one — an ad-hoc room has meetings and no design review, and a
   * button that opens an empty map is a question the room then has to answer.
   *
   * Not permission-gated, and deliberately so: seeing how a review got here is what
   * lets somebody take part in it. Editing the review is the thing that needs a role.
   */
  onOpenSessions?: () => void;
}

const TopBar: React.FC<TopBarProps> = ({
  isHost,
  roomId,
  showShare,
  onToggleShare,
  showParticipants,
  onToggleParticipants,
  onOpenDeicticExplainer,
  canEditReview = false,
  onEditReview,
  onOpenSessions,
}) => {
  const isPrivacyMode = useStore((s) => s.isPrivacyMode);
  const togglePrivacyMode = useStore((s) => s.togglePrivacyMode);
  const isBoardroomMode = useStore((s) => s.isBoardroomMode);
  const toggleBoardroomMode = useStore((s) => s.toggleBoardroomMode);
  const triggerBoardroomEntry = useStore((s) => s.triggerBoardroomEntry);
  const laserHighlightGranularity = useStore((s) => s.laserHighlightGranularity);
  const setLaserHighlightGranularity = useStore((s) => s.setLaserHighlightGranularity);
  const agents = useStore((s) => s.agents);
  const hideAgents = useStore((s) => s.hideAgents);
  // The line this room resolved itself to, put in the store by pages/RoomPage.tsx.
  // Null on the main line, for an ad-hoc room, and on an install with no database —
  // and the chip renders nothing for all three, so every room that existed before
  // lines did looks exactly as it did.
  const activeLine = useStore((s) => s.activeLine);
  const { remoteParticipantList, broadcastPrivacyMode, broadcastBoardroomCountdown, broadcastArenaEntry } = usePresence();

  // The same count the participants panel shows in its header.
  const peopleCount = (hideAgents ? 0 : agents.length) + remoteParticipantList.length;

  const boxRef = React.useRef<HTMLDivElement>(null);
  const barRef = React.useRef<HTMLDivElement>(null);
  // Everything that decides how wide the bar WANTS to be, as one string: which controls
  // render at all, and the two labels whose words change. The measuring pass depends on
  // this rather than on nothing, so a variant's chip appearing or the count growing a digit
  // is measured again — without measuring on every render of a room that re-renders several
  // times a second on presence.
  const contentKey = [
    roomId ?? '',
    peopleCount,
    isPrivacyMode ? 1 : 0,
    `${activeLine?.id ?? ''}:${activeLine?.name ?? ''}`,
    canEditReview && onEditReview ? 1 : 0,
    onOpenSessions ? 1 : 0,
    isHost ? 1 : 0,
  ].join('|');
  const compact = useCompactLevel(boxRef, barRef, contentKey, TOP_BAR_MAX_COMPACT);
  const shows = (control: TopBarButton) => compact < dropLevelOf(control);

  return (
    // The box the bar has to fit, given to it by the room's header row: everything
    // between the left block and the side panel. Centring lives here rather than in
    // Interface so that the thing being measured and the thing being centred are the
    // same element, and so the bar can be measured on its own in a test.
    <div
      ref={boxRef}
      data-testid="top-bar-box"
      className="flex w-full min-w-0 justify-center pointer-events-none"
    >
    <div
      ref={barRef}
      data-testid="top-bar"
      className="flex items-center gap-1.5 bg-white/90 backdrop-blur-md border border-gray-200 rounded-md shadow-sm p-1.5 pointer-events-auto"
    >
      {/* Which line of the design review this meeting is on. First, before anything
          that can be changed, because it is the one thing here that says where the
          changes will land: a variant meets in its own room and adopting from it or
          dropping it are the two decisions the chip carries. Since batch BQ2 it also
          carries the way back to the main line, which used to be a second button
          beside it and was the first thing the bar ran out of room for. */}
      {roomId && <LineChip roomId={roomId} line={activeLine} mayEdit={canEditReview} isMeetingHost={isHost} />}

      {/* Into the review's own editing, leftmost because it is the one control here
          that changes the review rather than the meeting. Pressing it ASKS the room:
          if somebody already has Edit, the answer comes back as "Robin is editing —
          ask them, or take over" rather than as a second editor. */}
      {canEditReview && onEditReview && (
        <RoomButton
          onClick={onEditReview}
          title="Edit the review"
          icon={<Pencil size={16} />}
          label="Edit"
          dropAt={dropLevelOf('edit')}
          level={compact}
        />
      )}

      {/* The map of this design review's sessions: the main line, its variants, and
          what each meeting was looking at. Everybody in the room may open it —
          knowing how the review got here is what makes it possible to take part in
          it, and unlike Edit it changes nothing. */}
      {onOpenSessions && (
        <RoomButton
          onClick={onOpenSessions}
          title="This design review's sessions"
          icon={<Milestone size={16} />}
          label="Sessions"
          dropAt={dropLevelOf('sessions')}
          level={compact}
        />
      )}

      {/* Start a variant, beside the map of the ones there already are.
          Batch BQ: the only way to start one before this was Sessions → click a
          meeting → "Explore a variant from here", three clicks deep on a diagram,
          and the user's report was that nothing anywhere offered it. Same write,
          same people — `editReview` in lib/reviews/roles.ts, the answer the Edit
          button beside it was already given — and the word on screen is "Variant",
          never the programming one the icon suggests. */}
      {canEditReview && roomId && (
        <StartVariant
          reviewId={roomId}
          lineId={activeLine?.id ?? null}
          mayEdit={canEditReview}
          isMeetingHost={isHost}
          label="Variant"
          showLabel={shows('variant')}
        />
      )}

      {/* Highlight granularity. The caption is what a compact bar sheds; Model and
          Part stay, because without them the two toggles are two identical pills and
          the choice they offer is unreadable. */}
      <div className="flex items-center gap-1 px-1.5 shrink-0">
        <Crosshair size={14} className="text-gray-400" />
        {shows('highlight') && (
          <span className="text-[10px] font-bold uppercase tracking-wide text-gray-500 mr-1">Highlight</span>
        )}
        <button
          onClick={() => setLaserHighlightGranularity('model')}
          title="Highlight whole model"
          className={clsx(
            'text-[9px] font-bold uppercase px-2 py-0.5 rounded transition-all',
            laserHighlightGranularity === 'model'
              ? 'bg-black text-white'
              : 'text-gray-400 hover:text-gray-700'
          )}
        >Model</button>
        <button
          onClick={() => setLaserHighlightGranularity('part')}
          title="Highlight specific part"
          className={clsx(
            'text-[9px] font-bold uppercase px-2 py-0.5 rounded transition-all',
            laserHighlightGranularity === 'part'
              ? 'bg-black text-white'
              : 'text-gray-400 hover:text-gray-700'
          )}
        >Part</button>
      </div>

      {/* Finger pointer + hover dwell, folded away but never invisible */}
      <PointerMenu onOpenExplainer={onOpenDeicticExplainer} showLabel={shows('pointer')} />

      <div className="w-px h-7 bg-gray-200 mx-0.5 shrink-0" />

      {/* People — the count stays when the word goes, because "how many are here" is
          the answer this button exists to give and the icon alone does not give it. */}
      <RoomButton
        onClick={onToggleParticipants}
        title="Participants"
        icon={<Users size={16} />}
        label="People"
        tone={showParticipants ? 'on' : 'idle'}
        dropAt={dropLevelOf('people')}
        level={compact}
        trailing={
          <span className="text-[10px] font-mono tabular-nums opacity-70">{peopleCount}</span>
        }
      />

      {/* Share */}
      <div className="relative shrink-0">
        <RoomButton
          onClick={onToggleShare}
          title="Share"
          icon={<Share2 size={16} />}
          label="Share"
          tone={showShare ? 'on' : 'idle'}
          dropAt={dropLevelOf('share')}
          level={compact}
        />
        {showShare && roomId && (
          <SharePanel roomId={roomId} onClose={onToggleShare} />
        )}
      </div>

      {/* Privacy Mode Toggle */}
      <RoomButton
        onClick={() => { togglePrivacyMode(); broadcastPrivacyMode(!isPrivacyMode); }}
        title={isPrivacyMode ? 'Privacy On' : 'Privacy'}
        icon={isPrivacyMode ? <ShieldOff size={16} /> : <Shield size={16} />}
        label={isPrivacyMode ? 'Privacy On' : 'Privacy'}
        tone={isPrivacyMode ? 'danger' : 'idle'}
        dropAt={dropLevelOf('privacy')}
        level={compact}
      />

      {/* Boardroom Mode Toggle — host only */}
      {isHost && (
        <RoomButton
          onClick={() => {
            if (isBoardroomMode) {
              toggleBoardroomMode();
              broadcastArenaEntry();
            } else {
              triggerBoardroomEntry();
              broadcastBoardroomCountdown();
            }
          }}
          title="Boardroom"
          icon={<MonitorPlay size={16} />}
          label="Boardroom"
          tone={isBoardroomMode ? 'on' : 'idle'}
          dropAt={dropLevelOf('boardroom')}
          level={compact}
        />
      )}

      {/* XR Entry — renders nothing when the device supports neither AR nor VR */}
      <XRButton />
    </div>
    </div>
  );
};

export default TopBar;
