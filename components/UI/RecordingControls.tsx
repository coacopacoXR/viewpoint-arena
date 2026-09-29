// RecordingControls — start / stop / elapsed / outcome, pure presentation.
//
// Reads from RecordingContext (mounted once in RoomPage) and renders nothing when
// the viewer is not the host or the deployment asked for mock capture. It does not
// check which AI is configured — RecordingContext.canRecord is the whole of that
// decision, and since plan 14 batch BF it is a server-side one. Rendered in two
// places:
//   * at the top of the LIVE TRANSCRIPT tab (ConversationPanel);
//   * in the Manager Workspace (ManagerPanel), where the host may already be
//     when they want to record.
// Both call sites are one line: <RecordingControls />.
//
// Since batch BU this is two rows rather than one: the control, and — once a
// recording has been stopped — RecordingStoppedPanel, which is where the three
// things that can be done with it live. The button says "Stop" and not "Stop &
// summarise" because stopping no longer summarises.

import React from 'react';
import { Mic, Square, RefreshCw, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useRecordingContext } from '../../lib/RecordingContext';
import RecordingStoppedPanel, { formatElapsed } from './RecordingStoppedPanel';

interface RecordingControlsProps {
  /**
   * 'dark' is the LIVE TRANSCRIPT tab: a ~320px wide dark panel. It drops the
   * headings and lets the row wrap, because a row of shrink-0 pills does not
   * fit that width — it overflowed the panel and clipped the transcript
   * (seen live, 2026-09-22). 'light' is the Manager Workspace's wide sidebar.
   */
  theme?: 'light' | 'dark';
}

const RecordingControls: React.FC<RecordingControlsProps> = ({ theme = 'light' }) => {
  const ctx = useRecordingContext();
  if (!ctx || !ctx.canRecord) return null;

  const { state, elapsedMs, outcome, summarising, start, stop, retry } = ctx;
  const dark = theme === 'dark';

  return (
    <>
    <section
      className={clsx(
        'shrink-0 border-b px-3 py-2 overflow-hidden',
        dark ? 'border-white/10 bg-black/40' : 'border-gray-200 bg-white px-4 py-2.5',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {!dark && (
          <>
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-gray-500 shrink-0">
              Post-meeting summary
            </h2>
            <span className="text-[9px] font-mono text-gray-300 shrink-0">audio capture</span>
            <div className="flex-1 min-w-0" />
          </>
        )}

        {state === 'recording' && (
          <>
            <span
              className={clsx(
                'flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wider',
                dark
                  ? 'bg-red-500/15 border-red-400/40 text-red-300'
                  : 'bg-red-50 border-red-300 text-red-600',
              )}
              role="status"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
              Recording {formatElapsed(elapsedMs)}
            </span>
            <button
              onClick={() => void stop()}
              disabled={summarising}
              title="Stop the recording, then choose what to do with it"
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider bg-red-600 hover:bg-red-700 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
            >
              <Square size={10} /> Stop
            </button>
          </>
        )}

        {state === 'idle' && (
          <button
            onClick={() => void start()}
            disabled={summarising}
            className={clsx(
            'flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider border disabled:opacity-40 disabled:cursor-not-allowed transition-colors',
            dark
              ? 'bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 border-emerald-400/40'
              : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border-emerald-200',
          )}
          >
            <Mic size={11} /> {dark ? 'Record' : 'Start recording'}
          </button>
        )}

        {state === 'unsupported' && (
          <span className="text-[10px] text-gray-400 italic truncate">
            This browser cannot record audio.
          </span>
        )}
      </div>

      {summarising && (
        <div className={clsx('mt-1.5 flex items-center gap-1.5 text-[10px]', dark ? 'text-gray-400' : 'text-gray-500')}>
          <Loader2 size={11} className="animate-spin" /> Summarising…
        </div>
      )}

      {!summarising && outcome !== null && 'added' in outcome && (
        <div className={clsx('mt-1.5 text-[10px] font-bold', dark ? 'text-emerald-300' : 'text-emerald-700')}>
          {outcome.added} insight{outcome.added === 1 ? '' : 's'} added
        </div>
      )}

      {!summarising && outcome !== null && !('added' in outcome) && (
        <div className="mt-1.5 flex items-start gap-2">
          <p className={clsx('flex-1 min-w-0 text-[10px] leading-snug break-words', dark ? 'text-red-300' : 'text-red-600')}>
            {outcome.message}
          </p>
          <button
            onClick={() => void retry()}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider bg-gray-100 hover:bg-gray-200 text-gray-700 border border-gray-200 transition-colors shrink-0"
            title="Re-send the same recording"
          >
            <RefreshCw size={10} /> Retry
          </button>
        </div>
      )}
    </section>
    {/* The three choices, once there is a stopped recording to choose about. It
        answers null until then, so this is unconditional on purpose: the panel is
        part of the record control's row, not a second thing a caller has to place. */}
    <RecordingStoppedPanel theme={theme} />
    </>
  );
};

export default RecordingControls;
