// A card's "Linked components" row: which parts of the model its audio was about.
//
// Task 09b. The user's ask was "a way to check what component is linked to certain pieces
// of audio … in the decision cards". Everything this row shows is worked out by
// lib/capture/cardComponents, which is pure; this file is the drawing of it and the three
// things a click does.
//
// THREE THINGS A CLICK DOES, and all three are somebody else's:
//   * a component chip calls the store's `selectNode`, which is exactly what a Model Tree
//     row click does — there is no camera-frame action in this app to call instead, and
//     the tree's own "framing" is the row scrolling itself into view and the part
//     highlighting;
//   * a timestamp calls the host's scroll-to-message routine. ConversationPanel already
//     has one (it centres the line and flashes it) and it is passed in rather than
//     reimplemented, which is also why a host with no transcript on screen — the detail
//     modal opened from the boardroom — simply does not pass it and the timestamps are
//     labels;
//   * the ▶ plays one span of the recording this browser still holds. It is offered only
//     when there is one to play: see lib/capture/keptRecordingStore for why that is the
//     host who pressed Record, only until the page is reloaded, and only for the latest
//     recording.
//
// Hovering a chip highlights the CHIP and not the mesh. `ObjectState` is
// { id, visible, selected, expanded? } — selection is the only thing the scene highlights
// from a panel, the laser's hover glow living in lib/laserTargetRef's per-frame module maps
// where nothing outside the raycaster can write it. Inventing a second hover highlight for
// one row of chips was explicitly out of scope.
//
// Renders NOTHING when the card has no link at all, so a card about the meeting rather
// than about a mesh looks exactly as it did before.

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, MousePointer2, Play, Square } from 'lucide-react';
import { clsx } from 'clsx';
import {
  cardAudioLinks,
  formatMs,
  hasCardAudioLinks,
  lineIsFromRecording,
  type CardAudioSpan,
} from '../../lib/capture/cardComponents';
import { useKeptRecordingStore } from '../../lib/capture/keptRecordingStore';
import type { PointingSegment } from '../../lib/pointingTimelineStore';
import type { ChatMessage, InsightCard } from '../../types';

/**
 * "pointed by Maria, 0:06" — the hint on a chip.
 *
 * Two people on one part reads "pointed by Maria +1, 0:06" rather than as a list: the chip
 * is nine pixels tall in a 320px panel, and naming all of them is the detail modal's job.
 * The time is the longest single share, not the total, because "pointed by Maria, 0:12"
 * has to be a thing Maria did.
 */
export function pointedHint(pointedBy: ReadonlyArray<{ userName: string; ms: number }>): string {
  if (pointedBy.length === 0) return '';
  const first = pointedBy[0];
  const who = first.userName !== '' ? first.userName : 'somebody';
  const others = pointedBy.length > 1 ? ` +${pointedBy.length - 1}` : '';
  return `pointed by ${who}${others}, ${formatMs(first.ms)}`;
}

/**
 * One `<audio>` for the row, pointed at the kept recording and stopped at the span's end.
 *
 * An element per span would be an element per card in a deck of fifty, and a second press
 * on any span should stop the first rather than layer two clips over each other — so there
 * is one, created on the first press, dropped when the row goes away or the recording it
 * points at is replaced. The URL is not owned here: lib/RecordingContext creates and revokes
 * it and this only reads it.
 */
