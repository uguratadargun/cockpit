/**
 * HookServer: the cockpit's end of the Claude Code hook socket.
 *
 * Every terminal this window starts runs `claude --settings <per-terminal
 * file>` (see hookShim.ts), whose hooks all forward to one unix socket. Each
 * connection carries one NDJSON line `{v:1, id, payload}` and expects one JSON
 * line back. Most events are answered `{}` at once and only reported as a
 * session event. Two are held open until a person acts here:
 *
 *   - PreToolUse for AskUserQuestion — the reply carries the answers, the TUI
 *     shows no prompt and the session goes on;
 *   - PermissionRequest — the reply allows (optionally persisting a rule) or
 *     denies with a message Claude reads.
 *
 * A shim that hangs up before its reply (cockpit closed, session killed) drops
 * its pending item; a malformed line is dropped without a reply. Nothing here
 * imports electron, so the tests drive it over a real socket.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AskAnswer, Pending, PendingAsk, PendingPermission, PermissionDecision, Question, Result, RunPointer } from "../shared/types";
import { readTranscriptSummary } from "./transcript";

// ------------------------------------------------------------------ wire

/** What Claude Code hands a hook on stdin: the fields the cockpit reads. */
export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  notification_type?: string;
  message?: string;
  prompt?: string;
  source?: string;
  reason?: string;
  last_assistant_message?: string;
  permission_suggestions?: unknown;
  /** Added by the shim from `COCKPIT_PTY`. */
  pty_id?: string | null;
  /** Added by the shim when run with `--status`: never held, only reported. */
  hook_role?: string;
}

export interface SessionHookEvent {
  sessionId: string;
  ptyId: string | null;
  cwd: string;
  transcriptPath: string | null;
  at: number;
  kind: "start" | "prompt" | "working" | "idle" | "waiting" | "blocked" | "end";
  detail?: string;
}

/** The kind of session event a hook payload means, or null when it means none. */
export function sessionEventKind(p: HookPayload): SessionHookEvent["kind"] | null {
  switch (p.hook_event_name) {
    case "SessionStart":
      return "start";
    case "UserPromptSubmit":
      return "prompt";
    case "PreToolUse":
    case "PostToolUse":
      return "working";
    case "Stop":
      return "idle";
    case "SessionEnd":
      return "end";
    case "Notification": {
      const t = p.notification_type ?? "";
      if (t === "permission_prompt") return "blocked";
      if (t === "idle_prompt" || t === "idle" || t === "agent_needs_input") return "waiting";
      if (!t && /waiting for your input/i.test(p.message ?? "")) return "waiting";
      return null;
    }
    default:
      return null;
  }
}

