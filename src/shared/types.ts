/**
 * The words main, preload and renderer share. Nothing here imports anything.
 *
 * A cockpit is one window over several Claude Code sessions, each of which
 * may be driving a gate run. Four things are on screen: the sessions (and
 * their terminals), the questions those sessions have asked, the approvals
 * they are waiting for, and the runs they are walking. These are those four.
 */

// ---------------------------------------------------------------- sessions

/** `live` has a terminal in this window; `asleep` is a transcript on disk that `--resume` can wake. */
export type SessionPresence = "live" | "asleep";

/**
 * Where a session runs: `local` is a `claude` in a pty on this machine;
 * `remote` is a `claude` in a pty on the gate server, started by gate in one
 * of its connected repositories, whose bytes and questions come here over the
 * client API. The window treats both alike; only the plumbing differs.
 */
export type SessionLocation = "local" | "remote";

/**
 * What the session is doing, as its hooks report it. `waiting` is a question
 * out (ours or the TUI's own idle prompt), `blocked` a permission prompt.
 */
export type SessionStatus = "working" | "idle" | "waiting" | "blocked" | "exited";

/** What `~/.gate/sessions/<session>.json` says: the run this session was last told about. */
export interface RunPointer {
  executionId: string;
  state: "agent" | "wait" | "delegate" | "done" | "failed" | "stopped";
  nodeId: string | null;
  agent: string | null;
  asks: "question" | "approval" | null;
  at: number;
}

export interface ClaudeSession {
  /** Claude Code's own session id: the transcript's file name. */
  id: string;
  /** Set while this window owns a terminal for it. */
  ptyId: string | null;
  cwd: string;
  /** The first prompt, or the name it was given; null for a session that never got one. */
  title: string | null;
  startedAt: number;
  lastActiveAt: number;
  presence: SessionPresence;
  status: SessionStatus;
  run: RunPointer | null;
  location: SessionLocation;
  /** The gate-connected repository a remote session sits in; null for a local one. */
  repo: string | null;
}

// ------------------------------------------------------------------ remote

/** A repository connected to the gate: where a remote session can run. */
export interface RemoteRepo {
  id: string;
  name: string;
  /** What it was connected from: a git URL, or a path on the server. */
  source: string;
  status: "new" | "installing" | "ready" | "failed";
}

/** What the gate says about running sessions on it, for this person's key. */
export interface RemoteInfo {
  /** The key carries the `remote` scope. */
  allowed: boolean;
  /** The server can host terminals at all (node-pty and claude are there). */
  available: boolean;
  /** Why not, when it cannot. */
  reason: string | null;
  repos: RemoteRepo[];
}

/** Where a new session or run should go. */
export type RunTarget = { location: "local" } | { location: "remote"; repo: string };

// ------------------------------------------------------- questions/approvals

export interface QuestionOption {
  label: string;
  description: string;
}

/** One question of an AskUserQuestion call, as Claude Code hands it to a hook. */
export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/**
 * An AskUserQuestion held open by the hook until this window answers it.
 * `kind` is the run's word for the node (`approval` for plan-review and
 * acceptance, `question` otherwise), so the two panels split without reading
 * the question's text.
 */
export interface PendingAsk {
  id: string;
  kind: "question" | "approval";
  location: SessionLocation;
  sessionId: string;
  ptyId: string | null;
  executionId: string | null;
  nodeId: string | null;
  cwd: string;
  questions: Question[];
  /** What the session said just before asking — the plan summary, the branch — from its transcript. */
  context: string | null;
  askedAt: number;
}

/** What goes back: the selected label (or the person's own words) per question text; `response` replaces them all. */
export interface AskAnswer {
  answers: Record<string, string | string[]>;
  response?: string;
}

/** A permission prompt held open by the PermissionRequest hook. */
export interface PendingPermission {
  id: string;
  kind: "permission";
  location: SessionLocation;
  sessionId: string;
  ptyId: string | null;
  executionId: string | null;
  nodeId: string | null;
  cwd: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** One line for the list: the command, the file, the plan's title. */
  summary: string;
  /** Permission rules Claude Code proposes so this is not asked again; echoed back on "always". */
  suggestions: unknown[];
  askedAt: number;
}

export type PermissionDecision = { behavior: "allow"; always?: boolean } | { behavior: "deny"; message: string };

export type Pending = PendingAsk | PendingPermission;

// -------------------------------------------------------------- executions