function useClipPlayer() {
  const kept = useKeptRecordingStore((s) => s.recording);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Whether the element has told us its duration. `currentTime` written before that is a
  // write the browser throws away, so the first press waits for the metadata and a later
  // one does not.
  const metadataReadyRef = useRef(false);
  // The seek waiting on that metadata, so a second press can replace it: without this,
  // pressing ▶ on one span and then on another before the recording has loaded plays the
  // FIRST span, which is the same wrong-audio mistake the startedAt gate exists to stop.
  const pendingSeekRef = useRef<(() => void) | null>(null);
  // Where to stop, in seconds. A ref rather than state because the `timeupdate` listener is
  // attached once, with the element, and has to read the newest answer.
  const stopAtRef = useRef(0);
  const [playingId, setPlayingId] = useState<string | null>(null);

  const release = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    metadataReadyRef.current = false;
    pendingSeekRef.current = null;
    setPlayingId(null);
  }, []);

  // On unmount, and whenever the recording this row would play changes: a second recording
  // stopped in the same room replaces the first, and lib/RecordingContext revokes the first
  // one's url at that moment. The element is dropped rather than re-pointed, because
  // assigning `src` again aborts the load already in flight, and the row reads "play" again
  // instead of showing a Stop button over silence.
  useEffect(() => {
    release();
    return release;
  }, [kept, release]);

  const stop = useCallback(() => {
    // The element's own 'pause' listener clears `playingId`; setting it here as well covers
    // a browser that fires no event for an element that had already paused by itself.
    audioRef.current?.pause();
    setPlayingId(null);
  }, []);

  const play = useCallback(
    (span: CardAudioSpan) => {
      if (kept === null) return;

      if (audioRef.current === null) {
        const created = new Audio();
        created.addEventListener('timeupdate', () => {
          // Stopping at the end of the span is the whole feature: an <audio> pointed at a
          // whole recording has no end of its own, so the row watches the clock and pauses.
          if (stopAtRef.current > 0 && created.currentTime >= stopAtRef.current) created.pause();
        });
        created.addEventListener('pause', () => setPlayingId(null));
        created.addEventListener('ended', () => setPlayingId(null));
        created.src = kept.url;
        audioRef.current = created;
      }
      const audio = audioRef.current;

      const startSeconds = span.startMs / 1000;
      stopAtRef.current = span.endMs / 1000;
      setPlayingId(span.messageId);

      const seek = () => {
        audio.currentTime = startSeconds;
        try {
          // `play()` rejects when the browser's autoplay policy says no and when it cannot
          // decode the container. Either leaves the row offering "play" rather than claiming
          // to be playing something it is not.
          void audio.play()?.catch(() => setPlayingId(null));
        } catch {
          setPlayingId(null);
        }
      };

      if (pendingSeekRef.current !== null) {
        audio.removeEventListener('loadedmetadata', pendingSeekRef.current);
        pendingSeekRef.current = null;
      }
      if (metadataReadyRef.current) {
        seek();
        return;
      }
      const onLoaded = () => {
        metadataReadyRef.current = true;
        pendingSeekRef.current = null;
        seek();
      };
      pendingSeekRef.current = onLoaded;
      audio.addEventListener('loadedmetadata', onLoaded, { once: true });
    },
    [kept],
  );

  return { kept, playingId, play, stop };
}

export interface CardAudioLinksProps {
  card: InsightCard;
  /** The room's chat history, in which the card's source lines are looked up. */
  messages: readonly ChatMessage[];
  /** The room's pointing timeline. */
  segments: readonly PointingSegment[];
  /** Node id → the name the scene gives it. See lib/capture/cardComponents. */
  partNames?: Readonly<Record<string, string>>;
  /** The room's per-node state — the oracle for "is this part still in the scene". */
  knownParts?: Readonly<Record<string, unknown>>;
  /** Select the part, the way a Model Tree row click does. */
  onSelectPart: (partId: string) => void;
  /**
   * Scroll the transcript to a line and flash it. Absent when the host has no transcript on
   * screen, and then the timestamps are labels rather than buttons.
   */
  onScrollToMessage?: (messageId: string) => void;
  /** 'compact' is a card in the Capture deck, 'full' the detail modal. */
  variant?: 'compact' | 'full';
}

