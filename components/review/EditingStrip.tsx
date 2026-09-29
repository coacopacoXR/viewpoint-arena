// The amber strip: what the top bar becomes while somebody has Edit on.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH. It replaces the room's top bar
// rather than sitting beside it, and that is the point of the colour as much as of
// the swap: while Edit is on the room is not being run, it is being prepared. The
// pointer, share, privacy and boardroom controls are all things that would change
// the meeting for five other people, and none of them is what this person is here
// to do.
//
// Three tools, one switch and one exit:
//   Undo / Redo — batch BT, and the first thing on the strip because it is the first
//     thing somebody reaches for after a mistake. Ctrl+Z does the same job from
//     anywhere in the room (lib/scene/useSceneEditHistory.ts owns the key bindings);
//     these are icon-only at every width, so they cost no words and are not part of
//     the shedding order below.
//   Whole model | Part — WHAT the tools are attached to, batch BR. The three tools
//     did not change and are not doubled up: Move is Move either way, and a person
//     who has found the tool they want should not have to find it again to use it on
//     something smaller than a whole product.
//   Move / Rotate / Scale — drei's TransformControls modes, applied to whatever that
//     switch says. The gizmo itself is components/Scene/ReviewModelGizmo, inside the
//     canvas; this is only the switch.
//   Reset part / Reset all parts — the way back to the FILE, which undo is not: undo
//     puts a part where the last drag left it, and these put it where the exporter had
//     it before anybody in this meeting touched it.
//   Save this view — the camera where it is, as a viewpoint of the review.
//   Done — gives the edit lock up. The room hears about it and capture resumes.
//
// Only the person editing ever sees this. Everybody else in the room sees
// "Robin is editing the review" instead — see ReviewEditingBanner.
//
// The strip has to FIT, and what it has to fit is not the window. It is handed the same
// box the top bar it replaces is handed — everything between the room's left block and the
// side panel — and since batch BS it MEASURES that box and sheds words, least-important
// first, until it fits: the mechanism batch BQ2 gave the top bar, in lib/useCompactLevel.
// Before that it asked the WINDOW with four different `min-width` rules, which is how it
// came to run past its container at 1600x900 with the side panel open: Reset part, Reset
// all parts and Save this view landed on top of the review's name, and Done — the only way
// out of Edit — was pushed off screen. A window cannot know how wide the block beside the
// strip has grown, and it cannot know that the review is called "Landing gear review,
// variant 3". See EDITING_STRIP_DROP_ORDER for what goes, and in what order.

import React, { useCallback, useMemo } from 'react';
import { Box, Camera, Check, Move3D, Redo2, RotateCcw, Scale, Undo2 } from 'lucide-react';
import { clsx } from 'clsx';
import { findSceneNode, selectedNodeId, useStore } from '../../store';
import { usePresence } from '../../lib/PresenceContext';
import { useCompactLevel } from '../../lib/useCompactLevel';
import { useActiveReviewStore } from '../../lib/activeReviewStore';
import { keepReviewPlacements } from '../../lib/scene/keepPlacements';
import { partTargetFor } from '../../lib/scene/partTransforms';
import { sceneModelLabel, type SceneUpdate } from '../../lib/scene/roomScene';
import { useSceneEditHistory } from '../../lib/scene/useSceneEditHistory';
import type { ReviewGizmoMode } from '../../types';

const TOOLS: Array<{ mode: Exclude<ReviewGizmoMode, null>; control: EditingStripControl; label: string; icon: React.ReactNode; modelTitle: string; partTitle: string }> = [
  { mode: 'translate', control: 'move',   label: 'Move',   icon: <Move3D size={14} />,    modelTitle: 'Move the selected model',   partTitle: 'Move the selected part' },
  { mode: 'rotate',    control: 'rotate', label: 'Rotate', icon: <RotateCcw size={14} />, modelTitle: 'Rotate the selected model', partTitle: 'Rotate the selected part' },
  { mode: 'scale',     control: 'scale',  label: 'Scale',  icon: <Scale size={14} />,     modelTitle: 'Resize the selected model', partTitle: 'Resize the selected part, one axis at a time' },
];

const RESET_PART = 'Reset part puts it back where the file had it';
const RESET_ALL_PARTS = 'Put every part of this model back where the file had it';

const SENTENCE = 'Editing the review — changes are saved and seen by everyone';
/** What the sentence becomes when there is no room for it. All of it stays in `title`. */
const SENTENCE_SHORT = 'Editing';

