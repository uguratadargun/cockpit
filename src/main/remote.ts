import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AskAnswer, ClaudeSession, Pending, PermissionDecision, RemoteRepo, Result } from "../shared/types";
import type { GateClient, RemoteFrame, RemotePending, RemoteSession } from "./gate";

/**
 * Sessions on the gate server, as this window holds them.
 *
 * A remote session is a `claude` in a pty on the gate host. Its bytes, its
 * questions and its state arrive here on one stream (`/api/v1/remote/stream`)
 * and everything the person does goes back as a request. The rest of the app
 * should not have to care: this turns the server's words into the ones the
 * window already speaks — a terminal id the renderer can subscribe to, a
 * `ClaudeSession` row, a `Pending` item — and routes the other way.
 *
 * Three things the plumbing has to make up for, compared with a local pty:
 *
 * - **No bytes before the renderer listens.** The renderer subscribes to a
 *   terminal when it first draws it and asks for a redraw straight after, so
 *   output is buffered here (a tail) and nothing is pushed for a terminal the
 *   renderer has not drawn yet. Its first redraw pushes the buffer, then asks
 *   the server's TUI to repaint.
 * - **A keystroke is a request.** Typing is coalesced per terminal and sent in
 *   order, one request at a time, so a fast typist or a paste is a handful of
 *   posts rather than one per character, and never arrives shuffled.
 * - **The server's paths are not this machine's.** A session's cwd there is
 *   the connected repository's checkout. The window groups sessions by
 *   directory, so a remote one is shown under the local project it was last
 *   started from (remembered per repository), else under `gate:<repo>`.
 *
 * No `electron` import: tests drive it with a fake client.
 */

// ---------------------------------------------------------------- terminals

/** A remote terminal's id in the window: the server's handle behind this prefix. */
export const REMOTE_PTY_PREFIX = "r-";

export function ptyIdForHandle(handle: string): string {
  return `${REMOTE_PTY_PREFIX}${handle}`;
}

export function isRemotePtyId(ptyId: string): boolean {
  return typeof ptyId === "string" && ptyId.startsWith(REMOTE_PTY_PREFIX);
}

export function handleForPtyId(ptyId: string): string | null {
  return isRemotePtyId(ptyId) ? ptyId.slice(REMOTE_PTY_PREFIX.length) || null : null;
}

/** How much of a terminal's output is kept for a renderer that has not drawn it yet. */
export const SCREEN_BUFFER_BYTES = 256 * 1024;

/** The last `max` characters of `text`: enough to redraw a TUI, bounded for a session that prints for hours. */
export function tail(text: string, max = SCREEN_BUFFER_BYTES): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

// ------------------------------------------------------------------- repos

/**
 * A git remote reduced to what identifies the project: `host/org/name`,
 * lowercased, with no scheme, user, port or `.git`. `git@github.com:org/x.git`,
 * `https://user@github.com/org/x` and `ssh://git@github.com:22/org/x.git` all
 * read `github.com/org/x`. Null for something that is not a remote URL (a
 * path, an empty string).
 */
export function normalizeGitUrl(url: string | null | undefined): string | null {
  const text = (url ?? "").trim();
  if (!text) return null;
  let host: string;
  let path: string;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i;
  if (scheme.test(text)) {
    let parsed: URL;
    try {
      parsed = new URL(text);
    } catch {
      return null;
    }
    if (parsed.protocol === "file:") return null;
    host = parsed.hostname;
    path = decodeURIComponent(parsed.pathname);
  } else {
    // scp-like: [user@]host:path — but not a Windows drive (`C:\x`) or a bare path.
    const scp = text.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/);
    if (!scp || /^[a-z]$/i.test(scp[1])) return null;
    host = scp[1];
    path = scp[2];
  }
  const cleaned = path
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+/, "");
  if (!host || !cleaned) return null;
  return `${host}/${cleaned}`.toLowerCase();
}

/** The connected repository whose source is this origin, or null. */
export function matchRepo(origin: string | null | undefined, repos: RemoteRepo[]): RemoteRepo | null {
  const want = normalizeGitUrl(origin);
  if (!want) return null;
  return repos.find((r) => normalizeGitUrl(r.source) === want) ?? null;
}

/**
 * Which local project a repository's remote sessions belong to: the directory
 * a remote session was last started from for it. Kept in a small JSON file so
 * the grouping survives a restart; a file that cannot be read is an empty map.
 */