/** The first non-blank line of a text, cut to `max` characters; undefined when there is none. */
function firstLine(s: string | undefined, max = 200): string | undefined {
  const line = (s ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The session event for a payload, or null for events the cockpit does not track. */
export function sessionEventFor(p: HookPayload, at = Date.now()): SessionHookEvent | null {
  const kind = sessionEventKind(p);
  if (!kind || !p.session_id) return null;
  let detail: string | undefined;
  switch (p.hook_event_name) {
    case "PreToolUse":
    case "PostToolUse":
      detail = p.tool_name;
      break;
    case "Notification":
      detail = firstLine(p.message);
      break;
    case "UserPromptSubmit":
      detail = firstLine(p.prompt);
      break;
    case "Stop":
      detail = firstLine(p.last_assistant_message);
      break;
    case "SessionStart":
      detail = p.source;
      break;
    case "SessionEnd":
      detail = p.reason;
      break;
  }
  return {
    sessionId: p.session_id,
    ptyId: p.pty_id ?? null,
    cwd: p.cwd ?? "",
    transcriptPath: p.transcript_path ?? null,
    at,
    kind,
    ...(detail ? { detail } : {}),
  };
}

// ------------------------------------------------------------- classify

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `~/.gate`, or `GATE_HOME` when set. */
export function gateHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.GATE_HOME && env.GATE_HOME.trim() ? env.GATE_HOME : join(homedir(), ".gate");
}

/** The run pointer gate wrote for a session, or null when there is none (or it is unreadable). */
export function readRunPointer(sessionId: string, home = gateHome()): RunPointer | null {
  if (!/^[\w.-]+$/.test(sessionId)) return null;
  try {
    const o: unknown = JSON.parse(readFileSync(join(home, "sessions", `${sessionId}.json`), "utf8"));
    if (!isRecord(o) || typeof o.executionId !== "string") return null;
    return {
      executionId: o.executionId,
      state: (o.state as RunPointer["state"]) ?? "agent",
      nodeId: typeof o.nodeId === "string" ? o.nodeId : null,
      agent: typeof o.agent === "string" ? o.agent : null,
      asks: o.asks === "question" || o.asks === "approval" ? o.asks : null,
      at: typeof o.at === "number" ? o.at : 0,
    };
  } catch {
    return null;
  }
}

/** The questions of an AskUserQuestion input, shaped; anything odd becomes an empty list. */
export function questionsOf(input: unknown): Question[] {
  if (!isRecord(input) || !Array.isArray(input.questions)) return [];
  return input.questions.filter(isRecord).map((q) => ({
    question: typeof q.question === "string" ? q.question : "",
    header: typeof q.header === "string" ? q.header : "",
    multiSelect: q.multiSelect === true,
    options: Array.isArray(q.options)
      ? q.options.filter(isRecord).map((o) => ({
          label: typeof o.label === "string" ? o.label : "",
          description: typeof o.description === "string" ? o.description : "",
        }))
      : [],
  }));
}

/** One line for the permissions list: the command, the file, the plan's title, else the tool. */
export function permissionSummary(toolName: string, input: Record<string, unknown>): string {
  const str = (k: string): string | undefined => (typeof input[k] === "string" ? (input[k] as string) : undefined);
  switch (toolName) {
    case "Bash":
      return firstLine(str("command")) ?? toolName;
    case "Edit":
    case "Write":
    case "MultiEdit":
      return str("file_path") ?? toolName;
    case "NotebookEdit":
      return str("notebook_path") ?? str("file_path") ?? toolName;
    case "ExitPlanMode": {
      const line = firstLine(str("plan")?.replace(/^\s*#+\s*/gm, ""), 120);
      return line ? `Approve the plan: ${line}` : "Approve the plan";
    }
    default:
      return toolName;
  }
}

/** The reply that answers a held AskUserQuestion; `toolInput` is echoed as received. */
export function askReply(toolInput: unknown, answer: AskAnswer): unknown {
  const questions = isRecord(toolInput) ? toolInput.questions : undefined;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: {
        questions,
        answers: answer.answers ?? {},
        ...(answer.response ? { response: answer.response } : {}),
      },
    },
  };
}

/** The reply that settles a held PermissionRequest. */
export function permissionReply(p: PendingPermission, decision: PermissionDecision): unknown {
  const d =
    decision.behavior === "allow"
      ? {
          behavior: "allow",
          updatedInput: p.toolInput,
          ...(decision.always && p.suggestions.length ? { updatedPermissions: p.suggestions } : {}),
        }
      : { behavior: "deny", message: decision.message };
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: d } };
}

// --------------------------------------------------------------- server

interface Held {
  pending: Pending;
  conn: Socket;
  /** The ask's `tool_input` verbatim, so the reply echoes exactly what was received. */
  toolInput: unknown;
}

type ChangeListener = (pending: Pending[]) => void;
type EventListener = (e: SessionHookEvent) => void;

const isPipe = (p: string): boolean => p.startsWith("\\\\.\\pipe\\");

/** A line longer than this without a newline is not a hook frame. */
const MAX_FRAME = 4 * 1024 * 1024;

export class HookServer {
  private server: Server | null = null;
  private sockPath: string | null = null;
  private held = new Map<string, Held>();
  private changeListeners = new Set<ChangeListener>();
  private eventListeners = new Set<EventListener>();

  /** `home` is where the run pointers live (`~/.gate` or `GATE_HOME`); a parameter so tests can point it at a temp dir. */
  constructor(private readonly home: string = gateHome()) {}

  async start(sockPath: string): Promise<void> {
    if (this.server) await this.stop();
    if (!isPipe(sockPath)) {
      try {
        if (existsSync(sockPath)) rmSync(sockPath);
      } catch {
        /* a stale socket we cannot remove: listen will say so */
      }
    }
    const server = createServer((conn) => this.accept(conn));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", (e) => console.error("[cockpit] hook server error:", e));
    if (!isPipe(sockPath)) {
      try {
        chmodSync(sockPath, 0o600);
      } catch {
        /* best effort */
      }
    }
    this.server = server;
    this.sockPath = sockPath;
  }

  /** Closes the socket. Held shims get a hang-up, so their sessions fall back to the TUI's own prompts. */
  async stop(): Promise<void> {
    const server = this.server;
    const path = this.sockPath;
    this.server = null;
    this.sockPath = null;
    const had = this.held.size > 0;
    for (const h of this.held.values()) h.conn.destroy();
    this.held.clear();
    if (had) this.emitChange();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (path && !isPipe(path)) {
      try {
        if (existsSync(path)) rmSync(path);
      } catch {
        /* noop */
      }
    }
  }

