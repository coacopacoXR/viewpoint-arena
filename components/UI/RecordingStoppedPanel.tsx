// RecordingStoppedPanel — what stopping a recording now leads to.
//
// docs/plan/15-sessions-and-variants.md batch BU. Stopping used to be "Stop &
// summarise": one button, one consequence, the audio off to a model for cards
// whether the person pressing it wanted cards or not. It is three choices now, and
// they are not variants of one another —
//
//   Generate cards                  the old behaviour, and only that. Costs a whole
//                                   meeting's worth of model time, so it is asked for.
//   Save transcript with the meeting writes the transcript onto the meeting's
//                                   tracker_sessions row, where the session map and
//                                   the lobby's preview can offer it weeks later.
//   Download .txt                   the transcript as a file on this machine, with
//                                   or without where people were pointing at.
//
// Any combination, in any order, until the panel is dismissed or a new recording
// starts. The recorded audio stays in memory throughout, which is what makes
// Generate cards available at the end of the panel's life as well as at the start —
// and it is why the error row's Retry and this panel's Generate cards are the same
// function in RecordingContext.
//
// Rendered by RecordingControls, so it appears wherever the Record control does:
// the LIVE TRANSCRIPT tab and the Manager Workspace. Both read one provider, so the
// two copies always show the same pressed toggle and dismissing one dismisses both.
//
// WHO SEES IT: only the person who stopped the recording, and only on their own
// screen. `stopped` is local state in RecordingContext, not a room broadcast — the
// room already hears that the recording is off through RECORDING_STATE, and a panel
// of choices about audio only one browser holds is not something to show everybody.

import React from 'react';
import { Download, FileText, Sparkles, Undo2, X } from 'lucide-react';
import { clsx } from 'clsx';
import { useRecordingContext } from '../../lib/RecordingContext';

/** mm:ss, for "Recording 01:05" and "Recording stopped · 01:05". */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

interface RecordingStoppedPanelProps {
  /** See RecordingControls: 'dark' is the LIVE TRANSCRIPT tab, 'light' the Manager Workspace. */
  theme?: 'light' | 'dark';
}

const RecordingStoppedPanel: React.FC<RecordingStoppedPanelProps> = ({ theme = 'light' }) => {
  const ctx = useRecordingContext();
  if (!ctx || !ctx.canRecord || !ctx.stopped) return null;

  const {
    stopped,
    dismissStopped,
    generateCards,
    summarising,
    keepTranscript,
    toggleKeepTranscript,
    includePointing,
    setIncludePointing,
    downloadStoppedTranscript,
    captureBlockReason,
  } = ctx;
  const dark = theme === 'dark';
  const blocked = captureBlockReason !== null;

  const button = clsx(
    'flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider border transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
    dark
      ? 'border-white/15 bg-white/5 text-gray-200 hover:bg-white/10'
      : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50',
  );

  return (
    <section
      data-testid="recording-stopped"
      className={clsx(
        'shrink-0 border-b px-3 py-2 overflow-hidden',
        dark ? 'border-white/10 bg-black/40' : 'border-gray-200 bg-white px-4 py-2.5',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p
          className={clsx(
            'text-[10px] font-bold uppercase tracking-wider',
            dark ? 'text-gray-300' : 'text-gray-600',
          )}
        >
          Recording stopped · {formatElapsed(stopped.elapsedMs)}
        </p>
        <button
          onClick={dismissStopped}
          aria-label="Dismiss"
          title="Dismiss — the recording is kept, and Retry still works"
          className={clsx(
            'p-0.5 rounded transition-colors flex-shrink-0',
            dark ? 'text-gray-500 hover:text-white' : 'text-gray-400 hover:text-black',
          )}
        >
          <X size={12} />
        </button>
      </div>

      <div className="mt-2 flex flex-col gap-1.5">
        <button
          onClick={() => void generateCards()}
          disabled={summarising || blocked}
          title={captureBlockReason ?? 'Read the recording and add the cards it raises'}
          className={button}
        >
          <Sparkles size={11} /> {summarising ? 'Generating cards…' : 'Generate cards'}
        </button>

        {/* One button that is its own state, rather than a checkbox: the choice is
            made once and then read at meeting-end, and a pressed button with an Undo
            beside it says "this will happen, and you can take it back" where a tick
            box only says what is ticked. */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={toggleKeepTranscript}
            disabled={blocked && !keepTranscript}
            aria-pressed={keepTranscript}
            title={captureBlockReason ?? 'Store the transcript on this meeting’s session row'}
            className={clsx(
              button,
              keepTranscript &&
                (dark
                  ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-200'
                  : 'border-emerald-300 bg-emerald-50 text-emerald-800'),
            )}
          >
            <FileText size={11} />
            {keepTranscript ? 'Transcript will be saved with this meeting ✓' : 'Save transcript with this meeting'}
          </button>
          {keepTranscript && (
            <button
              onClick={toggleKeepTranscript}
              title="Do not store the transcript after all"
              className={button}
            >
              <Undo2 size={11} /> Undo
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => downloadStoppedTranscript()}
            title="Save the transcript as a text file on this machine"
            className={button}
          >
            <Download size={11} /> Download .txt
          </button>
          <label
            className={clsx(
              'flex items-center gap-1 text-[10px] cursor-pointer select-none',
              dark ? 'text-gray-400' : 'text-gray-500',
            )}
          >
            <input
              type="checkbox"
              checked={includePointing}
              onChange={(event) => setIncludePointing(event.target.checked)}
              className="accent-emerald-600"
            />
            Include what people pointed at
          </label>
        </div>
      </div>

      {/* The reason, in words, under the buttons it disabled: a greyed-out button
          with no explanation reads as a bug, and both of these are greyed out for a
          rule the room set rather than for anything about the recording. */}
      {blocked && (
        <p className={clsx('mt-1.5 text-[10px] leading-snug', dark ? 'text-amber-300' : 'text-amber-700')}>
          {captureBlockReason}
        </p>
      )}
    </section>
  );
};

export default RecordingStoppedPanel;
