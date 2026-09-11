/**
 * The on-screen face of one pooled terminal.
 *
 * Owns no xterm of its own: it borrows the pool's host element for the given
 * ptyId, fits it to its container, and hands it back on unmount. The buffer,
 * scrollback and pty subscription all outlive this component, so switching
 * between sessions shows each terminal fully painted at once.
 */
import { useEffect, useRef } from "react";

import { acquireTerminal, attachTerminal, detachTerminal, fitTerminal, reflowTerminal, suspendTerminalRenderer } from "./terminalPool";

export interface PtyTerminalViewProps {
  ptyId: string;
  /** In front of the user right now: holds the WebGL lease and the keyboard focus. */
  active: boolean;
}

export function PtyTerminalView({ ptyId, active }: PtyTerminalViewProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  // Attach this view to the pty's persistent terminal for as long as it is
  // mounted. Re-parenting the pooled host shows the already-rendered content
  // immediately — no blank pane while switching sessions.
  useEffect(() => {
    const container = hostRef.current;
    if (!container) return;
    const entry = attachTerminal(ptyId, container);
    if (!activeRef.current) suspendTerminalRenderer(ptyId);

    // Snap to the bottom immediately on re-attach, before fit settles.
    try {
      entry.term.scrollToBottom();
    } catch {
      /* not yet open */
    }

    // `scrollToEnd` is true for the initial attach so we land on the most
    // recent output; later resize-driven fits pass false so they don't yank a
    // user who scrolled up to read history back down. `initialFitDone` tracks
    // the first fit that ran against a real (non-zero) host, so the
    // ResizeObserver can snap on the FIRST effective fit even when the
    // rAF/timeout fits no-op (mounted under a hidden tab with no size yet).
    let initialFitDone = false;
    const tryFit = (scrollToEnd: boolean): void => {
      // Never fit while the host has no real size — fitTerminal guards that
      // itself; a 0×0 fit would shrink the pty to a tiny grid.
      let fitted = false;
      try {
        fitted = fitTerminal(entry);
        if (fitted) {
          entry.term.refresh(0, Math.max(0, entry.term.rows - 1));
          initialFitDone = true;
        }
      } catch {
        /* host may not be sized yet */
      }
      if (fitted && scrollToEnd) {
        try {
          // Re-parenting the pooled terminal resets the DOM viewport's
          // scrollTop to 0 while xterm's internal scroll state stays at the
          // bottom — the screen LOOKS right, but the first wheel event reads
          // the stale scrollTop and yanks the view to the top of history. A
          // bare scrollToBottom() cannot repair this (already at the bottom
          // internally → no state change → no viewport re-sync), and writing
          // the DOM scrollTop directly races xterm's ignore-next-scroll flag.
          // So force a REAL position change through xterm's own state
          // machine: one line up, then back to the bottom.
          entry.term.scrollLines(-1);
          entry.term.scrollToBottom();
        } catch {
          /* noop */
        }
      }
    };
    // Fit once layout has settled, with two short retries for a container
    // whose flex size lands a frame late. These no-op until the host has a
    // real size, so a terminal mounted under a hidden tab simply waits for
    // the ResizeObserver below to fire the first fit.
    requestAnimationFrame(() => requestAnimationFrame(() => tryFit(true)));
    const retries = [setTimeout(() => tryFit(true), 60), setTimeout(() => tryFit(true), 240)];

    // The ResizeObserver is the authoritative trigger: it fires when the host
    // first gets a real size (its tab becomes visible) and on every later
    // resize. Snap to the bottom on the first effective fit, then never again.
    const ro = new ResizeObserver(() => tryFit(!initialFitDone));
    ro.observe(container);
    const onWinResize = (): void => tryFit(false);
    window.addEventListener("resize", onWinResize);

    // Self-heal after a display wake. Closing the lid sleeps the GPU, which
    // loses the WebGL context and leaves xterm's cached cell height stale —
    // the buffer is intact but only part of it scrolls. Neither the
    // ResizeObserver nor `resize` fire on lid-open (the pixel size is
    // unchanged), so reflow when the page becomes visible or regains focus.
    // reflowTerminal does not scroll, so a user reading history stays put.
    const onWake = (): void => {
      if (document.visibilityState !== "visible") return;
      requestAnimationFrame(() => reflowTerminal(ptyId));
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);

    return () => {
      retries.forEach(clearTimeout);
      ro.disconnect();
      window.removeEventListener("resize", onWinResize);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      // Detach (but DON'T dispose): the terminal keeps running in the pool.
      // Detaching also releases the WebGL lease, so a terminal nobody is
      // looking at stops holding a GPU context an on-screen one needs.
      detachTerminal(ptyId, container);
    };
  }, [ptyId]);

  // Coming to the front: take the renderer lease back (attach is idempotent),
  // fix up the grid for whatever size the container has now, and focus so
  // the next keystroke goes to the child. Going to the back: give the GPU
  // context up while the host stays parented (a hidden tab is a 0×0 host, so
  // no fit runs until it shows again).
  useEffect(() => {
    const container = hostRef.current;
    if (!container) return;
    if (!active) {
      suspendTerminalRenderer(ptyId);
      return;
    }
    const entry = attachTerminal(ptyId, container);
    const raf = requestAnimationFrame(() => {
      reflowTerminal(ptyId);
      try {
        entry.term.scrollToBottom();
        entry.term.focus();
      } catch {
        /* not yet open */
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [active, ptyId]);

  // Focus the terminal on a click anywhere in the view, including the padding
  // around the grid, not just on xterm's own textarea.
  const onMouseDown = (): void => {
    if (!active) return;
    try {
      acquireTerminal(ptyId).term.focus();
    } catch {
      /* noop */
    }
  };

  return (
    <div
      ref={hostRef}
      onMouseDown={onMouseDown}
      style={{ width: "100%", height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden", background: "#0b0e14" }}
    />
  );
}
