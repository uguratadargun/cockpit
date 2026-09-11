/**
 * A window-wide pool of live xterm terminals, one per ptyId.
 *
 * Why: node-pty keeps no scrollback. If we created and disposed an xterm every
 * time the user switched sessions, the new terminal would be empty and stay
 * blank until the TUI happened to repaint — the "terminal vanishes until I
 * resize the window" bug.
 *
 * Instead each pty gets ONE Terminal for the window's lifetime. It is opened
 * into a detached host <div> and subscribes to the pty stream once, so its
 * buffer is always populated. A view (PtyTerminalView) simply re-parents that
 * host element into itself when it mounts and unparents it on unmount — the
 * rendered content moves with it, so the terminal is visible immediately, no
 * repaint required.
 */
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";

import { sanitizeTerminalSelection } from "./terminalSelection";

export const TERMINAL_FONT_FAMILY =
  '"SF Mono", Menlo, Monaco, "Cascadia Mono", Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';
export const TERMINAL_FONT_SIZE = 13;

/** One dark palette. The 16 ANSI slots are picked by programs by MEANING
 *  ("red" for an error), so they keep their hue; every one reads at 4.5:1 or
 *  better on the ground. */
export const TERMINAL_THEME: ITheme = {
  background: "#0b0e14",
  foreground: "#d7dce2",
  cursor: "#e6edf3",
  cursorAccent: "#0b0e14",
  selectionBackground: "#2b4a6e",
  selectionInactiveBackground: "#22364d",
  black: "#1f242b",
  red: "#f47067",
  green: "#57ab5a",
  yellow: "#c69026",
  blue: "#539bf5",
  magenta: "#b083f0",
  cyan: "#39c5cf",
  white: "#adbac7",
  brightBlack: "#768390",
  brightRed: "#ff938a",
  brightGreen: "#6bc46d",
  brightYellow: "#daaa3f",
  brightBlue: "#6cb6ff",
  brightMagenta: "#dcbdfb",
  brightCyan: "#56d4dd",
  brightWhite: "#cdd9e5",
};

export interface TerminalEntry {
  ptyId: string;
  term: Terminal;
  fit: FitAddon;
  /** The element xterm renders into; views re-parent this in and out of the DOM. */
  host: HTMLDivElement;
  /** xterm is only `open()`ed once its host is first attached to the document. */
  opened: boolean;
  exited: boolean;
  /** Stream subscriptions to tear down on dispose. */
  unsub: Array<() => void>;
  webgl?: WebglAddon;
  /** The DOM renderer took over from a lost/released WebGL context and
   *  inherited stale cell metrics; repaint on the next chance. */
  needsRendererRepaint: boolean;
  initialRedrawRequested: boolean;
  webglRecoveryPending: boolean;
}

const pool = new Map<string, TerminalEntry>();

