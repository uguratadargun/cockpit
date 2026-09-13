import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

import type {
  AskAnswer,
  ChangedFile,
  Execution,
  GateUsage,
  PendingAsk,
  PendingPermission,
  PermissionDecision,
  RemoteInfo,
  Result,
  RunPointer,
  SessionStatus,
  StreamFrame,
} from "../shared/types";

/**
 * The cockpit's half of gate's `/api/v1`.
 *
 * It shares the login with the `gate` CLI: the same ~/.gate/client.json (or
 * GATE_URL/GATE_KEY in the environment), so a machine that has run
 * `/gate:login` once is connected here too, and a connection made here is
 * one the plugin's commands pick up. Requests carry the person's key and the
 * machine's name, the way src/client/api.ts in the gate repository does; a
 * failure is reported in the server's own words with its status and code.
 *
 * No `electron` import: this file is exercised by plain node tests.
 */

export interface GateConnection {
  url: string;
  key: string;
}

/** A connection token: base64url of `{"u": url, "k": key}` behind this prefix (src/lib/connect-token.ts there). */
export const CONNECT_TOKEN_PREFIX = "gatec_";
/** What an API key itself looks like: `gate_` and 48 hex characters (src/lib/apikeys.ts there). */
export const KEY_PREFIX = "gate_";

export function gateHome(): string {
  return process.env.GATE_HOME || join(homedir(), ".gate");
}

export function clientConfigPath(): string {
  return join(gateHome(), "client.json");
}

function trimSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/** The file's raw contents, whatever else it holds (team, user, trusted, repos). */
function readClientFile(): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(clientConfigPath(), "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The environment wins over the file, as it does for the CLI. */
export function readConnection(): GateConnection | null {
  const url = process.env.GATE_URL;
  const key = process.env.GATE_KEY;
  if (url && key) return { url: trimSlashes(url), key };
  const file = readClientFile();
  if (!file || typeof file.url !== "string" || typeof file.key !== "string" || !file.url || !file.key) return null;
  return { url: trimSlashes(file.url), key: file.key };
}

/** The team name the CLI recorded at login, when the file has one. */
export function readConnectedTeam(): string | null {
  const file = readClientFile();
  return file && typeof file.team === "string" && file.team ? file.team : null;
}

/**
 * Saves a login, keeping everything else the file holds.
 *
 * The CLI records workflow approvals and repo paths in the same file; a new
 * login must not throw those away. `fromEnv` is dropped: it marks a
 * connection that was never on disk, and this one now is.
 */
export function writeConnection(c: GateConnection, extra: Record<string, unknown> = {}): void {
  const file = clientConfigPath();
  const existing = readClientFile() ?? {};
  const { fromEnv: _fromEnv, ...kept } = existing;
  const merged = { ...kept, ...extra, url: trimSlashes(c.url), key: c.key };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  // `mode` above only applies to a file being created; one that already
  // existed keeps whatever it had, and this file is a credential.
  try {
    chmodSync(file, 0o600);
  } catch {
    // not a POSIX filesystem
  }
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

/** Builds a token the way the dashboard does; here for tests and for showing one back. */
export function encodeConnectToken(c: GateConnection): string {
  const json = JSON.stringify({ u: trimSlashes(c.url), k: c.key });
  return CONNECT_TOKEN_PREFIX + Buffer.from(json, "utf8").toString("base64url");
}

/**
 * Reads what the person pasted: a `gatec_…` token, or an address and a key
 * together ("https://gate.example.com gate_…", either order, any whitespace).
 * A bare key is refused with the reason: it does not say where the gate is.
 */
export function parseConnectInput(input: string): GateConnection | { error: string } {
  const text = (input ?? "").trim();
  if (!text) return { error: "paste the connection token from your gate dashboard" };

  if (text.startsWith(CONNECT_TOKEN_PREFIX)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fromBase64Url(text.slice(CONNECT_TOKEN_PREFIX.length)));
    } catch {
      return { error: "this token is damaged — copy it again from your gate dashboard, all of it" };
    }
    const { u, k } = (parsed ?? {}) as { u?: unknown; k?: unknown };
    if (typeof u !== "string" || typeof k !== "string" || !u || !k) {
      return { error: "this token is missing the gate address or the key" };
    }
    if (!/^https?:\/\//.test(u)) return { error: `this token points at "${u}", which is not an http(s) address` };
    return { url: trimSlashes(u), key: k };
  }

  const parts = text.split(/\s+/);
  if (parts.length === 2) {
    const url = parts.find((p) => /^https?:\/\//.test(p));
    const key = parts.find((p) => p.startsWith(KEY_PREFIX));
    if (url && key) return { url: trimSlashes(url), key };
  }
  if (text.startsWith(KEY_PREFIX)) {
    return {
      error: `that is an API key, not a connection token — a key does not say where your gate is. Copy the ${CONNECT_TOKEN_PREFIX}… token from the dashboard, or paste the gate's address and the key together`,
    };
  }
  if (/^https?:\/\/\S+$/.test(text)) {
    return { error: "that is only the gate's address — paste it together with your key, or use the connection token from the dashboard" };
  }
  return { error: `that does not look like a gate token (they start with ${CONNECT_TOKEN_PREFIX})` };
}

// ------------------------------------------------------------------- client

export class GateApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "GateApiError";
  }
}

