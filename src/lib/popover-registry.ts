/**
 * At most one card popover (action menu or stack dropdown) may be open at a
 * time. Opening a new one closes the previous, mirroring the behaviour of the
 * pre-SvelteKit app shell.
 */
let activeClose: (() => void) | null = null;

export function registerOpenPopover(close: () => void): void {
  if (activeClose && activeClose !== close) {
    activeClose();
  }
  activeClose = close;
}

export function unregisterPopover(close: () => void): void {
  if (activeClose === close) {
    activeClose = null;
  }
}

export function closeActivePopover(): void {
  activeClose?.();
  activeClose = null;
}