/** The same palette on white: GitHub's light ANSI set, which stays legible for TUI colour pairs. */
export const TERMINAL_THEME_LIGHT: ITheme = {
  background: "#ffffff",
  foreground: "#1f2328",
  cursor: "#1f2328",
  cursorAccent: "#ffffff",
  selectionBackground: "#b6d7ff",
  selectionInactiveBackground: "#d9e8fb",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#4d2d00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};

let currentTheme: ITheme = TERMINAL_THEME;

/** Switches every terminal, open or pooled, to the theme; new ones are created with it. */
export function setTerminalTheme(mode: "dark" | "light"): void {
  currentTheme = mode === "light" ? TERMINAL_THEME_LIGHT : TERMINAL_THEME;
  for (const entry of pool.values()) entry.term.options.theme = currentTheme;
}

/** Follow output only while the viewport is at (or one line above) the bottom,
 *  so a user reading history is not yanked down by every new byte. */
function shouldFollowOutput(viewportY: number, baseY: number): boolean {
  return baseY - viewportY <= 1;
}

/** Get (or lazily create) the persistent terminal for a pty. */
export function acquireTerminal(ptyId: string): TerminalEntry {
  const existing = pool.get(ptyId);
  if (existing) return existing;

  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";

  const term = new Terminal({
    theme: currentTheme,
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: TERMINAL_FONT_SIZE,
    // 1.0 so TUI box-drawing rows stay joined.
    lineHeight: 1.0,
    cursorBlink: true,
    cursorStyle: "block",
    // xterm allocates a Uint32Array per line, so scrollback is the one thing
    // in the renderer that grows with session length: at a wide terminal
    // 10000 lines is ~10 MB per pty, which is a deep history at a sane cost.
    scrollback: 10000,
    // xterm's default is 1 line per wheel "tick" — noticeably heavier than a native
    // terminal's mouse-wheel feel; this brings it closer to iTerm/Terminal.app.
    scrollSensitivity: 3,
    // When a program paints a coloured cell background while leaving the
    // default foreground, xterm adjusts the foreground per cell to keep at
    // least this contrast (WCAG AA) against the actual background.
    minimumContrastRatio: 4.5,
    macOptionIsMeta: true,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Unicode 11 width tables: xterm's default (Unicode 6) counts most emoji as
  // ONE cell wide, but Claude Code positions text with modern widths (emoji =
  // two cells) — the glyph then overflows its cell and merges with the text
  // after it. Match the TUI's idea of character width.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  // Don't open() yet — xterm needs its host connected to the document to
  // measure a cell. We open on first attach (see attachTerminal).

  const entry: TerminalEntry = {
    ptyId,
    term,
    fit,
    host,
    opened: false,
    exited: false,
    unsub: [],
    needsRendererRepaint: false,
    initialRedrawRequested: false,
    webglRecoveryPending: false,
  };

  // Subscribe to the pty stream ONCE for the terminal's whole lifetime, so the
  // buffer keeps filling even while this terminal isn't mounted in any view.
  entry.unsub.push(
    window.cockpit.pty.onData(ptyId, (chunk) => {
      if (!chunk) return;
      const active = term.buffer.active;
      const follow = shouldFollowOutput(active.viewportY, active.baseY);
      term.write(chunk, () => {
        if (follow) {
          try {
            term.scrollToBottom();
          } catch {
            /* terminal may be detaching */
          }
        }
      });
    }),
  );
  // A respawn under the same ptyId does kill() then spawn() in main; the
  // killed process's late exit is suppressed there (main drops the registry
  // entry synchronously and the process checks it still owns the id before
  // emitting), so an exit that reaches here is always this pty's own.
  entry.unsub.push(
    window.cockpit.pty.onExit(ptyId, (code) => {
      entry.exited = true;
      term.writeln(`\r\n\x1b[2m─ process exited (code ${code}) ─\x1b[0m`);
    }),
  );

  // ── Copy / paste ────────────────────────────────────────────────────────
  // With an accelerated renderer there is no DOM text, so the browser's own
  // copy cannot see the terminal — the selection lives inside xterm. And an
  // Electron window without an Edit menu gets no Cmd+C/Cmd+V at all on macOS,
  // so the terminal handles its own:
  //   Ctrl/Cmd+C with a selection → copy (without one it stays SIGINT)
  //   Ctrl/Cmd+Shift+C            → copy ;  Cmd+V / Ctrl+Shift+V → paste
  //   right-click                 → copy the selection, else paste
  const copySelection = (): boolean => {
    if (!term.hasSelection()) return false;
    // Selections come off the character GRID, so a gutter the CLI painted
    // there (a blockquote's `▎`) is part of the copied cells. Strip it.
    const text = sanitizeTerminalSelection(term.getSelection());
    // Still `true` when a rail-only selection sanitizes to nothing: the
    // gesture was a copy and must stay one, or right-click would paste.
    if (text) void navigator.clipboard.writeText(text).catch(() => {});
    return true;
  };
  const pasteClipboard = (): void => {
    if (entry.exited) return;
    navigator.clipboard
      .readText()
      .then((text) => {
        if (text) term.paste(text);
      })
      .catch(() => {});
  };
  const isMac = navigator.platform.toUpperCase().includes("MAC");
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== "keydown") return true;
    if (!(ev.ctrlKey || ev.metaKey)) return true;
    const key = ev.key.toLowerCase();
    if (key === "c" && (ev.shiftKey || term.hasSelection())) {
      // Clear the selection after a plain Ctrl+C copy so a second Ctrl+C
      // still interrupts the child as usual.
      if (copySelection() && !ev.shiftKey) term.clearSelection();
      ev.preventDefault();
      return false;
    }
    if (key === "v" && (ev.shiftKey || (isMac && ev.metaKey))) {
      pasteClipboard();
      ev.preventDefault();
      return false;
    }
    return true;
  });
  host.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    if (copySelection()) {
      term.clearSelection();
      return;
    }
    pasteClipboard();
  });

  // Keystrokes → pty.
  term.onData((data) => {
    if (entry.exited) return;
    void window.cockpit.pty.write(ptyId, data);
  });

  pool.set(ptyId, entry);
  return entry;
}

