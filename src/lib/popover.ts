/**
 * Card popovers are absolutely positioned inside the scrolling .music-list, so
 * on lower rows they open downward into the clipped region below the
 * scrollport and most of their options are invisible. If the panel doesn't
 * fit below its anchor and there is more room above, open it upward instead.
 */
export function flipPopoverUpIfClipped(panel: HTMLElement): void {
  let scroller: HTMLElement | null = panel.parentElement;
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
    scroller = scroller.parentElement;
  }

  const limitTop = scroller ? scroller.getBoundingClientRect().top : 0;
  const limitBottom = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
  const rect = panel.getBoundingClientRect();
  if (rect.bottom <= limitBottom) {
    return;
  }

  const anchor = panel.parentElement;
  if (!anchor) {
    return;
  }

  const spaceAbove = anchor.getBoundingClientRect().top - limitTop;
  const visibleBelow = limitBottom - rect.top;
  if (spaceAbove <= visibleBelow) {
    return;
  }

  panel.style.top = "auto";
  panel.style.bottom = "calc(100% + 4px)";
}
