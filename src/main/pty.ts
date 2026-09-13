/**
 * The terminal plane's main-process half: one node-pty per open session.
 *
 * Bytes go straight to the window that spawned the pty on `pty:data:<ptyId>`;
 * the exit code follows on `pty:exit:<ptyId>` (see src/shared/ipc.ts). Nothing
 * here knows what a session or a run is — it spawns argv in a cwd with the
 * user's login-shell environment and keeps the child's PIDs from leaking.
 */
import * as pty from "node-pty";
import type { IpcMain, WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { invoke, push } from "../shared/ipc";
import type { PtyInfo } from "../shared/types";
import { ensureKilled, hardKillTree, isAlive, KILL_GRACE_MS } from "./procKill";
import { loginShellEnv, resolveCommand } from "./shellEnv";

export { loginShellEnv } from "./shellEnv";

/** `~` and `~/x` to an absolute path; anything else is returned as-is (trimmed). */
export function expandTilde(p: string): string {
  if (typeof p !== "string") return p;
  const t = p.trim();
  if (!t) return p;
  let out = t;
  if (t === "~") out = homedir();
  else if (t.startsWith("~/") || t.startsWith("~\\")) out = join(homedir(), t.slice(2));
  if (!isAbsolute(out)) return t;
  return resolve(out);
}

export interface SpawnOptions {
  /** Caller-chosen id; a fresh one is minted when omitted. */
  ptyId?: string;
  cwd: string;
  /** `argv[0]` is the command (`claude`), resolved against the login PATH. */
  argv: string[];
  /** Extra environment for the child, merged over the login-shell env. */
  env?: Record<string, string>;
  /** The Claude session id when it is already known (a `--resume`); main sets it later otherwise. */
  sessionId?: string | null;
  cols?: number;
  rows?: number;
  /** The window that receives this pty's bytes. Nothing is ever broadcast. */
  owner: WebContents;
}

interface PtySession {
  ptyId: string;
  proc: pty.IPty;
  cwd: string;
  command: string;
  sessionId: string | null;
  /** The window this pty's `pty:data` / `pty:exit` route to, and only it. */
  owner: WebContents;
  /** Epoch ms of the most recent byte the child emitted. */
  lastOutputAt: number;
  /** Epoch ms of the last `onOutput` notification, for the coarse throttle. */
  lastNotifiedAt: number;
  /** True once the child has emitted at least one frame: a caller that wants
   *  to type a first prompt waits for this so it cannot outrun the TUI. */
  hasOutput: boolean;
  /** Resolved when node-pty reports the child gone (or never, if it wedges). */
  exited: Promise<number>;
  resolveExit: (code: number) => void;
}

/** Minimum gap between two `onOutput` notifications for the same pty. */
const OUTPUT_NOTIFY_MS = 250;

/**
 * Windows only: the args portion of `cmd.exe /d /s /c "<target> <args...>"`,
 * for a target CreateProcess cannot run itself (a `.cmd` shim). Every token is
 * quoted when it holds whitespace, a quote, or a cmd metacharacter; the whole
 * inner command gets one outer quote pair that `/s` strips. Handed to node-pty
 * as a STRING so it is passed through verbatim, never re-escaped.
 *
 * Lossy by nature: cmd.exe cuts an argument at its first newline and caps the
 * line near 8191 chars. Fine for `claude --resume <id>`; do not put a long
 * multi-line prompt through it on Windows.
 */
export function buildCmdCommandLine(resolved: string, args: string[]): string {
  const quoteToken = (s: string): string => {
    const escaped = s.replace(/"/g, '\\"');
    return /[ \t"&|^<>()%!]/.test(s) ? `"${escaped}"` : escaped;
  };
  const inner = [resolved, ...args].map(quoteToken).join(" ");
  return `/d /s /c "${inner}"`;
}

export class PtyManager {
  private readonly sessions = new Map<string, PtySession>();
  private readonly exitListeners = new Set<(ptyId: string, code: number) => void>();
  private readonly outputListeners = new Set<(ptyId: string, at: number) => void>();

  /**
   * Start a child in a pty. Throws when the cwd is missing, argv is empty, the
   * id is taken, or node-pty refuses; the caller turns that into a `Result`.
   * The returned PtyInfo is the registry entry as of now.
   */
  spawn(opts: SpawnOptions): PtyInfo {
    const ptyId = opts.ptyId ?? `pty-${randomUUID().slice(0, 8)}`;
    if (this.sessions.has(ptyId)) throw new Error(`pty already exists: ${ptyId}`);
    if (!opts.argv.length) throw new Error("spawn needs argv[0]");
    // `existsSync('~/x')` is always false — only a shell expands `~`.
    const cwd = expandTilde(opts.cwd);
    if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);

    const [command, ...args] = opts.argv;
    const resolved = resolveCommand(command);
    if (!resolved.found) throw new Error(`command not found on the login PATH: ${command}`);

    // On Windows only .exe/.com can be handed to CreateProcess; an npm `.cmd`
    // shim (which is what `claude` usually is there) has to go through cmd.exe.
    const isWin = process.platform === "win32";
    const lower = resolved.path.toLowerCase();
    const needsCmd = isWin && !(lower.endsWith(".exe") || lower.endsWith(".com"));
    const file = needsCmd ? process.env.ComSpec || "cmd.exe" : resolved.path;
    const spawnArgs: string[] | string = needsCmd ? buildCmdCommandLine(resolved.path, args) : args;

    const shellEnv = loginShellEnv();
    const env: Record<string, string> = {
      ...shellEnv,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      FORCE_COLOR: "1",
      // A Finder/Dock-launched app inherits NO locale from launchd, so without
      // this every child runs in the C/POSIX locale — where macOS's default
      // text encoding is Mac OS Roman and any locale-aware tool paints "—" as
      // "‚Äî". The terminal on the other end IS UTF-8 (xterm.js + Unicode 11),
      // so say so. LC_CTYPE only: it is the encoding category, and LC_ALL would
      // also override collation and dates for a user who never exported one.
      ...(isWin
        ? {}
        : {
            LANG: shellEnv.LANG ?? "en_US.UTF-8",
            LC_CTYPE: shellEnv.LC_ALL ?? shellEnv.LC_CTYPE ?? shellEnv.LANG ?? "en_US.UTF-8",
          }),
      ...(opts.env ?? {}),
    };

    const proc = pty.spawn(file, spawnArgs, {
      name: "xterm-256color",
      cols: opts.cols ?? 100,
      rows: opts.rows ?? 30,
      cwd,
      env,
    });

    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((r) => {
      resolveExit = r;
    });
    // Capture THIS session object so the proc's callbacks can tell whether the
    // id still belongs to them. A respawn does kill()+spawn() under the SAME
    // id: the old process's death is asynchronous, so its onData/onExit can
    // fire AFTER the replacement is already in the map. Without the identity
    // guard the dying process would (a) spray its final bytes into the new
    // TUI's fresh frame and (b) on exit delete the replacement and emit a
    // false `pty:exit`, cutting input to the session that just started.
    const session: PtySession = {
      ptyId,
      proc,
      cwd,
      command: resolved.path,
      sessionId: opts.sessionId ?? null,
      owner: opts.owner,
      lastOutputAt: Date.now(),
      lastNotifiedAt: 0,
      hasOutput: false,
      exited,
      resolveExit,
    };
    this.sessions.set(ptyId, session);

    proc.onData((data) => {
      // Trailing output from a process whose id was reclaimed or killed would
      // corrupt the live screen — drop it.
      if (this.sessions.get(ptyId) !== session) return;
      const now = Date.now();
      session.hasOutput = true;
      session.lastOutputAt = now;
      this.safeSend(session.owner, push.ptyData(ptyId), data);
      if (now - session.lastNotifiedAt >= OUTPUT_NOTIFY_MS) {
        session.lastNotifiedAt = now;
        for (const cb of this.outputListeners) {
          try {
            cb(ptyId, now);
          } catch {
            /* a listener's bug must not stall the stream */
          }
        }
      }
    });
    proc.onExit(({ exitCode }) => {
      session.resolveExit(exitCode);
      // A stale exit from a reclaimed id must not touch the live session or
      // tell the renderer the new pty died.
      if (this.sessions.get(ptyId) !== session) return;
      this.sessions.delete(ptyId);
      this.safeSend(session.owner, push.ptyExit(ptyId), exitCode);
      for (const cb of this.exitListeners) {
        try {
          cb(ptyId, exitCode);
        } catch {
          /* never throw out of node-pty's exit callback */
        }
      }
    });

    return this.info(session);
  }

  /** Never throws; `{ ok: false }` for a pty that is gone. */
  write(ptyId: string, data: string): { ok: boolean } {
    const s = this.sessions.get(ptyId);
    if (!s) return { ok: false };
    try {
      s.proc.write(data);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const s = this.sessions.get(ptyId);
    if (!s) return;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1) return;
    try {
      s.proc.resize(cols, rows);
    } catch {
      /* child already gone */
    }
  }

  /** Ask the foreground TUI for a fresh frame without changing its geometry.
   *  Startup output may predate the renderer's subscription, and a same-sized
   *  first fit otherwise emits no resize — so a freshly attached xterm would
   *  stay blank until the TUI happened to repaint. node-pty ignores a resize
   *  to the current size on some platforms, so wiggle one column and back. */
  redraw(ptyId: string): void {
    const s = this.sessions.get(ptyId);
    if (!s) return;
    try {
      const { cols, rows } = s.proc;
      s.proc.resize(Math.max(2, cols - 1), rows);
      s.proc.resize(cols, rows);
    } catch {
      /* child already gone */
    }
  }

  /**
   * Explicit kill: polite signal, wait for the exit (or the grace period),
   * then sweep the process group so MCP servers and helpers do not outlive
   * the session. The registry entry goes synchronously, so a respawn under
   * the same id can start at once and the old process's late events are
   * dropped. Does NOT fire `onExit` listeners or `pty:exit` — the caller
   * asked for this and already knows.
   */
  async kill(ptyId: string): Promise<void> {
    const s = this.sessions.get(ptyId);
    if (!s) return;
    this.sessions.delete(ptyId);
    const pid = s.proc.pid;
    try {
      s.proc.kill();
    } catch {
      /* already gone */
    }
    await Promise.race([s.exited, new Promise<void>((r) => setTimeout(r, KILL_GRACE_MS).unref?.())]);
    hardKillTree(pid);
  }

  /** Kill every pty owned by a window; for its `closed` event, so no child is
   *  left writing to a destroyed WebContents. */
  killByOwner(wc: WebContents): void {
    for (const [ptyId, s] of [...this.sessions.entries()]) {
      if (s.owner === wc) void this.kill(ptyId);
    }
  }

  /** Wholesale shutdown for app quit. With `graceMs === 0` the sweep is
   *  synchronous: there will be no later tick for a deferred one, and a
   *  child that traps HUP would otherwise outlive the app. */
  killAll(graceMs: number = KILL_GRACE_MS): void {
    for (const s of this.sessions.values()) {
      const pid = s.proc.pid;
      try {
        s.proc.kill();
      } catch {
        /* noop */
      }
      if (graceMs === 0) hardKillTree(pid);
      else ensureKilled(pid, graceMs);
    }
    this.sessions.clear();
  }

  get(ptyId: string): PtyInfo | null {
    const s = this.sessions.get(ptyId);
    return s ? this.info(s) : null;
  }

  list(): PtyInfo[] {
    return [...this.sessions.values()].map((s) => this.info(s));
  }

  /** Main learns the Claude session id from a hook after the spawn. */
  setSession(ptyId: string, sessionId: string): void {
    const s = this.sessions.get(ptyId);
    if (s) s.sessionId = sessionId;
  }

  /** Natural exits only (the child finished, crashed, or was killed from outside). */
  onExit(cb: (ptyId: string, code: number) => void): () => void {
    this.exitListeners.add(cb);
    return () => {
      this.exitListeners.delete(cb);
    };
  }

  /** Coarse "it printed something" ticks, at most one per quarter second per
   *  pty — for a "last output at" column, not for the bytes. */
  onOutput(cb: (ptyId: string, at: number) => void): () => void {
    this.outputListeners.add(cb);
    return () => {
      this.outputListeners.delete(cb);
    };
  }

  private info(s: PtySession): PtyInfo {
    return {
      ptyId: s.ptyId,
      sessionId: s.sessionId,
      cwd: s.cwd,
      pid: s.proc.pid,
      // A registry read is not proof of life: node-pty's exit event can simply
      // never come (a child wedged across a long sleep, an external SIGKILL of
      // the group). Probe the pid instead of trusting the map.
      alive: isAlive(s.proc.pid),
      hasOutput: s.hasOutput,
      lastOutputAt: s.lastOutputAt,
    };
  }

  /** Send only to a window that still exists. Killing a pty during quit fires
   *  onExit after app.quit() may have destroyed the window, and `.send()` on a
   *  destroyed WebContents throws "Object has been destroyed" — which surfaces
   *  as the main-process crash dialog. */
  private safeSend(wc: WebContents, channel: string, payload: unknown): void {
    if (wc.isDestroyed()) return;
    try {
      wc.send(channel, payload);
    } catch {
      /* window tore down mid-send */
    }
  }
}

/**
 * Terminals that are not ptys of this process — the gate server's — answer
 * the same three calls. The renderer never knows which kind it is typing
 * into; the router claims the ids that are its own.
 */
export interface TerminalRouter {
  owns(ptyId: string): boolean;
  write(ptyId: string, data: string): { ok: boolean };
  resize(ptyId: string, cols: number, rows: number): void;
  redraw(ptyId: string): void;
}

/** The pty half of the invoke surface. Session open/start/close live with
 *  whoever owns sessions; these are the four the terminal view itself calls. */
export function registerPtyIpc(ipcMain: IpcMain, ptys: PtyManager, other?: TerminalRouter): void {
  const routed = (ptyId: string) => (other?.owns(ptyId) ? other : null);
  ipcMain.handle(invoke.ptyWrite, (_e, ptyId: string, data: string) => (routed(ptyId) ?? ptys).write(ptyId, data));
  ipcMain.handle(invoke.ptyResize, (_e, ptyId: string, cols: number, rows: number) => {
    (routed(ptyId) ?? ptys).resize(ptyId, cols, rows);
  });
  ipcMain.handle(invoke.ptyRedraw, (_e, ptyId: string) => {
    (routed(ptyId) ?? ptys).redraw(ptyId);
  });
  ipcMain.handle(invoke.ptyList, () => ptys.list());
}