/**
 * The order the strip sheds in, least-important first.
 *
 * Index 0 goes at compact level 1, and so on: at level N every entry in the first N has
 * lost its words, each keeping its `title` so a hover still says what it is.
 *
 * The sentence goes first because it is the only thing here that is not a control. It
 * explains the colour, and the colour keeps on explaining it once the words will not fit.
 * Then the two Resets — the way back, but a way back nobody needs until they have moved
 * something — then the three tools from least-used to most, then Save this view.
 *
 * Two things never go. Whole model | Part is the mode, and two icons side by side are a
 * choice nobody can read; they are also the shortest words on the strip. And Done is the
 * way OUT of Edit: a control that loses the word saying what it does at a narrow window is
 * a room somebody cannot leave. The part's own name is the last thing to give, and it
 * gives by truncating rather than by disappearing — 8 characters of a flange name is still
 * more than an icon says, and the whole name leads the tooltip.
 *
 * Exported because the test that pins the order reads it: "sheds least-important first" is
 * a claim about a list, and a list a test cannot see is a list that can be reordered by
 * accident.
 */
export const EDITING_STRIP_DROP_ORDER = [
  'sentence',
  'resetAllParts',
  'resetPart',
  'rotate',
  'scale',
  'move',
  'saveView',
  'partName',
] as const;

/** A piece of the strip whose words it can shed. */
export type EditingStripControl = (typeof EDITING_STRIP_DROP_ORDER)[number];

/** The compact level at which this piece's words go. Level 0 is "everything labelled". */
export function editingStripDropLevelOf(control: EditingStripControl): number {
  return EDITING_STRIP_DROP_ORDER.indexOf(control) + 1;
}

/** The level at which there is nothing left to shed. */
export const EDITING_STRIP_MAX_COMPACT = EDITING_STRIP_DROP_ORDER.length;