const CardAudioLinks: React.FC<CardAudioLinksProps> = ({
  card,
  messages,
  segments,
  partNames,
  knownParts,
  onSelectPart,
  onScrollToMessage,
  variant = 'compact',
}) => {
  const links = useMemo(
    () => cardAudioLinks({ card, messages, segments, partNames, knownParts }),
    [card, messages, segments, partNames, knownParts],
  );
  const { kept, playingId, play, stop } = useClipPlayer();

  if (!hasCardAudioLinks(links)) return null;

  const full = variant === 'full';
  // A hand-made card's component was chosen by the person who typed it, not read out of the
  // transcript by a model, and "named by the model" on a card the deck also footers with
  // "Added by Maria" would contradict itself in four lines of one card.
  const namedLabel = card.source === 'manual' ? 'named on the card' : 'named by the model';
  const chip = clsx(
    'flex items-center gap-1 rounded-full border font-mono font-bold transition-colors min-w-0 cursor-pointer',
    full ? 'px-2 py-1 text-[11px]' : 'px-1.5 py-0.5 text-[9px]',
  );

  return (
    <div
      data-testid="card-audio-links"
      className={clsx(
        'flex flex-col gap-1 border-t border-gray-100 pt-1.5 mt-0.5',
        full && 'gap-2 pt-3',
      )}
      // The deck's card is itself a click target that opens the detail modal, so a press on
      // a chip or a timestamp has to say it is not a press on the card.
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className={clsx(
          'flex items-center gap-1 font-bold uppercase tracking-wide text-gray-400',
          full ? 'text-[10px]' : 'text-[8px]',
        )}
      >
        <Box size={full ? 11 : 9} />
        Linked components
      </div>

      {links.components.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {links.components.map((link) => {
            const hint = pointedHint(link.pointedBy);
            const label = link.namedByModel
              ? hint === ''
                ? namedLabel
                : `${hint} · ${namedLabel}`
              : hint;
            // A part that is not in the scene any more keeps its name and loses its click:
            // `selectNode` already refuses an id `objectStates` does not hold, and a chip
            // that does nothing when pressed is worse than one that says it cannot.
            if (link.missing) {
              return (
                <span
                  key={link.partId}
                  data-testid="linked-component-missing"
                  title={`${link.partName} is not in the scene any more`}
                  className={clsx(chip, 'border-dashed border-gray-300 bg-gray-50 text-gray-400 cursor-default')}
                >
                  <span className="truncate">{link.partName}</span>
                </span>
              );
            }
            return (
              <button
                key={link.partId}
                type="button"
                data-testid="linked-component"
                onClick={() => onSelectPart(link.partId)}
                title={label === '' ? `Select ${link.partName}` : `${label} — select ${link.partName}`}
                className={clsx(chip, 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 hover:border-blue-300')}
              >
                {link.pointedMs > 0 && <MousePointer2 size={full ? 10 : 8} className="shrink-0" />}
                <span className="truncate">{link.partName}</span>
                {label !== '' && (
                  <span className="font-sans font-medium text-gray-500 truncate">{label}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {links.spans.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {links.spans.map((span) => {
            const playable = kept !== null && lineIsFromRecording(span.messageId, kept.startedAt);
            const isPlaying = playingId === span.messageId;
            const label = `${formatMs(span.startMs)}–${formatMs(span.endMs)}`;
            const clock = clsx(
              'font-mono tabular-nums',
              full ? 'text-[11px]' : 'text-[9px]',
              onScrollToMessage
                ? 'text-gray-500 hover:text-black hover:underline cursor-pointer'
                : 'text-gray-400',
            );
            return (
              <span key={span.messageId} className="flex items-center gap-0.5">
                {onScrollToMessage ? (
                  <button
                    type="button"
                    data-testid="linked-span"
                    onClick={() => onScrollToMessage(span.messageId)}
                    title={
                      span.speaker !== ''
                        ? `${span.speaker} — show this line in the transcript`
                        : 'Show this line in the transcript'
                    }
                    className={clock}
                  >
                    {label}
                  </button>
                ) : (
                  <span className={clock}>{label}</span>
                )}
                {playable && (
                  <button
                    type="button"
                    data-testid="linked-span-play"
                    onClick={() => (isPlaying ? stop() : play(span))}
                    title={isPlaying ? 'Stop this clip' : 'Play what was said here'}
                    aria-label={isPlaying ? `Stop ${label}` : `Play ${label}`}
                    className="p-0.5 rounded text-gray-400 hover:text-black hover:bg-gray-100 transition-colors cursor-pointer"
                  >
                    {isPlaying ? <Square size={full ? 11 : 9} /> : <Play size={full ? 11 : 9} />}
                  </button>
                )}
                {full && span.speaker !== '' && (
                  <span className="text-[10px] text-gray-400">{span.speaker}</span>
                )}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
};

/**
 * Memoised because the deck re-renders on every clock write and nothing in a card's row
 * changes when the clock does. Every prop is either a store reference (stable until the
 * store writes it), a map the caller builds once, or a callback the caller keeps stable —
 * a caller that passes a fresh object literal per render defeats this.
 */
export default memo(CardAudioLinks);