/** Give this terminal a WebGL renderer for as long as it is on screen.
 *
 *  The DOM renderer assumes a perfectly monospace font, but fallback glyphs
 *  (arrows, some box-drawing) come with different advance widths, so tables
 *  shear apart and the cursor drifts. WebGL draws every glyph into its own
 *  fixed cell, keeping the grid aligned. Not the deprecated canvas addon (its
 *  dirty-region tracking garbles scrollback).
 *
 *  It is a LEASE, taken on attach and released on detach, because Chromium
 *  allows only about 16 live WebGL contexts and silently discards the oldest
 *  when a new one pushes past the cap. A terminal that held its context while
 *  off screen would have it killed under it: pty, buffer and subscription
 *  all healthy, only the renderer dead — "the terminal is black and typing
 *  does nothing".
 *
 *  Best-effort: on init failure or context loss, fall back to the DOM
 *  renderer rather than leave a black terminal. */
function leaseWebglRenderer(entry: TerminalEntry): void {
  if (entry.webgl) return;
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      if (entry.webgl !== webgl) return;
      console.warn("[terminal] webgl context lost — falling back to the DOM renderer");
      entry.webgl = undefined;
      entry.needsRendererRepaint = true;
      try {
        webgl.dispose();
      } catch {
        /* noop */
      }
      // Laptop sleep == GPU sleep == WebGL context loss. The renderer swap
      // leaves xterm's cached cell height (and the viewport scroll area
      // derived from it) stale, so only part of the intact buffer scrolls
      // until something forces a re-measure. Heal it on the next frame, once
      // the waking layout has settled.
      scheduleRendererRecovery(entry);
    });
    // Set before loadAddon: an immediately-lost context may call the handler
    // during initialization, and it must be recognized as the active renderer.
    entry.webgl = webgl;
    entry.term.loadAddon(webgl);
  } catch (e) {
    try {
      entry.webgl?.dispose();
    } catch {
      /* noop */
    }
    entry.webgl = undefined;
    console.warn("[terminal] webgl renderer unavailable, using the DOM renderer:", e);
  }
}

/** Release the WebGL lease so an off-screen terminal isn't holding a GPU
 *  context an on-screen one needs. The buffer and pty subscription stay. */
function releaseWebglRenderer(entry: TerminalEntry): void {
  const webgl = entry.webgl;
  if (!webgl) return;
  entry.webgl = undefined;
  try {
    webgl.dispose();
  } catch {
    /* noop */
  }
  // The DOM renderer that takes over inherits xterm's cached cell metrics,
  // which may be stale by the time this terminal is shown again.
  entry.needsRendererRepaint = true;
}

/** Wait two paint frames after a renderer swap so the DOM renderer can paint,
 *  then re-measure. When the repaint could not happen (host detached or
 *  unsized) the needs-repaint marker stays set, so a later attach tries again.
 *  Clearing it before the repaint was confirmed is what made blank terminals
 *  recover only "sometimes". */
function scheduleRendererRecovery(entry: TerminalEntry): void {
  if (entry.webglRecoveryPending) return;
  entry.webglRecoveryPending = true;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      entry.webglRecoveryPending = false;
      repaintAfterRendererLoss(entry);
    }),
  );
}

function repaintAfterRendererLoss(entry: TerminalEntry): void {
  if (!entry.opened || !entry.host.isConnected || !entry.host.clientWidth || !entry.host.clientHeight) {
    entry.needsRendererRepaint = true;
    return;
  }
  reflowTerminal(entry.ptyId);
  try {
    entry.term.refresh(0, Math.max(0, entry.term.rows - 1));
    entry.needsRendererRepaint = false;
  } catch {
    entry.needsRendererRepaint = true;
  }
}

/** Request exactly one redraw after the renderer has subscribed to the pty.
 *  Startup output can predate the pooled terminal's subscription, and a
 *  same-sized first fit emits no resize of its own, so without this a fresh
 *  xterm over a running TUI stays blank until the TUI repaints by itself.
 *  The latch is cleared again when the IPC rejects, so the next attach retries. */
function requestInitialRedraw(entry: TerminalEntry): void {
  if (entry.initialRedrawRequested) return;
  entry.initialRedrawRequested = true;
  window.cockpit.pty.redraw(entry.ptyId).catch(() => {
    entry.initialRedrawRequested = false;
  });
}

/** Re-parent a pty's terminal into `container`, opening xterm on first attach.
 *  Idempotent: attaching to the container that already holds the host only
 *  re-takes the WebGL lease and re-arms the repaint. */