const EditingStrip: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const gizmoMode = useStore((s) => s.reviewGizmoMode);
  const setGizmoMode = useStore((s) => s.setReviewGizmoMode);
  const gizmoTarget = useStore((s) => s.reviewGizmoTarget);
  const setGizmoTarget = useStore((s) => s.setReviewGizmoTarget);
  const activeSceneModelId = useStore((s) => s.activeSceneModelId);
  const models = useStore((s) => s.scene.models);
  const sceneEntries = useStore((s) => s.sceneEntries);
  const importedSceneTree = useStore((s) => s.importedSceneTree);
  const selection = useStore((s) => selectedNodeId(s.objectStates));
  const viewpointCount = useActiveReviewStore((s) => s.config?.viewpoints.length ?? 0);
  const { broadcastSceneUpdate, broadcastReviewConfig } = usePresence();
  const applyLocalSceneUpdate = useStore((s) => s.applyLocalSceneUpdate);
  const { record, undo, redo, mayUndo, mayRedo } = useSceneEditHistory();

  /**
   * Which part of which model the tools would move, or null for "nothing to act on".
   *
   * Only asked in Part mode. In Whole model mode the answer is the model the tree has
   * active, exactly as it has been since batch BH, and computing a part target there
   * too would mean two things deciding what the gizmo is attached to.
   *
   * `rootIdOf` comes from the parsed entries rather than from the scene, because a
   * model's root node id is a fact about its FILE (buildSceneTree mints it) and the
   * scene record does not carry one. A model still downloading answers null, and its
   * rows are not in the tree to select yet, so nothing can be pointing at it.
   */
  const partTarget = useMemo(() => {
    if (gizmoTarget !== 'part') return null;
    return partTargetFor(
      models,
      (modelId) => sceneEntries[modelId]?.sceneTree.id ?? null,
      selection,
    );
  }, [gizmoTarget, models, sceneEntries, selection]);

  const targetModel = useMemo(
    () => models.find((model) => model.id === (partTarget?.modelId ?? null)) ?? null,
    [models, partTarget],
  );
  const partName = partTarget?.nodeId
    ? findSceneNode(importedSceneTree, partTarget.nodeId)?.name ?? partTarget.nodeId
    : null;
  // The name on screen: the part's own when the gizmo is on a part, and the label the
  // combined tree gives the model's root when that is what is selected. One value because
  // it is both what is drawn and what the measuring pass has to notice changing.
  const shownName = partName
    ?? importedSceneTree?.children?.find((c) => c.id === selection)?.name
    ?? selection;
  // Whether there is anything for each Reset to undo. Disabled rather than hidden,
  // the strip's rule for every control whose subject comes and goes: a button that
  // appears when there is something to reset teaches what it does, and one that is
  // always there and sometimes does nothing teaches that it is broken.
  const partHasOverride = Boolean(
    partTarget?.nodeId && targetModel?.parts?.[partTarget.nodeId],
  );
  const modelHasParts = Boolean(targetModel && Object.keys(targetModel.parts ?? {}).length > 0);

  /**
   * Send a change to the room, predict it here, and remember it with the review.
   *
   * The third step is the one batch BI added for drags and batch BR needs for resets:
   * the review carries its own copy of every placement, because room storage is the
   * room's and a review outlives it. A reset that reached only the room would have
   * come back the next time the review was opened.
   */
  const send = useCallback((update: SceneUpdate) => {
    broadcastSceneUpdate(update);
    applyLocalSceneUpdate(update);
    keepReviewPlacements(broadcastReviewConfig);
  }, [applyLocalSceneUpdate, broadcastReviewConfig, broadcastSceneUpdate]);

  const resetPart = () => {
    // Locals rather than the narrowed `partTarget.nodeId` inside the callback: TypeScript
    // drops a narrowing of a property at a closure boundary, and the update needs the
    // node id to be the string the guard just proved it is.
    const modelId = partTarget?.modelId;
    const nodeId = partTarget?.nodeId;
    if (!modelId || !nodeId || !targetModel) return;
    record(`Reset a part of ${sceneModelLabel(targetModel)}`, [modelId], () => {
      send({ op: 'setPartTransform', id: modelId, nodeId, transform: null });
    });
  };

  const resetAllParts = () => {
    const modelId = targetModel?.id;
    if (!modelId || !targetModel) return;
    record(`Reset every part of ${sceneModelLabel(targetModel)}`, [modelId], () => {
      send({ op: 'clearPartTransforms', id: modelId });
    });
  };

  /**
   * The camera as it is, as a viewpoint of the review.
   *
   * Named "View N" rather than asking first: the sketch the user approved has the
   * name be the thing the Views Tab renames, and a modal in the middle of a
   * preparation pass is a interruption for something the next tab is better at.
   * A camera pose the canvas would not give up — no renderer yet, a browser that
   * will not hand over its pixels — is a silent no-op rather than a viewpoint at
   * the origin, because a view that jumps somewhere nobody was is worse than a
   * button that appears not to have worked.
   */
  const saveThisView = () => {
    const capture = useStore.getState()._viewCapture?.();
    if (!capture) return;
    const next = useActiveReviewStore.getState().addViewpoint({
      label: `View ${viewpointCount + 1}`,
      position: capture.position,
      lookAt: capture.lookAt,
      thumbnail: capture.thumbnail,
    });
    if (next) broadcastReviewConfig(next);
  };

  // A tool with nothing selected has nothing to act on. Disabled rather than
  // hidden, so the strip does not change shape as the tree's selection moves.
  const inPartMode = gizmoTarget === 'part';
  const toolsEnabled = inPartMode ? partTarget !== null : activeSceneModelId !== null;
  // A model's own root is not a part, and the tools say so: selecting it in Part mode
  // behaves like Whole model, which is what the batch brief asks for and what the
  // gizmo does with it, so the strip must not promise a bolt and deliver a product.
  const onAPart = Boolean(partTarget?.nodeId);
  const nothingToActOn = inPartMode
    ? 'Click a part in the 3D view or in the model tree first'
    : 'Select a model in the tree first';

  const boxRef = React.useRef<HTMLDivElement>(null);
  const barRef = React.useRef<HTMLDivElement>(null);
  // Everything that decides how wide the strip WANTS to be, as one string: which mode it
  // is in, whether there is a part to name, and the name itself — a longer name is a wider
  // strip, so selecting one has to be measured again. Nothing else here changes the width:
  // a disabled button is the same size as an enabled one, and so is a latched tool.
  const contentKey = [
    inPartMode ? 1 : 0,
    partTarget === null ? 0 : 1,
    shownName ?? '',
  ].join('|');
  const compact = useCompactLevel(boxRef, barRef, contentKey, EDITING_STRIP_MAX_COMPACT);
  const shows = (control: EditingStripControl) => compact < editingStripDropLevelOf(control);

  return (
    // The box the strip has to fit, given to it by the room's header row: everything
    // between the left block and the side panel. Centring lives here rather than in
    // Interface so that the thing being measured and the thing being centred are the same
    // element, and so the strip can be measured on its own in a test.
    <div
      ref={boxRef}
      data-testid="editing-strip-box"
      className="flex w-full min-w-0 justify-center pointer-events-none"
    >
    <div
      ref={barRef}
      data-testid="editing-strip"
      className="flex items-center gap-1.5 bg-amber-400 border border-amber-500 rounded-md shadow-sm p-1.5 pointer-events-auto"
    >
      {/* Undo and redo, at the start because that is where every other application
          puts them and where a hand goes first after a mistake. Icon-only at EVERY
          width and therefore not in EDITING_STRIP_DROP_ORDER: batch BS made this strip
          fit by shedding words, and these two have none to shed — a 72px pair is what
          the rest of the strip has to fit around, at 1600px and at 1100px alike.
          Disabled rather than hidden for the strip's usual reason: a control that
          appears the moment there is something to undo teaches what it does, and one
          that is always there and sometimes grey teaches where to find it. */}
      <button
        data-testid="undo-scene-edit"
        onClick={undo}
        disabled={!mayUndo}
        title="Undo (Ctrl+Z)"
        className={clsx(
          'h-9 w-9 shrink-0 flex items-center justify-center rounded-sm border transition-all',
          mayUndo
            ? 'bg-white/80 text-amber-950 border-amber-600/30 hover:border-amber-900/50'
            : 'bg-white/40 text-amber-950/50 border-amber-600/20 cursor-not-allowed',
        )}
      >
        <Undo2 size={14} />
      </button>
      <button
        data-testid="redo-scene-edit"
        onClick={redo}
        disabled={!mayRedo}
        title="Redo (Ctrl+Shift+Z)"
        className={clsx(
          'h-9 w-9 shrink-0 flex items-center justify-center rounded-sm border transition-all',
          mayRedo
            ? 'bg-white/80 text-amber-950 border-amber-600/30 hover:border-amber-900/50'
            : 'bg-white/40 text-amber-950/50 border-amber-600/20 cursor-not-allowed',
        )}
      >
        <Redo2 size={14} />
      </button>

      <div className="w-px h-7 bg-amber-600/40 mx-0.5 shrink-0" />

      {/* What the colour means, and the first thing to lose its words: it is the only text
          here that is not a control, and the amber goes on saying it. The whole sentence
          moves to the tooltip, where a hover finds it. */}
      <span
        title={shows('sentence') ? undefined : SENTENCE}
        className="text-[10px] font-bold uppercase tracking-wide text-amber-950 px-1.5 shrink-0"
      >
        {shows('sentence') ? SENTENCE : SENTENCE_SHORT}
      </span>

      <div className="w-px h-7 bg-amber-600/40 mx-0.5 shrink-0" />

      {/* WHAT the tools move. Two buttons in one bordered pair rather than a
          dropdown: it is the first thing somebody has to understand about the
          strip's second half, and a control that shows both of its answers at once
          is the one that needs no explanation. */}
      <div className="flex items-center shrink-0 rounded-sm border border-amber-600/30 overflow-hidden">
        {([
          { target: 'model' as const, label: 'Whole model', title: 'Move, turn and resize the whole model' },
          { target: 'part' as const, label: 'Part', title: 'Move, turn and resize one part of a model' },
        ]).map((option) => (
          <button
            key={option.target}
            data-testid={`gizmo-target-${option.target}`}
            onClick={() => setGizmoTarget(option.target)}
            title={option.title}
            className={clsx(
              'h-9 px-2 flex items-center gap-1 transition-all text-[10px] font-bold uppercase tracking-wide',
              gizmoTarget === option.target
                ? 'bg-black text-white'
                : 'bg-white/80 text-amber-950 hover:bg-white',
            )}
          >
            {option.target === 'part' && <Box size={12} />}
            {/* The mode keeps its words at every width: two icons side by side are a
                choice nobody can read, and these are the shortest words on the strip. */}
            <span>{option.label}</span>
          </button>
        ))}
      </div>

      {TOOLS.map((tool) => (
        <button
          key={tool.mode}
          onClick={() => setGizmoMode(gizmoMode === tool.mode ? null : tool.mode)}
          disabled={!toolsEnabled}
          title={toolsEnabled ? (onAPart ? tool.partTitle : tool.modelTitle) : nothingToActOn}
          className={clsx(
            'h-9 px-2 shrink-0 flex items-center gap-1.5 rounded-sm border transition-all',
            gizmoMode === tool.mode
              ? 'bg-black text-white border-black'
              : 'bg-white/80 text-amber-950 border-amber-600/30 hover:border-amber-900/50',
            !toolsEnabled && 'opacity-40 cursor-not-allowed',
          )}
        >
          {tool.icon}
          {shows(tool.control) && (
            <span className="text-[10px] font-bold uppercase tracking-wide">{tool.label}</span>
          )}
        </button>
      ))}

      <div className="w-px h-7 bg-amber-600/40 mx-0.5 shrink-0" />

      {/* WHAT Part mode is pointing at, and the way back. The name is the point of
          showing it at all: a gizmo attached to one flange of a 400-part assembly is
          easy to lose track of, and the tree row it came from may be off screen. */}
      {inPartMode && (
        partTarget === null ? (
          <span className="text-[10px] font-bold text-amber-950/80 px-1.5 shrink-0">
            Click a part to move it.
          </span>
        ) : (
          <span className="flex items-center gap-1.5 shrink-0 px-1.5">
            {/* WHAT the gizmo is on. Shed last, and shed by truncating rather than by
                going: the full name leads the tooltip, so a hover on eight characters of a
                400-part assembly still says which flange this is. */}
            <span
              data-testid="gizmo-part-name"
              title={`${shownName ?? ''} — ${partTarget.nodeId
                ? `the gizmo is attached to this part of ${targetModel?.line ?? 'the model'}`
                : 'that is the model’s own root, so the tools move the whole model'}`}
              className={clsx(
                'shrink-0 truncate text-[10px] font-mono font-bold text-amber-950',
                shows('partName') ? 'max-w-[14rem]' : 'max-w-[8ch]',
              )}
            >
              {shownName}
            </span>

            <button
              onClick={resetPart}
              disabled={!partHasOverride}
              title={partHasOverride ? RESET_PART : 'This part is already where the file had it'}
              className={clsx(
                'h-9 px-2 shrink-0 flex items-center gap-1.5 rounded-sm border transition-all',
                partHasOverride
                  ? 'bg-white/80 text-amber-950 border-amber-600/30 hover:border-amber-900/50'
                  : 'bg-white/40 text-amber-950/50 border-amber-600/20 cursor-not-allowed',
              )}
            >
              <Undo2 size={14} />
              {shows('resetPart') && (
                <span className="text-[10px] font-bold uppercase tracking-wide">Reset part</span>
              )}
            </button>

            <button
              onClick={resetAllParts}
              disabled={!modelHasParts}
              title={modelHasParts ? RESET_ALL_PARTS : 'No part of this model has been moved'}
              className={clsx(
                'h-9 px-2 shrink-0 flex items-center gap-1.5 rounded-sm border transition-all',
                modelHasParts
                  ? 'bg-white/80 text-amber-950 border-amber-600/30 hover:border-amber-900/50'
                  : 'bg-white/40 text-amber-950/50 border-amber-600/20 cursor-not-allowed',
              )}
            >
              <Undo2 size={14} />
              {shows('resetAllParts') && (
                <span className="text-[10px] font-bold uppercase tracking-wide">Reset all parts</span>
              )}
            </button>
          </span>
        )
      )}

      <div className="w-px h-7 bg-amber-600/40 mx-0.5 shrink-0" />

      <button
        onClick={saveThisView}
        title="Add the current camera as a viewpoint of the review"
        className="h-9 px-2 shrink-0 flex items-center gap-1.5 rounded-sm border bg-white/80 text-amber-950 border-amber-600/30 hover:border-amber-900/50 transition-all"
      >
        <Camera size={14} />
        {shows('saveView') && (
          <span className="text-[10px] font-bold uppercase tracking-wide">Save this view</span>
        )}
      </button>

      {/* The way out of Edit, and the one word this strip never sheds: a control that
          loses the word saying what it does at a narrow window is a room nobody can leave.
          It is also why the strip sheds anything at all — before it did, Done was the thing
          that went off the right-hand edge of the screen. */}
      <button
        onClick={onDone}
        title="Finish editing and go back to the meeting"
        className="h-9 px-3 shrink-0 ml-auto flex items-center gap-1.5 rounded-sm bg-black text-white border border-black hover:bg-gray-800 transition-all"
      >
        <Check size={14} />
        <span className="text-[10px] font-bold uppercase tracking-wide">Done</span>
      </button>
    </div>
    </div>
  );
};

export default EditingStrip;
