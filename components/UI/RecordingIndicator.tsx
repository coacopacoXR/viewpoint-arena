// RecordingIndicator — persistent banner shown to every participant while
// the room is recording (section B: per-speaker mics).
//
// Names who started the recording, shows the local client's mic status, and
// offers a one-click "stop sharing my mic" that stops only this client's
// uploads — it does NOT stop the meeting recording. Nobody is asked for
// permission (the user decided against a per-person prompt), so leaving
// must always be one click away.

import React from 'react';
import { Mic, MicOff, StopCircle } from 'lucide-react';
import { clsx } from 'clsx';
import { useRecordingContext } from '../../lib/RecordingContext';
import { useWebRTCContext } from '../../lib/WebRTCContext';

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

interface RecordingIndicatorProps {
  theme?: 'light' | 'dark';
}

const RecordingIndicator: React.FC<RecordingIndicatorProps> = ({ theme = 'dark' }) => {
  const ctx = useRecordingContext();
  const webrtc = useWebRTCContext();
  if (!ctx) return null;

  const { recordingState, ownMicStatus, elapsedMs, stopSharingMic } = ctx;
  if (!recordingState?.recording) return null;

  const dark = theme === 'dark';
  const { byName, startedAt } = recordingState;
  const elapsed = elapsedMs || (Date.now() - startedAt);

  return (
    <section
      className={clsx(
        'shrink-0 border-b px-3 py-2 flex items-center gap-2 flex-wrap',
        dark ? 'border-white/10 bg-black/40' : 'border-gray-200 bg-white px-4 py-2.5',
      )}
      role="status"
      aria-live="polite"
    >
      <span className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
        <span
          className={clsx(
            'text-[10px] font-bold uppercase tracking-wider',
            dark ? 'text-red-300' : 'text-red-600',
          )}
        >
          Recording {formatElapsed(elapsed)}
        </span>
      </span>

      <span className={clsx('text-[10px]', dark ? 'text-gray-400' : 'text-gray-500')}>
        started by {byName}
      </span>

      {/* Muted is the state people fall into without noticing: everyone
          arrives muted, so a participant who never unmutes contributes
          nothing and every line ends up labelled with whoever DID unmute
          (reported 2026-09-23 — all lines carried the host's name). Say it
          plainly and make unmuting one click. */}
      {ownMicStatus === 'muted' && (
        <span
          className={clsx(
            'flex items-center gap-1.5 px-2 py-0.5 rounded border text-[10px] font-bold',
            dark
              ? 'bg-amber-500/15 border-amber-400/40 text-amber-200'
              : 'bg-amber-50 border-amber-300 text-amber-700',
          )}
        >
          <MicOff size={10} /> You are muted — your words are not in the transcript
          <button
            onClick={webrtc?.toggleMic}
            className={clsx(
              'ml-1 px-1.5 py-0.5 rounded uppercase tracking-wider border transition-colors',
              dark
                ? 'bg-amber-400/20 hover:bg-amber-400/30 border-amber-300/40'
                : 'bg-amber-100 hover:bg-amber-200 border-amber-300',
            )}
          >
            Unmute
          </button>
        </span>
      )}

      {ownMicStatus === 'blocked' && (
        <span className={clsx('flex items-center gap-1 text-[10px]', dark ? 'text-red-300' : 'text-red-600')}>
          <MicOff size={10} /> mic unavailable
        </span>
      )}

      {ownMicStatus === 'recording' && (
        <span className={clsx('flex items-center gap-1 text-[10px]', dark ? 'text-emerald-300' : 'text-emerald-600')}>
          <Mic size={10} /> sharing mic
        </span>
      )}

      {ownMicStatus === 'recording' && (
        <button
          onClick={stopSharingMic}
          className={clsx(
            'flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border transition-colors',
            dark
              ? 'bg-white/5 hover:bg-white/10 text-gray-300 border-white/10'
              : 'bg-gray-50 hover:bg-gray-100 text-gray-600 border-gray-200',
          )}
          title="Stop sharing my microphone. The meeting recording continues."
        >
          <StopCircle size={10} /> Stop sharing my mic
        </button>
      )}
    </section>
  );
};

export default RecordingIndicator;
