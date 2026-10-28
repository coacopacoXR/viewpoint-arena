// The room's view tools — a cut plane, and the explode task 08b renders.
//
// ONE small rail at the edge of the free canvas, on screen whenever you are in a room and
// whatever else is open. Not in the amber strip, and not behind the Edit switch: the strip
// is the room's editing tools and it only appears for the one person holding the edit lock,
// while a cut is something the whole meeting looks at — the same reason the laser and the
// view modes are not in it either. Not in the side panel for the same reason the panel is
// collapsible: a section somebody is dragging has to stay visible while the Model Tree is
// open beside it.
//
// The rail is one button and the popover is everything else, because the alternative is a
// permanent four-control panel in the middle of the canvas — and the thing this controls is
// the model, which is the middle of the canvas.
//
// SHARED, AND THAT IS VISIBLE. Every control writes the store, which writes the room
// (store.ts's `setViewTools`), so the section on this screen is the section on everybody
// else's and on the screen of whoever joins next. Nothing here is a local preference, and
// the label says "room" rather than "my" for that reason.

import React, { useCallback, useState } from 'react';
import { clsx } from 'clsx';
import { ArrowLeftRight, Boxes, RotateCcw, Scissors } from 'lucide-react';
import { flushViewTools, sceneModelVisible, useStore } from '../../../store';
import { CUT_AXES, DEFAULT_VIEW_TOOLS, type CutAxis, type ViewTools } from '../../../lib/scene/viewTools';

/**
 * Where a fresh cut starts, as a fraction of the models' extent.
 *
 * The middle rather than an end: a cut at 0 or 1 removes nothing and looks like the button
 * did not work, and a cut at the middle shows a section on the first frame — which is the
 * whole argument for the control being one click rather than one click and a drag.
 */
const FIRST_CUT = { axis: 'x' as CutAxis, position: 0.5, flip: false };

/**
 * What there is to cut, or why there is not.
 *
 * Three answers and not a boolean, because "disabled" on its own is the one state a person
 * cannot diagnose: a room with no model in it, a room whose model is still downloading, and
 * a room whose every model is hidden in the Model Tree all look identical from here and want
 * three different things done about them.
 */
function useCutAvailability(): { available: boolean; reason: string | null } {
  const activeModelType = useStore((state) => state.activeModelType);
  const scene = useStore((state) => state.scene);
  const sceneEntries = useStore((state) => state.sceneEntries);
  const localModelVisibility = useStore((state) => state.localModelVisibility);

  if (activeModelType === 'synth') return { available: true, reason: null };
  if (activeModelType !== 'imported' || scene.models.length === 0) {
    return { available: false, reason: 'This room has no model to cut.' };
  }
  // The same test components/Scene/ImportedModel.tsx makes before it mounts a model: parsed
  // here, and not hidden in the Model Tree. A model still downloading is in the scene and not
  // in the entries, which is the case worth naming separately — it resolves itself in a
  // second, and "nothing to cut" would have read as "this will never work".
  const shown = scene.models.filter(
    (model) => sceneEntries[model.id] !== undefined && sceneModelVisible(model, localModelVisibility),
  );
  if (shown.length > 0) return { available: true, reason: null };
  const parsed = scene.models.some((model) => sceneEntries[model.id] !== undefined);
  return {
    available: false,
    reason: parsed
      ? 'Every model in this room is hidden in the Model Tree.'
      : 'The model is still loading.',
  };
}

/** One labelled row of the popover: the room's own vocabulary for a control with a name. */
const Row: React.FC<{ label: string; children: React.ReactNode; hint?: string }> = ({
  label,
  hint,
  children,
}) => (
  <div className="flex flex-col gap-1">
    <div className="flex items-baseline justify-between gap-2">
      <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-gray-500">
        {label}
      </span>
      {hint ? <span className="font-mono text-[9px] text-gray-400">{hint}</span> : null}
    </div>
    {children}
  </div>
);