export class RepoPaths {
  private map: Record<string, string>;

  constructor(private readonly file: string) {
    this.map = {};
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw)) if (typeof v === "string") this.map[k] = v;
      }
    } catch {
      // first launch, or a damaged file: start empty
    }
  }

  static in(dir: string): RepoPaths {
    return new RepoPaths(join(dir, "remote-projects.json"));
  }

  get(repo: string | null): string | null {
    return repo ? (this.map[repo] ?? null) : null;
  }

  set(repo: string, cwd: string): void {
    if (this.map[repo] === cwd) return;
    this.map[repo] = cwd;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, `${JSON.stringify(this.map, null, 2)}\n`);
    } catch {
      // the grouping lasts this launch
    }
  }

  /** The directory a remote session is shown under. */
  cwdFor(repo: string | null): string {
    return this.get(repo) ?? `gate:${repo ?? "server"}`;
  }
}

// ------------------------------------------------------------------- input

/**
 * Keystrokes to a remote terminal, coalesced and in order.
 *
 * Everything typed for one terminal within `delayMs` goes as one request;
 * while a request is out, what is typed next waits and goes in the one after
 * it. One terminal's requests are strictly sequential, so the bytes reach the
 * TUI in the order they were typed; different terminals do not wait on each
 * other. A failed send is reported and dropped — the terminal is likely gone.
 */
export class InputQueue {
  private readonly queued = new Map<string, string>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly send: (key: string, data: string) => Promise<void>,
    private readonly delayMs = 8,
    private readonly onError?: (key: string, error: unknown) => void,
  ) {}

  push(key: string, data: string): void {
    if (!data) return;
    this.queued.set(key, (this.queued.get(key) ?? "") + data);
    if (!this.timers.has(key) && !this.running.has(key)) this.schedule(key);
  }

  /** Resolves once nothing is queued, scheduled or in flight for `key`. */
  async drain(key: string): Promise<void> {
    while (this.timers.has(key) || this.running.has(key) || this.queued.get(key)) {
      const inFlight = this.running.get(key);
      await (inFlight ?? new Promise((r) => setTimeout(r, this.delayMs)));
    }
  }

  /** Forgets what was typed for a terminal that is gone. */
  clear(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    this.queued.delete(key);
  }

  private schedule(key: string): void {
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.pump(key);
    }, this.delayMs);
    this.timers.set(key, timer);
  }

  private async pump(key: string): Promise<void> {
    if (this.running.has(key)) return;
    const work = (async () => {
      for (let data = this.queued.get(key); data; data = this.queued.get(key)) {
        this.queued.delete(key);
        try {
          await this.send(key, data);
        } catch (e) {
          this.onError?.(key, e);
        }
      }
    })();
    this.running.set(key, work);
    await work;
    this.running.delete(key);
    if (this.queued.get(key) && !this.timers.has(key)) this.schedule(key);
  }
}

// --------------------------------------------------------------------- hub

/** The part of GateClient the hub uses; a structural type so tests can hand in a fake. */
export type RemoteApi = Pick<
  GateClient,
  | "remoteStream"
  | "remoteStart"
  | "remoteResume"
  | "remoteInput"
  | "remoteResize"
  | "remoteRedraw"
  | "remoteClose"
  | "remoteAnswer"
  | "remoteDecide"
>;

export interface RemoteHubEvents {
  /** The session list changed (a frame, a start, a connection drop). */
  sessions: () => void;
  /** The pending list changed. */
  pending: () => void;
  /** Bytes for a terminal the renderer has drawn. */
  data: (ptyId: string, data: string) => void;
  exit: (ptyId: string, code: number) => void;
  /** Connected to the stream, or dropped from it. */
  state?: (connected: boolean, error?: string) => void;
}

