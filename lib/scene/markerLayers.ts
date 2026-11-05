// The layers the room's comment bubbles and review pins are drawn on — task 09a.
//
// A comment bubble and a pin label are DOM, not geometry: drei's `<Html>` appends a
// positioned div to the canvas's own container and gives it a z-index. The default it
// gives it is `zIndexRange = [16777271, 0]`, which is the largest z-index a browser
// accepts, and the reason is a good one in the abstract — an HTML overlay is supposed to
// read over whatever the WebGL canvas drew. It is exactly wrong here, because this app
// does not put its UI over the canvas with a z-index in the millions. It puts it over the
// canvas with `z-10`:
//
//     pages/RoomPage.tsx
//       <div class="relative flex-1 min-w-0">        position relative, z-index auto
//         <ViewpointCanvas />                        R3F's div: relative, overflow hidden
//         <div class="absolute inset-0 z-10">        ← ALL of components/UI/Interface.tsx
//
// Neither ancestor is a stacking context — `position: relative` with `z-index: auto` is
// not one — so a marker's z-index competes at the ROOT of the document, against that
// wrapper's 10 and not against the `z-[20]`…`z-[250]` numbers written inside it. Those
// are all trapped in the wrapper's own stacking context and cannot be reached from here
// at any value. Which makes the threshold a single number, and a small one: **10**.
//
// The consequence of not knowing that was the bug: every comment bubble painted over the
// Model Tree, over the amber strip, over the side panel, over the call bar and over
// modals, because 16777271 beats all of them from outside their stacking context.
//
// WHAT IS DELIBERATELY NOT HERE: the other `<Html>` users — an agent's name tag, a remote
// participant's, a laser's part label, an imported model's revision bracket. Each of those
// already passes `zIndexRange={[0, 0]}` and has done so since before this task, so they
// are under the UI already and moving them would change a picture nobody complained
// about. The pin label is here because a pin is part of the same family as a comment: the
// two are placed by the same raycast (components/Scene/SpatialComments.tsx's
// 'placing-pin' mode), mirrored into the same comment list
// (lib/activeReviewStore.pinToComment) and hidden by the same switch.
//
// The numbers are exported rather than written at the call sites because the claim they
// make — "under the panels" — is a claim about three files that do not import each other,
// and lib/scene/__tests__/markerLayers.test.ts is what holds them to it.

/**
 * The z-index the room's whole UI overlay is lifted to, in pages/RoomPage.tsx.
 *
 * The ONLY number a scene marker has to stay under. Everything the overlay contains is
 * stacked inside it, so a marker below this is below the Model Tree, the side panel, the
 * bars, the popovers and the modals in one step.
 */
export const ROOM_OVERLAY_Z = 10;

/**
 * The lowest z-index used by an overlay inside components/UI/Interface.tsx.
 *
 * Recorded beside the one that matters because the two are easy to confuse and the
 * confusion is what produced the bug: `z-[20]` is the empty-scene prompt's row, and it is
 * NOT the threshold. It is inside the `z-10` wrapper, so a marker at 15 would already be
 * under it. Asserted in the test as a second, weaker bound so that a future panel dropped
 * below 20 without the wrapper moving is still caught.
 */
export const LOWEST_PANEL_Z = 20;

/**
 * The range a collapsed marker is drawn in: a comment bubble, a pin and its label, and
 * the placement preview.
 *
 * Near end first, the way drei reads the pair: it maps the camera's `near` onto
 * `zIndexRange[0]` and its `far` onto `zIndexRange[1]`, so `[5, 1]` puts a marker close to
 * the camera above one far from it. The span is small because the models in this room sit
 * between one and twenty scene units from a camera whose `far` is a thousand, and a wide
 * range would spend almost all of it on distances nothing occupies — five distinct values
 * is five distinct depths of marker, which is more sorting than a screen of pins needs.
 *
 * A MUTABLE tuple, which is not a choice about mutability: drei types the prop as
 * `number[]`, and a `readonly [number, number]` will not assign to it. Nothing writes to
 * either array — drei reads the pair inside its own frame callback.
 */
export const MARKER_Z_RANGE: [number, number] = [5, 1];

/**
 * The range an OPEN comment card is drawn in: the white card with the text, the assignees
 * and the replies.
 *
 * Entirely above `MARKER_Z_RANGE` and entirely below `ROOM_OVERLAY_Z`, which is the whole
 * of the requirement — a card somebody opened has to cover the bubbles behind it, and
 * still has to go under the Model Tree when it overlaps one. A card is bigger than a
 * bubble and is usually the thing the person is reading, so it wins the overlap.
 */
export const MARKER_Z_RANGE_EXPANDED: [number, number] = [8, 6];

/**
 * How faint a marker goes when the model is in front of it.
 *
 * Faded rather than removed, and 0.15 rather than 0, because a marker that vanishes
 * outright takes the answer to "is there a comment back there?" with it — and that answer
 * is the reason to orbit. At 0.15 the shape and the author's colour are still legible
 * against the model, the text is not, and the marker is not clickable: see
 * lib/scene/markerOcclusion.ts.
 */
export const MARKER_OCCLUDED_OPACITY = 0.15;