export interface Me {
  /** The person's name, or their email when they have no name; null for a key with no person behind it. */
  person: string | null;
  email: string | null;
  team: string;
  teamId: string;
  /** The server's version, when it says. */
  version: string | null;
  scopes: string[];
}

/** What the server actually answers on /api/v1/me. */
interface MeResponse {
  user: { id: string; email: string; name: string | null } | null;
  team: { id: string; name: string };
  scopes?: string[];
  gatewayUrl?: string;
  server?: { version: string; minClientVersion: string };
}

// ------------------------------------------------------------------ remote

/**
 * A session on the gate server, as `/api/v1/remote/sessions` lists it.
 *
 * The same words as a local session, with two differences the wire has to
 * carry: the terminal is the server's `handle` (null while asleep), and `cwd`
 * is a path on the server, which means nothing on this machine.
 */
export interface RemoteSession {
  /** Claude Code's session id once a hook named it; `remote:<handle>` before. */
  id: string;
  handle: string | null;
  repo: string | null;
  cwd: string;
  title: string | null;
  startedAt: number;
  lastActiveAt: number;
  presence: "live" | "asleep";
  status: SessionStatus;
  run: RunPointer | null;
}

type WithoutTerminal<T> = Omit<T, "ptyId" | "location"> & { handle: string | null; repo: string | null };

/** A question or permission held on the server: a local Pending with the server's terminal handle in place of a pty. */
export type RemotePending = WithoutTerminal<PendingAsk> | WithoutTerminal<PendingPermission>;

/** One frame of `/api/v1/remote/stream`. */
export type RemoteFrame =
  | { type: "hello"; at: number; sessions: RemoteSession[]; pending: RemotePending[] }
  | { type: "screen"; handle: string; data: string }
  | { type: "sessions"; at: number; sessions: RemoteSession[] }
  | { type: "pending"; at: number; pending: RemotePending[] }
  | { type: "data"; handle: string; data: string }
  | { type: "exit"; handle: string; code: number };

/** What a gate that predates remote sessions is taken to say. */
export const REMOTE_UNSUPPORTED: RemoteInfo = {
  allowed: false,
  available: false,
  reason: "this gate is older than 0.35.0 and cannot run sessions",
  repos: [],
};

export interface StreamOptions {
  /** Told when the stream connects and when it drops (with why). */
  onState?: (state: { connected: boolean; error?: string }) => void;
  /** Reconnect backoff bounds; 1s → 30s by default. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class GateClient {
  constructor(private readonly c: GateConnection) {}

  get url(): string {
    return this.c.url;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    // No `x-gate-cli` header: the server compares that against the oldest CLI
    // it serves, and the cockpit is not a CLI build. Without it the check is
    // skipped and the key alone says who this is.
    return {
      authorization: `Bearer ${this.c.key}`,
      "x-gate-host": hostname(),
      "user-agent": "gate-cockpit",
      ...extra,
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.c.url}${path}`, {
        ...init,
        headers: this.headers(init.body ? { "content-type": "application/json" } : {}),
      });
    } catch (e) {
      const cause = (e as { cause?: { message?: string } }).cause?.message;
      throw new GateApiError(`cannot reach gate at ${this.c.url} (${errorMessage(e)}${cause ? `: ${cause}` : ""})`, 0, "UNREACHABLE");
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON; reported below
    }
    const notGate = () =>
      new GateApiError(`${this.c.url} answered with a web page, not gate's API (HTTP ${res.status}) — check the address`, res.status, "NOT_A_GATE");
    if (!res.ok) {
      if (json?.error) throw new GateApiError(String(json.error), res.status, json.code);
      if (text.trimStart().startsWith("<")) throw notGate();
      throw new GateApiError(text.slice(0, 200) || `HTTP ${res.status}`, res.status);
    }
    if (text && json === null) throw notGate();
    return json as T;
  }

  async me(init: RequestInit = {}): Promise<Me> {
    const body = await this.request<MeResponse>("/api/v1/me", init);
    const user = body.user ?? null;
    return {
      person: user?.name || user?.email || null,
      email: user?.email ?? null,
      team: body.team?.name ?? body.team?.id ?? "",
      teamId: body.team?.id ?? "",
      version: body.server?.version ?? null,
      scopes: body.scopes ?? [],
    };
  }

  /** The person's own runs, newest first. */
  async executions(limit = 20): Promise<Execution[]> {
    const body = await this.request<{ executions: Execution[] }>(`/api/v1/executions?limit=${encodeURIComponent(String(limit))}`);
    return body.executions ?? [];
  }