  get listening(): boolean {
    return this.server !== null;
  }

  pending(): Pending[] {
    return [...this.held.values()].map((h) => h.pending);
  }

  answer(id: string, answer: AskAnswer): Result {
    const h = this.held.get(id);
    if (!h) return { ok: false, error: `no pending ask ${id}` };
    if (h.pending.kind === "permission") return { ok: false, error: `${id} is a permission, not a question` };
    this.settle(id, askReply(h.toolInput, answer));
    return { ok: true, value: undefined };
  }

  decide(id: string, decision: PermissionDecision): Result {
    const h = this.held.get(id);
    if (!h) return { ok: false, error: `no pending permission ${id}` };
    if (h.pending.kind !== "permission") return { ok: false, error: `${id} is a question, not a permission` };
    this.settle(id, permissionReply(h.pending, decision));
    return { ok: true, value: undefined };
  }

  onChange(cb: ChangeListener): () => void {
    this.changeListeners.add(cb);
    return () => {
      this.changeListeners.delete(cb);
    };
  }

  onSessionEvent(cb: EventListener): () => void {
    this.eventListeners.add(cb);
    return () => {
      this.eventListeners.delete(cb);
    };
  }

  // -- internals

  private accept(conn: Socket): void {
    let buf = "";
    let taken = false;
    conn.setEncoding("utf8");
    conn.on("error", () => {
      /* the shim hung up */
    });
    conn.on("data", (d: string) => {
      if (taken) return;
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl === -1) {
        if (buf.length > MAX_FRAME) conn.destroy();
        return;
      }
      taken = true;
      let payload: HookPayload | null = null;
      try {
        const frame: unknown = JSON.parse(buf.slice(0, nl));
        if (isRecord(frame) && isRecord(frame.payload)) payload = frame.payload as HookPayload;
      } catch {
        payload = null;
      }
      if (!payload) {
        conn.end();
        return;
      }
      try {
        this.handle(payload, conn);
      } catch (e) {
        console.error("[cockpit] hook handling failed:", e);
        this.reply(conn, {});
      }
    });
  }

  private reply(conn: Socket, res: unknown): void {
    try {
      conn.end(JSON.stringify(res ?? {}) + "\n");
    } catch {
      conn.destroy();
    }
  }

  private handle(p: HookPayload, conn: Socket): void {
    const ev = sessionEventFor(p);
    if (ev) for (const cb of this.eventListeners) cb(ev);

    const holdsAsk = p.hook_event_name === "PreToolUse" && p.tool_name === "AskUserQuestion" && p.hook_role !== "status";
    const holdsPermission = p.hook_event_name === "PermissionRequest";
    if ((!holdsAsk && !holdsPermission) || !p.session_id) {
      this.reply(conn, {});
      return;
    }

    const id = randomBytes(8).toString("hex");
    const run = readRunPointer(p.session_id, this.home);
    const base = {
      id,
      sessionId: p.session_id,
      ptyId: p.pty_id ?? null,
      executionId: run?.executionId ?? null,
      nodeId: run?.nodeId ?? null,
      cwd: p.cwd ?? "",
      askedAt: Date.now(),
    };
    let pending: Pending;
    if (holdsAsk) {
      const ask: PendingAsk = {
        ...base,
        kind: run?.asks === "approval" ? "approval" : "question",
        questions: questionsOf(p.tool_input),
        context: p.transcript_path ? readTranscriptSummary(p.transcript_path).lastAssistantText : null,
      };
      pending = ask;
    } else {
      const toolInput = isRecord(p.tool_input) ? p.tool_input : {};
      const toolName = p.tool_name ?? "";
      const perm: PendingPermission = {
        ...base,
        kind: "permission",
        toolName,
        toolInput,
        summary: permissionSummary(toolName, toolInput),
        suggestions: Array.isArray(p.permission_suggestions) ? p.permission_suggestions.filter(isRecord) : [],
      };
      pending = perm;
    }

    this.held.set(id, { pending, conn, toolInput: p.tool_input });
    const drop = () => {
      if (this.held.get(id)?.conn === conn) {
        this.held.delete(id);
        this.emitChange();
      }
    };
    conn.on("close", drop);
    this.emitChange();
  }

  private settle(id: string, res: unknown): void {
    const h = this.held.get(id);
    if (!h) return;
    this.held.delete(id);
    this.reply(h.conn, res);
    this.emitChange();
  }

  private emitChange(): void {
    const list = this.pending();
    for (const cb of this.changeListeners) cb(list);
  }
}