/** How long a resize waits for the next one before it is sent: dragging a window emits dozens. */
const RESIZE_DEBOUNCE_MS = 80;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class RemoteHub {
  sessions: RemoteSession[] = [];
  pending: RemotePending[] = [];
  connected = false;

  private client: RemoteApi | null = null;
  private abort: AbortController | null = null;
  /** Output per server handle, a tail. */
  private readonly screens = new Map<string, string>();
  /** Handles the renderer has drawn: their bytes are pushed as they come. */
  private readonly shown = new Set<string>();
  private readonly resizeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly input: InputQueue;

  constructor(
    private readonly paths: RepoPaths,
    private readonly events: RemoteHubEvents,
    opts: { inputDelayMs?: number } = {},
  ) {
    this.input = new InputQueue(
      async (handle, data) => {
        if (!this.client) throw new Error("not connected to a gate");
        await this.client.remoteInput(handle, data);
      },
      opts.inputDelayMs ?? 8,
      (handle, e) => console.warn(`[cockpit] remote input to ${handle} failed:`, errorText(e)),
    );
  }

  /**
   * Follows the person's server sessions on this client, or stops following
   * (null). What was on screen stays until the next hello replaces it, so a
   * dropped connection does not blank the list.
   */
  connect(client: RemoteApi | null): void {
    this.abort?.abort();
    this.abort = null;
    this.client = client;
    if (!client) {
      const had = this.sessions.length > 0 || this.pending.length > 0;
      this.sessions = [];
      this.pending = [];
      this.connected = false;
      if (had) {
        this.events.sessions();
        this.events.pending();
      }
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    client.remoteStream((f) => this.onFrame(f), abort.signal, {
      onState: ({ connected, error }) => {
        this.connected = connected;
        this.events.state?.(connected, error);
        if (!connected && this.pending.length) {
          // A question held on the server cannot be answered while the stream
          // is down; it comes back with the next hello if it is still open.
          this.pending = [];
          this.events.pending();
        }
      },
    });
  }

  get active(): boolean {
    return this.client !== null;
  }

  /** One stream frame; public so tests can play a script through it. */
  onFrame(f: RemoteFrame): void {
    switch (f.type) {
      case "hello": {
        this.sessions = Array.isArray(f.sessions) ? f.sessions : [];
        this.pending = Array.isArray(f.pending) ? f.pending : [];
        const live = new Set(this.sessions.map((s) => s.handle).filter((h): h is string => !!h));
        for (const handle of [...this.screens.keys()]) if (!live.has(handle)) this.screens.delete(handle);
        this.events.sessions();
        this.events.pending();
        return;
      }
      case "screen": {
        const screen = tail(f.data ?? "");
        this.screens.set(f.handle, screen);
        // A terminal already drawn is drawn again from the server's buffer:
        // reset first, or the replay lands on top of what is there.
        if (this.shown.has(f.handle)) this.events.data(ptyIdForHandle(f.handle), `\x1bc${screen}`);
        return;
      }
      case "sessions":
        this.sessions = Array.isArray(f.sessions) ? f.sessions : [];
        this.events.sessions();
        return;
      case "pending":
        this.pending = Array.isArray(f.pending) ? f.pending : [];
        this.events.pending();
        return;
      case "data": {
        if (!f.data) return;
        this.screens.set(f.handle, tail((this.screens.get(f.handle) ?? "") + f.data));
        if (this.shown.has(f.handle)) this.events.data(ptyIdForHandle(f.handle), f.data);
        return;
      }
      case "exit": {
        const ptyId = ptyIdForHandle(f.handle);
        const wasShown = this.shown.has(f.handle);
        this.forget(f.handle);
        this.sessions = this.sessions.map((s) =>
          s.handle === f.handle ? { ...s, handle: null, presence: "asleep", status: "exited" } : s,
        );
        if (wasShown) this.events.exit(ptyId, typeof f.code === "number" ? f.code : 0);
        this.events.sessions();
        return;
      }
    }
  }

  // -- the window's view

  claudeSessions(): ClaudeSession[] {
    return this.sessions.map((s) => ({
      id: s.id,
      ptyId: s.handle && s.presence === "live" ? ptyIdForHandle(s.handle) : null,
      cwd: this.paths.cwdFor(s.repo),
      title: s.title,
      startedAt: s.startedAt,
      lastActiveAt: s.lastActiveAt,
      presence: s.handle && s.presence === "live" ? "live" : "asleep",
      status: s.status,
      run: s.run,
      location: "remote",
      repo: s.repo,
    }));
  }

  pendingItems(): Pending[] {
    return this.pending.map((p) => {
      const { handle, repo, ...rest } = p;
      return {
        ...rest,
        location: "remote",
        ptyId: handle ? ptyIdForHandle(handle) : null,
        cwd: this.paths.cwdFor(repo),
      } as Pending;
    });
  }

  findSession(sessionId: string): RemoteSession | null {
    return this.sessions.find((s) => s.id === sessionId) ?? null;
  }

  isPending(id: string): boolean {
    return this.pending.some((p) => p.id === id);
  }

  /** The server session driving a run, if one is. */
  sessionForExecution(executionId: string, clientSession?: string | null): RemoteSession | null {
    return (
      this.sessions.find((s) => s.run?.executionId === executionId) ??
      (clientSession ? this.findSession(clientSession) : null)
    );
  }

  // -- actions

  async start(repo: string, cwd: string, prompt: string | null): Promise<Result<{ ptyId: string }>> {
    const client = this.client;
    if (!client) return { ok: false, error: "not connected to a gate" };
    try {
      const session = await client.remoteStart({ repo, ...(prompt ? { prompt } : {}) });
      this.paths.set(repo, cwd);
      return this.adopt(session);
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  }

  async resume(sessionId: string): Promise<Result<{ ptyId: string }>> {
    const client = this.client;
    if (!client) return { ok: false, error: "not connected to a gate" };
    const known = this.findSession(sessionId);
    if (known?.handle && known.presence === "live") return { ok: true, value: { ptyId: ptyIdForHandle(known.handle) } };
    try {
      return this.adopt(await client.remoteResume(sessionId));
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  }

  /** Takes a session the server just answered with into the list, before the stream says so. */
  private adopt(session: RemoteSession): Result<{ ptyId: string }> {
    if (!session?.handle) return { ok: false, error: "the gate started no terminal for this session" };
    this.sessions = [session, ...this.sessions.filter((s) => s.id !== session.id && s.handle !== session.handle)];
    this.events.sessions();
    return { ok: true, value: { ptyId: ptyIdForHandle(session.handle) } };
  }

  write(ptyId: string, data: string): { ok: boolean } {
    const handle = handleForPtyId(ptyId);
    if (!handle || !this.client) return { ok: false };
    this.input.push(handle, data);
    return { ok: true };
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const handle = handleForPtyId(ptyId);
    if (!handle || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1) return;
    const pending = this.resizeTimers.get(handle);
    if (pending) clearTimeout(pending);
    this.resizeTimers.set(
      handle,
      setTimeout(() => {
        this.resizeTimers.delete(handle);
        this.client?.remoteResize(handle, cols, rows).catch(() => {});
      }, RESIZE_DEBOUNCE_MS),
    );
  }

  /**
   * The renderer drew this terminal and wants a fresh frame. The first time,
   * it is handed what the terminal printed before it was listening; from then
   * on bytes are pushed as they come. Then the server's TUI repaints.
   */
  redraw(ptyId: string): void {
    const handle = handleForPtyId(ptyId);
    if (!handle) return;
    if (!this.shown.has(handle)) {
      this.shown.add(handle);
      const screen = this.screens.get(handle);
      if (screen) this.events.data(ptyId, screen);
    }
    this.client?.remoteRedraw(handle).catch(() => {});
  }

  async close(ptyId: string): Promise<void> {
    const handle = handleForPtyId(ptyId);
    if (!handle || !this.client) return;
    try {
      await this.input.drain(handle);
      await this.client.remoteClose(handle);
    } catch (e) {
      console.warn(`[cockpit] closing remote terminal ${handle} failed:`, errorText(e));
    }
    this.forget(handle);
    this.sessions = this.sessions.map((s) => (s.handle === handle ? { ...s, handle: null, presence: "asleep", status: "exited" } : s));
    this.events.sessions();
  }

  async answer(id: string, answer: AskAnswer): Promise<Result> {
    if (!this.client) return { ok: false, error: "not connected to a gate" };
    const r = await this.client.remoteAnswer(id, answer);
    if (r.ok) this.dropPending(id);
    return r;
  }

  async decide(id: string, decision: PermissionDecision): Promise<Result> {
    if (!this.client) return { ok: false, error: "not connected to a gate" };
    const r = await this.client.remoteDecide(id, decision);
    if (r.ok) this.dropPending(id);
    return r;
  }

  private dropPending(id: string): void {
    const before = this.pending.length;
    this.pending = this.pending.filter((p) => p.id !== id);
    if (this.pending.length !== before) this.events.pending();
  }

  private forget(handle: string): void {
    this.screens.delete(handle);
    this.shown.delete(handle);
    this.input.clear(handle);
    const timer = this.resizeTimers.get(handle);
    if (timer) clearTimeout(timer);
    this.resizeTimers.delete(handle);
  }
}
