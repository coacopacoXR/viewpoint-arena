// One model file, handed to the component that knows how to put it in the scene.
//
// components/UI/SceneTree.tsx owns the whole import pipeline: validate the file,
// share it to /api/models, parse it, then place it beside / over / after what is
// already in the room and write its model_revisions row. Batch BG gave that
// pipeline a second caller — the PLM launch's Onshape document browser
// (components/review/PlmLaunch.tsx), which gets a File back from Onshape and is an
// overlay in the room's Edit panel while SceneTree is a panel in the room's left
// column.
//
// They are not parent and child, and the pipeline is not something to copy: a
// second one would be a second place to get "that file is already in the scene",
// the beside/replace/revision choice and the revision row wrong. So the file
// travels the way a laser target does (lib/laserTargetRef.ts) — module state, no
// React. SceneTree claims the slot for as long as it is mounted; the browser leaves
// the file in it.

type SceneImportTaker = (file: File) => void;

let taker: SceneImportTaker | null = null;

/**
 * Claim the handoff for as long as the caller is mounted.
 *
 * One taker rather than a list: exactly one scene panel is on screen at a time,
 * and two of them taking the same file would import the same model twice. The
 * unregister clears the slot only if it is still the one this caller claimed, so a
 * panel unmounting AFTER its replacement mounted — the arena's tree handing over
 * to the boardroom's — cannot leave the room with nobody to give a file to.
 */
export function claimSceneImports(claim: SceneImportTaker): () => void {
  taker = claim;
  return () => {
    if (taker === claim) taker = null;
  };
}

/**
 * Hand a file to the room's scene, and say whether anything took it.
 *
 * False means no scene panel is mounted — a mobile room, or one still loading —
 * and the caller owes the person a sentence rather than dropping a model they
 * waited for Onshape to translate.
 */
export function handSceneImportFile(file: File): boolean {
  if (taker === null) return false;
  taker(file);
  return true;
}

// ─── Asking the panel to open its picker ────────────────────────────────────
//
// Batch BI gave the import pipeline a third caller, and this one has no file yet:
// an empty room says "No model yet" in the middle of the canvas with an "Import a
// model" button on it, and pressing it has to do exactly what the model tree's
// button does. That button is a hidden <input type="file"> inside SceneTree, which
// owns the validate / share / parse / place pipeline — so the canvas prompt asks
// the tree to open it rather than growing a second picker and a second pipeline.
//
// Same mechanism as the file slot above, for the same reason: the two are not
// parent and child, and module state is how this repo already crosses that gap.

type ImportPickerOpener = () => void;

let opener: ImportPickerOpener | null = null;

/**
 * Claim the right to open the file picker, for as long as the caller is mounted.
 *
 * One opener, exactly as with the file taker: one scene panel is on screen at a
 * time, and two pickers opening for one click would ask the same person to choose
 * a file twice. The unregister clears the slot only while it is still this
 * caller's, so a panel handing over to its replacement cannot leave the room with
 * nothing to open.
 */
export function claimImportPicker(claim: ImportPickerOpener): () => void {
  opener = claim;
  return () => {
    if (opener === claim) opener = null;
  };
}

/**
 * Ask the room's scene panel to open its file picker, and say whether anything
 * heard. False means no panel is mounted, so the caller owes the person a reason
 * the button did nothing rather than silence.
 */
export function requestSceneImportPicker(): boolean {
  if (opener === null) return false;
  opener();
  return true;
}