export function attachTerminal(ptyId: string, container: HTMLElement): TerminalEntry {
  const entry = acquireTerminal(ptyId);
  if (entry.host.parentElement !== container) container.appendChild(entry.host);
  if (!entry.opened) {
    // open() must come first — the WebGL addon can only load onto an opened
    // terminal, and xterm needs its host in the document to measure the cell.
    entry.term.open(entry.host);
    entry.opened = true;
  }
  leaseWebglRenderer(entry);
  requestInitialRedraw(entry);
  if (entry.needsRendererRepaint) scheduleRendererRecovery(entry);
  return entry;
}

/** Take the terminal off screen: drop the WebGL lease and unparent the host.
 *  Everything that makes the terminal a terminal — buffer, scrollback, pty
 *  subscription — stays in the pool, so re-attaching shows it fully rendered.
 *
 *  When `container` is given and another view has already taken the host
 *  (React can mount the new owner before the old one's cleanup runs), this is
 *  a no-op: releasing the renderer then would blank the terminal that just
 *  legitimately claimed it. */
export function detachTerminal(ptyId: string, container?: HTMLElement): void {
  const entry = pool.get(ptyId);
  if (!entry) return;
  const parent = entry.host.parentElement;
  if (!parent) return;
  if (container && parent !== container) return;
  releaseWebglRenderer(entry);
  parent.removeChild(entry.host);
}

/** Keep the host where it is but give up the GPU context: for a terminal that
 *  stays mounted while another tab is in front of it. `attachTerminal` takes
 *  the lease back. */
export function suspendTerminalRenderer(ptyId: string): void {
  const entry = pool.get(ptyId);
  if (entry) releaseWebglRenderer(entry);
}

/**
 * Re-measure cell metrics and rebuild the viewport scroll area for a pooled
 * terminal. For a display wake, a lost WebGL context, a DPR change: xterm
 * caches the cell height measured at open() and only recomputes it on a font
 * change or resize. When that goes stale, the viewport's scroll area (rows ×
 * cell height) is wrong, so only PART of the still-intact buffer scrolls.
 *
 * Re-applying the SAME font options invalidates the cached metrics,
 * clearTextureAtlas re-rasters the glyph atlas, then fit() recomputes
 * cols/rows and rebuilds the viewport. The pty is only told when the grid
 * actually changed (every resize makes the TUI repaint its whole screen, and
 * each repaint pushes the previous frame into scrollback). Scroll position is
 * preserved — no scrollToBottom — so a user reading history isn't yanked down.
 * No-op until the terminal is opened and its host has a real size, so several
 * triggers firing together are harmless.
 */
export function reflowTerminal(ptyId: string): void {
  const entry = pool.get(ptyId);
  if (!entry || !entry.opened) return;
  const host = entry.host;
  // Fitting a 0×0 host makes xterm propose a tiny grid and resize the pty to
  // it (clipped/oversized banner) — skip while detached or unsized.
  if (!host.isConnected || !host.clientWidth || !host.clientHeight) return;
  try {
    entry.term.options.fontFamily = entry.term.options.fontFamily;
    entry.term.options.fontSize = entry.term.options.fontSize;
    entry.term.clearTextureAtlas?.();
    fitTerminal(entry);
    entry.term.refresh(0, Math.max(0, entry.term.rows - 1));
  } catch {
    /* host may not be sized yet */
  }
}

/** fit() and tell the pty only if cols/rows changed. Returns whether a fit ran. */
export function fitTerminal(entry: TerminalEntry): boolean {
  if (!entry.opened) return false;
  const host = entry.host;
  if (!host.isConnected || !host.clientWidth || !host.clientHeight) return false;
  const before = { cols: entry.term.cols, rows: entry.term.rows };
  entry.fit.fit();
  if (entry.term.cols !== before.cols || entry.term.rows !== before.rows) {
    void window.cockpit.pty.resize(entry.ptyId, entry.term.cols, entry.term.rows);
  }
  return true;
}

/** Tear down a pty's terminal (when the pty is gone for good). */
export function disposeTerminal(ptyId: string): void {
  const entry = pool.get(ptyId);
  if (!entry) return;
  entry.unsub.forEach((u) => {
    try {
      u();
    } catch {
      /* noop */
    }
  });
  try {
    entry.webgl?.dispose();
  } catch {
    /* noop */
  }
  try {
    entry.term.dispose();
  } catch {
    /* noop */
  }
  entry.host.remove();
  pool.delete(ptyId);
}

/** Whether a pooled terminal exists for this pty (no side effects). */
export function hasTerminal(ptyId: string): boolean {
  return pool.has(ptyId);
}