  async execution(id: string): Promise<{ execution: Execution; steps: unknown[] }> {
    return this.request<{ execution: Execution; steps: unknown[] }>(`/api/v1/executions/${encodeURIComponent(id)}`);
  }

  /** The pool's windows, the numbers `/usage` used to show before the session joined the gate. */
  async usage(init: RequestInit = {}): Promise<GateUsage> {
    return this.request<GateUsage>("/api/v1/usage", init);
  }

  /** Asks a run to stop. `ok` when the server took the request; otherwise its reason. */
  async cancel(id: string): Promise<Result> {
    try {
      const body = await this.request<{ requested: boolean; stopped?: boolean; reason?: string }>(
        `/api/v1/executions/${encodeURIComponent(id)}/cancel`,
        { method: "POST", body: "{}" },
      );
      if (body.requested) return { ok: true, value: undefined };
      return { ok: false, error: body.reason ?? "the run did not take the stop request" };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  }

  /**
   * Follows /api/v1/executions/stream for as long as `signal` lives.
   *
   * The first frame is a snapshot of the person's running executions, then
   * one WorkflowEvent per frame. A dropped connection is reopened after a
   * pause that doubles from 1s to 30s and resets once frames flow again;
   * the server's `: hb` comments keep the socket warm and are skipped here.
   */
  stream(onFrame: (f: StreamFrame) => void, signal: AbortSignal, opts: StreamOptions = {}): void {
    this.follow<StreamFrame>("/api/v1/executions/stream", onFrame, signal, opts);
  }

  // ---------------------------------------------------------------- remote

  /**
   * Whether this key may run sessions on the gate, whether the gate can host
   * them, and the repositories it can host them in. A gate from before remote
   * sessions has no such route; its 404 is read as "cannot", not as a failure.
   */
  async remoteInfo(init: RequestInit = {}): Promise<RemoteInfo> {
    try {
      const body = await this.request<Partial<RemoteInfo>>("/api/v1/remote", init);
      return {
        allowed: body.allowed === true,
        available: body.available === true,
        reason: typeof body.reason === "string" ? body.reason : null,
        repos: Array.isArray(body.repos) ? body.repos : [],
      };
    } catch (e) {
      if (e instanceof GateApiError && e.status === 404 && e.code !== "NOT_A_GATE") return { ...REMOTE_UNSUPPORTED };
      throw e;
    }
  }

  async remoteSessions(): Promise<RemoteSession[]> {
    const body = await this.request<{ sessions: RemoteSession[] }>("/api/v1/remote/sessions");
    return body.sessions ?? [];
  }

  /** Starts `claude` on the server in a connected repository; `prompt` is typed in once the TUI is ready. */
  async remoteStart(opts: { repo: string; prompt?: string; cols?: number; rows?: number }): Promise<RemoteSession> {
    const body = await this.request<{ session: RemoteSession }>("/api/v1/remote/sessions", { method: "POST", body: JSON.stringify(opts) });
    return body.session;
  }

  /** Wakes an asleep server session with `claude --resume`. */
  async remoteResume(sessionId: string, size: { cols?: number; rows?: number } = {}): Promise<RemoteSession> {
    const body = await this.request<{ session: RemoteSession }>("/api/v1/remote/sessions", {
      method: "POST",
      body: JSON.stringify({ resume: sessionId, ...size }),
    });
    return body.session;
  }

  private terminalPath(handle: string, action?: string): string {
    return `/api/v1/remote/terminals/${encodeURIComponent(handle)}${action ? `/${action}` : ""}`;
  }

  async remoteInput(handle: string, data: string): Promise<void> {
    await this.request(this.terminalPath(handle, "input"), { method: "POST", body: JSON.stringify({ data }) });
  }

  async remoteResize(handle: string, cols: number, rows: number): Promise<void> {
    await this.request(this.terminalPath(handle, "resize"), { method: "POST", body: JSON.stringify({ cols, rows }) });
  }

  async remoteRedraw(handle: string): Promise<void> {
    await this.request(this.terminalPath(handle, "redraw"), { method: "POST", body: "{}" });
  }

  /** Ends the server's terminal. Its transcript stays, so the session can be resumed. */
  async remoteClose(handle: string): Promise<void> {
    await this.request(this.terminalPath(handle), { method: "DELETE" });
  }

  async remotePending(): Promise<RemotePending[]> {
    const body = await this.request<{ pending: RemotePending[] }>("/api/v1/remote/asks");
    return body.pending ?? [];
  }

  async remoteAnswer(id: string, answer: AskAnswer): Promise<Result> {
    return this.settleRemote(id, { answer });
  }

  async remoteDecide(id: string, decision: PermissionDecision): Promise<Result> {
    return this.settleRemote(id, { decision });
  }

  private async settleRemote(id: string, body: unknown): Promise<Result> {
    try {
      await this.request(`/api/v1/remote/asks/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(body) });
      return { ok: true, value: undefined };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  }

  /** The files a server-side run changed, read in its worktree there. */
  async remoteChanges(executionId: string): Promise<Result<ChangedFile[]>> {
    try {
      const body = await this.request<{ files: ChangedFile[] }>(`/api/v1/remote/executions/${encodeURIComponent(executionId)}/changes`);
      return { ok: true, value: body.files ?? [] };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  }

  async remoteFileDiff(executionId: string, file: ChangedFile): Promise<Result<string>> {
    try {
      const body = await this.request<{ diff: string }>(`/api/v1/remote/executions/${encodeURIComponent(executionId)}/diff`, {
        method: "POST",
        body: JSON.stringify({ file }),
      });
      return { ok: true, value: body.diff ?? "" };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  }

  /** Follows /api/v1/remote/stream: a hello, each live terminal's screen, then every change and every byte. */
  remoteStream(onFrame: (f: RemoteFrame) => void, signal: AbortSignal, opts: StreamOptions = {}): void {
    this.follow<RemoteFrame>("/api/v1/remote/stream", onFrame, signal, opts);
  }

  /**
   * One server-sent-events connection, kept open: `data:` lines gathered into
   * frames, comments skipped, reconnected with backoff when it drops. Both
   * the run stream and the remote stream are this.
   */
  private follow<T>(path: string, onFrame: (f: T) => void, signal: AbortSignal, opts: StreamOptions): void {
    const min = Math.max(1, opts.minBackoffMs ?? 1_000);
    const max = Math.max(min, opts.maxBackoffMs ?? 30_000);
    let backoff = min;
    const run = async () => {
      while (!signal.aborted) {
        let error: string | null = null;
        try {
          const res = await fetch(`${this.c.url}${path}`, {
            headers: this.headers({ accept: "text/event-stream" }),
            signal,
          });
          if (!res.ok || !res.body) {
            const text = await res.text().catch(() => "");
            let msg = text.slice(0, 200) || `HTTP ${res.status}`;
            try {
              const json = JSON.parse(text);
              if (json?.error) msg = String(json.error);
            } catch {
              // not JSON
            }
            throw new GateApiError(msg, res.status);
          }
          opts.onState?.({ connected: true });
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let data: string[] = [];
          const dispatch = () => {
            if (!data.length) return;
            const text = data.join("\n");
            data = [];
            let frame: T;
            try {
              frame = JSON.parse(text) as T;
            } catch {
              return;
            }
            backoff = min;
            onFrame(frame);
          };
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buffer.indexOf("\n")) >= 0) {
              let line = buffer.slice(0, nl);
              buffer = buffer.slice(nl + 1);
              if (line.endsWith("\r")) line = line.slice(0, -1);
              if (line === "") {
                dispatch();
              } else if (line.startsWith(":")) {
                // heartbeat / comment
              } else if (line.startsWith("data:")) {
                data.push(line.slice(5).replace(/^ /, ""));
              }
              // other SSE fields (event:, id:, retry:) are not used by gate
            }
          }
          dispatch();
          error = "the stream ended";
        } catch (e) {
          error = signal.aborted ? null : errorMessage(e);
        }
        if (signal.aborted) break;
        opts.onState?.({ connected: false, error: error ?? undefined });
        await sleep(backoff, signal);
        backoff = Math.min(max, backoff * 2);
      }
    };
    void run();
  }
}
