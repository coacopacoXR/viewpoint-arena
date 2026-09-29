// How compact a horizontal control bar has to be to fit the box the room gave it.
//
// Written for the room's top bar in batch BQ2 and shared with the amber Editing strip in
// batch BS, because the two bars live in the same header row, are handed the same box —
// everything between the room's left block and the side panel — and both used to answer
// the question with a window media query. A window cannot know how wide the block beside
// the bar has grown, nor whether the side panel is open, and the old `min-width: 1500px`
// rules were wrong in both directions: labels at 1600px with the panel open ran under it,
// and no labels at 1280px with the panel closed threw away space that was there.
//
// So the bar MEASURES the box it was given and sheds labels, least-used first, until it
// fits. What each bar sheds, and in what order, is the bar's own business
// (TOP_BAR_DROP_ORDER, EDITING_STRIP_DROP_ORDER); what is shared is the loop, which is the
// part that is easy to get subtly wrong.

import React from 'react';

/**
 * The compact level a bar needs, climbing ONE level per layout pass.
 *
 * There is no table of widths to keep in step with the labels, the icons and the review's
 * name, and none to get wrong when somebody adds a control. The pass runs in a layout
 * effect, so a bar that overflows on the frame it is laid out in is already shorter by the
 * time that frame is painted — and it re-runs on `level`, which is what makes the climb
 * converge, and on `contentKey`, which is what makes it notice that the bar itself changed.
 *
 * The box is measured, not the bar: the bar is a flex item that shrinks to the box while
 * its own children (all `shrink-0`) overflow it, which is exactly what `scrollWidth`
 * reports and what `clientWidth` does not. Watching the box for a change in WIDTH resets
 * to level 0 and lets the climb start again — the panel opening, a window resize, a review
 * being named, a part with a longer name being selected. Height is deliberately ignored: a
 * dropdown opening inside the bar must not cost anybody their labels.
 *
 * @param boxRef      the space the bar has to fit, owned by the bar's own wrapper
 * @param barRef      the bar, whose `scrollWidth` is its natural width
 * @param contentKey  everything that decides how wide the bar WANTS to be, as one string
 * @param maxCompact  the level at which there is nothing left to shed
 */
export function useCompactLevel(
  boxRef: React.RefObject<HTMLDivElement | null>,
  barRef: React.RefObject<HTMLDivElement | null>,
  contentKey: string,
  maxCompact: number,
): number {
  const [level, setLevel] = React.useState(0);
  // Bumped by a resize, so the measuring pass runs again even when the level it would set
  // is the one already there. "The box got narrower while the bar was comfortable" has to
  // be measured from the top, and a setState to the value it already has neither
  // re-renders nor re-measures anything.
  const [pass, setPass] = React.useState(0);

  React.useLayoutEffect(() => {
    const box = boxRef.current;
    const bar = barRef.current;
    if (!box || !bar) return;
    if (bar.scrollWidth <= box.clientWidth + 1) return;
    // Clamped, so a bar that cannot fit even at its most compact stops asking instead of
    // re-rendering for ever.
    setLevel((current) => Math.min(current + 1, maxCompact));
  }, [level, pass, contentKey, maxCompact, boxRef, barRef]);

  React.useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    let lastWidth = box.getBoundingClientRect().width;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? box.getBoundingClientRect().width;
      if (Math.abs(width - lastWidth) < 1) return;
      lastWidth = width;
      setLevel(0);
      setPass((current) => current + 1);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [boxRef]);

  return level;
}