/** One file a run's session touched, read from `git status`/`git diff` in its cwd — not gate's own data. */
export interface ChangedFile {
  path: string;
  /** Set only for a rename/copy, its path before. */
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
  /** Never in the index at all (git status `??`), vs. added-and-staged. Picks which diff command can see it. */
  untracked: boolean;
}

/** A run as gate's client API returns it; only the fields the cockpit reads are named. */
export interface Execution {
  id: string;
  workflowId: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  finishedAt: number | null;
  pausedAt: number | null;
  pausedMs: number;
  input: Record<string, unknown>;
  error: { code: string; message: string } | null;
  userId: string | null;
  driver: "engine" | "session";
  client: { host: string | null; repo: string | null; branch: string | null; session: string | null } | null;
  stepCount: number;
  [key: string]: unknown;
}

export interface NodeUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

interface EventBase {
  executionId: string;
  at: number;
}

/** gate's own event union (src/events/types.ts there), plus the stream's opening snapshot. */
export type WorkflowEvent =
  | (EventBase & { type: "workflow.started"; workflowId: string; entry: string })
  | (EventBase & { type: "node.started"; nodeId: string; stepIndex: number; visit: number })
  | (EventBase & { type: "node.output"; nodeId: string; stepIndex: number; output: unknown })
  | (EventBase & { type: "node.completed"; nodeId: string; stepIndex: number; durationMs: number; usage?: NodeUsage })
  | (EventBase & { type: "node.failed"; nodeId: string; stepIndex: number; code: string; message: string })
  | (EventBase & { type: "tool.called"; nodeId: string; stepIndex: number; tool: string; ok: boolean; summary: string; durationMs: number })
  | (EventBase & { type: "edge.selected"; from: string; to: string; label?: string })
  | (EventBase & { type: "run.paused"; nodeId: string })
  | (EventBase & { type: "run.resumed"; nodeId: string })
  | (EventBase & { type: "workflow.completed"; status: "completed" | "failed"; terminalNodeId: string })
  | (EventBase & { type: "workflow.failed"; code: string; message: string; nodeId?: string });

export type StreamFrame = WorkflowEvent | { type: "snapshot"; at: number; executions: Execution[] };

/** A workflow as the team's mirror holds it, parsed enough to draw. */
export interface WorkflowGraph {
  id: string;
  name: string;
  entry: string;
  nodes: Array<{ id: string; type: string; agent?: string; label?: string; status?: string }>;
  edges: Array<{ from: string; to: string; label?: string }>;
}

/** A workflow as the team's mirror lists it, enough to offer it for a run. */
export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  /** The run inputs it needs; `task` is the one a person types. */
  inputs: string[];
}

/** What the gate's account pool has left, as `gate usage` reports it: the pool's windows, shared by everyone on the gate. */
export interface GateUsage {
  windows: Array<{
    /** As Anthropic names it: "five_hour", "seven_day", "seven_day_opus"… */
    name: string;
    /** Percent of the window still free, in the account best placed to serve. */
    remaining: number;
    resetsAt: string | null;
    label?: string;
  }>;
  accounts: { total: number; enabled: number; available: number; coolingDown: number; quotaBlocked: number };
  plan: string | null;
  updatedAt: number | null;
  floorPercent: number;
  /** Why there is no window to show, when there is none. */
  reason: string | null;
}

// -------------------------------------------------------------------- setup

export interface SetupStatus {
  claude: { found: boolean; version: string | null; path: string | null };
  /** `latest` is what the gate serves (its plugin and server share a version); `updateAvailable` when it is newer than what is installed. */
  plugin: { installed: boolean; version: string | null; latest: string | null; updateAvailable: boolean };
  /** `version` is what the gate reports; `live` when it serves the run stream (0.34.0 and later). */
  gate: { connected: boolean; url: string | null; person: string | null; team: string | null; version: string | null; live: boolean };
}

export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string };

// ------------------------------------------------------------------- update

/**
 * "auto": electron-updater can download and install silently — Windows, and
 * Linux's AppImage. `downloaded` means it is staged; installing runs
 * quitAndInstall. "manual": mac's ad-hoc signing can't pass Squirrel.Mac's
 * update signature check, so this only compares against the GitHub release
 * feed and installing just opens the release page.
 */
export interface UpdateStatus {
  available: boolean;
  version: string | null;
  downloaded: boolean;
  error: string | null;
  mode: "auto" | "manual";
}

// ---------------------------------------------------------------- terminal

export interface PtyInfo {
  ptyId: string;
  sessionId: string | null;
  cwd: string;
  pid: number;
  alive: boolean;
  hasOutput: boolean;
  lastOutputAt: number;
}