const RoomViewTools: React.FC<{ className?: string }> = ({ className }) => {
  const viewTools = useStore((state) => state.viewTools);
  const setViewTools = useStore((state) => state.setViewTools);
  const { available, reason } = useCutAvailability();
  const [open, setOpen] = useState(false);
  const cut = viewTools.cut;

  /**
   * One write, and the write is the whole of the interaction.
   *
   * Nothing here sends anything: `setViewTools` applies the value locally and puts it on the
   * wire at ~15/s with a trailing send, which is what keeps a drag off the socket without
   * leaving the room a step behind the slider. See store.ts.
   */
  const write = useCallback(
    (next: ViewTools) => setViewTools(next),
    [setViewTools],
  );

  const setCut = useCallback(
    (patch: Partial<NonNullable<ViewTools['cut']>>) => {
      if (cut === null) return;
      write({ ...viewTools, cut: { ...cut, ...patch } });
    },
    [cut, viewTools, write],
  );

  // A slider fires per pointer-move and the store throttles the wire, so the last value of a
  // drag can still be waiting for its slot when the finger comes off. Flushed here rather
  // than left to the timer: the release is the moment the person considers the value final,
  // and a room that converges 66 ms later is a room that disagrees with the screen that
  // dragged it for exactly that long. `onKeyUp` as well, because a keyboard arrow is a drag
  // with no pointer in it.
  const commit = useCallback(() => flushViewTools(), []);

  const cutOn = cut !== null;

  return (
    <div className={clsx('pointer-events-none flex items-center gap-2', className)}>
      {/* The popover, to the LEFT of the rail: the rail sits on the right edge of the free
          canvas, so anything opening to the right would open under the side panel — or off
          the window entirely with the panel collapsed. */}
      {open && (
        <div
          className="pointer-events-auto absolute right-full top-1/2 mr-2 w-60 -translate-y-1/2 rounded-sm border border-gray-200 bg-white/95 p-3 shadow-lg backdrop-blur-md"
          data-testid="view-tools-popover"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-gray-700">
              View tools
            </span>
            <span className="font-mono text-[8px] uppercase tracking-wider text-gray-400">
              shared with the room
            </span>
          </div>

          {!available && (
            <p
              className="mb-2 rounded-sm border border-amber-200 bg-amber-50 px-2 py-1 font-mono text-[9px] leading-snug text-amber-800"
              data-testid="view-tools-unavailable"
            >
              {reason}
            </p>
          )}

          <div className="flex flex-col gap-3">
            <Row label="Cut plane">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={!available}
                  data-testid="view-tools-cut-toggle"
                  onClick={() => write({ ...viewTools, cut: cutOn ? null : FIRST_CUT })}
                  title={
                    available
                      ? cutOn
                        ? 'Put the model back together'
                        : 'Cut the model along a plane'
                      : reason ?? undefined
                  }
                  className={clsx(
                    'h-7 flex-1 rounded-sm border px-2 font-mono text-[9px] font-bold uppercase tracking-widest transition-colors',
                    !available && 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-300',
                    available && cutOn && 'border-black bg-black text-white',
                    available && !cutOn && 'border-gray-300 bg-white text-gray-600 hover:border-gray-500 hover:text-black',
                  )}
                >
                  {cutOn ? 'On' : 'Off'}
                </button>
                <button
                  type="button"
                  disabled={!cutOn}
                  title="Flip which side of the plane is cut away"
                  aria-label="Flip the cut"
                  data-testid="view-tools-flip"
                  onClick={() => setCut({ flip: !cut?.flip })}
                  className={clsx(
                    'flex h-7 w-7 items-center justify-center rounded-sm border transition-colors',
                    cut?.flip
                      ? 'border-black bg-black text-white'
                      : 'border-gray-300 bg-white text-gray-500 hover:border-gray-500 hover:text-black',
                    !cutOn && 'cursor-not-allowed opacity-40',
                  )}
                >
                  <ArrowLeftRight size={12} />
                </button>
                <button
                  type="button"
                  disabled={!cutOn}
                  title="Put the plane back in the middle"
                  aria-label="Reset the cut position"
                  data-testid="view-tools-reset"
                  onClick={() => setCut({ position: FIRST_CUT.position, flip: false })}
                  className={clsx(
                    'flex h-7 w-7 items-center justify-center rounded-sm border border-gray-300 bg-white text-gray-500 transition-colors hover:border-gray-500 hover:text-black',
                    !cutOn && 'cursor-not-allowed opacity-40',
                  )}
                >
                  <RotateCcw size={12} />
                </button>
              </div>
            </Row>

            <Row label="Axis">
              {/* Three buttons and not a select: the axes are the whole choice, they fit, and
                  a select hides two of the three behind a click. */}
              <div className="flex gap-1" role="group" aria-label="Cut axis">
                {CUT_AXES.map((axis) => (
                  <button
                    key={axis}
                    type="button"
                    disabled={!cutOn}
                    data-testid={`view-tools-axis-${axis}`}
                    aria-pressed={cut?.axis === axis}
                    onClick={() => setCut({ axis })}
                    title={`Cut perpendicular to ${axis.toUpperCase()}`}
                    className={clsx(
                      'h-7 flex-1 rounded-sm border font-mono text-[10px] font-bold uppercase transition-colors',
                      cut?.axis === axis
                        ? 'border-black bg-black text-white'
                        : 'border-gray-300 bg-white text-gray-500 hover:border-gray-500 hover:text-black',
                      !cutOn && 'cursor-not-allowed opacity-40',
                    )}
                  >
                    {axis}
                  </button>
                ))}
              </div>
            </Row>

            <Row label="Position" hint={cutOn ? `${Math.round((cut?.position ?? 0) * 100)}%` : undefined}>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                disabled={!cutOn}
                data-testid="view-tools-position"
                aria-label="Cut position"
                value={Math.round((cut?.position ?? 0.5) * 100)}
                onChange={(event) => setCut({ position: Number(event.target.value) / 100 })}
                onPointerUp={commit}
                onKeyUp={commit}
                onBlur={commit}
                className={clsx('w-full accent-black', !cutOn && 'cursor-not-allowed opacity-40')}
              />
            </Row>

            {/* Rendered and disabled on purpose, with the reason on it. The value travels the
                wire, the room server and the store from this task, so the day the renderer
                lands this is one `disabled` and one component — and a control that appeared
                later would be a control the room had to learn twice. */}
            <Row label="Explode" hint={`${Math.round(viewTools.explode * 100)}%`}>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                disabled
                value={Math.round(viewTools.explode * 100)}
                aria-label="Explode"
                data-testid="view-tools-explode"
                className="w-full cursor-not-allowed accent-black opacity-40"
              />
              <span className="flex items-center gap-1 font-mono text-[8px] uppercase tracking-wider text-gray-400">
                <Boxes size={9} />
                Arrives with task 08b — the room already carries it
              </span>
            </Row>

            <button
              type="button"
              data-testid="view-tools-reset-all"
              onClick={() => {
                write(DEFAULT_VIEW_TOOLS);
                commit();
              }}
              className="h-7 rounded-sm border border-gray-300 bg-white font-mono text-[9px] font-bold uppercase tracking-widest text-gray-600 transition-colors hover:border-gray-500 hover:text-black"
            >
              Reset view tools
            </button>
          </div>
        </div>
      )}

      {/* The rail itself. `active` while the room is cutting, so the state is legible from
          the canvas without the popover being open — which matters because the popover is
          open on one screen and the cut is on everybody's. */}
      <div className="pointer-events-auto flex flex-col gap-1.5">
        <button
          type="button"
          data-testid="view-tools-toggle"
          aria-expanded={open}
          aria-label="View tools"
          title={
            available
              ? 'Cut plane and explode — shared with the room'
              : `View tools — ${reason ?? 'nothing to cut'}`
          }
          onClick={() => setOpen((was) => !was)}
          className={clsx(
            'flex h-9 w-9 items-center justify-center rounded-sm border transition-all duration-200',
            cutOn
              ? 'border-black bg-black text-white shadow-inner'
              : 'border-gray-200 bg-white text-gray-600 hover:border-gray-400 hover:text-black hover:shadow-sm',
          )}
        >
          <Scissors size={15} />
        </button>
        {cutOn && (
          <span
            data-testid="view-tools-badge"
            className="w-9 text-center font-mono text-[8px] font-bold uppercase tracking-wider text-gray-500"
          >
            {cut.axis}
            {Math.round(cut.position * 100)}
          </span>
        )}
      </div>
    </div>
  );
};

export default RoomViewTools;
