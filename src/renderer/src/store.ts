import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { setTerminalTheme } from "@/components/terminalPool";

import type {
  AskAnswer,
  ClaudeSession,
  Execution,
  GateUsage,
  Pending,
  PermissionDecision,
  Result,
  SetupStatus,
  StreamFrame,
  WorkflowEvent,
  WorkflowGraph,
  WorkflowSummary,
} from "@shared/types";

export type Section = "projects" | "sessions" | "questions" | "approvals" | "executions";

export const SECTIONS: Section[] = ["projects", "sessions", "questions", "approvals", "executions"];

/** A directory sessions run in: what the person thinks of as a project. */
export interface Project {
  path: string;
  name: string;
  sessions: number;
  live: number;
  /** Live sessions waiting on the person, plus questions and approvals pending from any session there. */
  attention: number;
  lastActiveAt: number;
  /** Added by hand rather than found through a session; can be removed. */
  pinned: boolean;
}

/** Which nav badge a pending item counts under. */
export function sectionOf(p: Pending): Section {
  return p.kind === "question" ? "questions" : "approvals";
}

export function setupNeeded(status: SetupStatus | null): boolean {
  if (!status) return false;
  return !status.claude.found || !status.plugin.installed || !status.gate.connected;
}

interface CockpitState {
  /** Initial fetches have landed. */
  ready: boolean;
  setup: SetupStatus | null;
  /** The person pressed Continue on the setup screen (or setup was never needed). */
  setupDismissed: boolean;

  sessions: ClaudeSession[];
  pending: Pending[];
  executions: Execution[];
  /** Events per execution; a key exists once `loadEvents` ran or a live frame arrived. */
  events: Record<string, WorkflowEvent[]>;
  graphs: Record<string, WorkflowGraph>;
  graphErrors: Record<string, string>;
  /** The team's workflows, for starting a run; loaded on first need. */
  workflows: WorkflowSummary[];
  workflowsError: string | null;
  /** The pool's windows, refreshed every minute while connected. */
  usage: GateUsage | null;
  usageError: string | null;
  usageAt: number;

  section: Section;
  selectedSessionId: string | null;
  /** The terminal on stage; follows the selected session's pty but survives a resume swapping it. */
  selectedPtyId: string | null;
  selectedExecutionId: string | null;
  /** Last cwd a session was started from, offered as the default for the next one. */
  lastCwd: string;
  /** The project the Sessions column is narrowed to; null shows every session. */
  selectedProject: string | null;
  /** Projects added by hand, kept across launches; a directory with no sessions yet. */
  pinnedProjects: string[];
  /** Dark or light; kept across launches, applied to the document and every terminal. */
  theme: Theme;
  /**
   * Projects taken off the list, with when. A project found through its
   * sessions cannot be deleted — the sessions are on disk — so it is hidden
   * instead, until a session newer than the hiding runs there again.
   */
  hiddenProjects: Record<string, number>;

  /** Timestamp of the last new pending item per section; the nav badge pulses briefly after it. */
  arrivals: Record<Section, number>;

  init: () => Promise<void>;
  refreshSetup: () => Promise<SetupStatus>;
  dismissSetup: () => void;
  installPlugin: () => Promise<Result>;
  updatePlugin: () => Promise<Result>;
  connectGate: (token: string) => Promise<Result<SetupStatus>>;

  setTheme: (theme: Theme) => void;
  selectProject: (path: string | null) => void;
  pinProject: (path: string) => void;
  /** Takes a project off the list: unpins it, and hides it until something new happens there. */
  removeProject: (path: string) => void;

  setSection: (section: Section) => void;
  selectSession: (session: ClaudeSession) => Promise<Result<{ ptyId: string }> | null>;
  startSession: (cwd: string, prompt?: string) => Promise<Result<{ ptyId: string }>>;
  closeSession: (ptyId: string) => Promise<void>;

  answerAsk: (id: string, answer: AskAnswer) => Promise<Result>;
  decidePermission: (id: string, decision: PermissionDecision) => Promise<Result>;

  refreshExecutions: () => Promise<void>;
  selectExecution: (id: string | null) => void;
  loadEvents: (executionId: string) => Promise<void>;
  loadGraph: (workflowId: string) => Promise<void>;
  loadWorkflows: () => Promise<void>;
  refreshUsage: () => Promise<void>;
  /** Starts a run: a new session in the project, with `/gate:run <workflow> <task>` as its first prompt. */
  startRun: (cwd: string, workflowId: string, task: string) => Promise<Result<{ ptyId: string }>>;
  cancelExecution: (id: string) => Promise<Result>;
}

export type Theme = "dark" | "light";

const LAST_CWD_KEY = "cockpit.lastCwd";
const THEME_KEY = "cockpit.theme";

/** The document's class and the terminals' palette follow the store; nothing else reads the theme. */
function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("light", theme === "light");
  setTerminalTheme(theme);
}
const PROJECT_KEY = "cockpit.selectedProject";
const PINNED_KEY = "cockpit.pinnedProjects";
const HIDDEN_KEY = "cockpit.hiddenProjects";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or unavailable: the choice lasts the session
  }
}

function readLastCwd(): string {
  try {
    return window.localStorage.getItem(LAST_CWD_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeLastCwd(cwd: string): void {
  try {
    window.localStorage.setItem(LAST_CWD_KEY, cwd);
  } catch {
    /* storage may be unavailable; the default is a convenience */
  }
}

/** Live first, then asleep; newest activity first inside each. */
export function sortSessions(sessions: ClaudeSession[]): ClaudeSession[] {
  return [...sessions].sort((a, b) => {
    if (a.presence !== b.presence) return a.presence === "live" ? -1 : 1;
    return b.lastActiveAt - a.lastActiveAt;
  });
}

export function sortExecutions(executions: Execution[]): Execution[] {
  return [...executions].sort((a, b) => {
    if ((a.status === "running") !== (b.status === "running")) return a.status === "running" ? -1 : 1;
    return b.startedAt - a.startedAt;
  });
}

function applyFrame(executions: Execution[], frame: WorkflowEvent): Execution[] {
  return executions.map((e) => {
    if (e.id !== frame.executionId) return e;
    switch (frame.type) {
      case "run.paused":
        return { ...e, pausedAt: frame.at };
      case "run.resumed":
        return { ...e, pausedAt: null, pausedMs: e.pausedMs + (e.pausedAt ? frame.at - e.pausedAt : 0) };
      case "workflow.completed":
        return { ...e, status: frame.status, finishedAt: frame.at, pausedAt: null };
      case "workflow.failed":
        return { ...e, status: "failed", finishedAt: frame.at, pausedAt: null, error: { code: frame.code, message: frame.message } };
      default:
        return e;
    }
  });
}

let subscribed = false;

export const useStore = create<CockpitState>((set, get) => ({
  ready: false,
  setup: null,
  setupDismissed: false,
  sessions: [],
  pending: [],
  executions: [],
  events: {},
  graphs: {},
  graphErrors: {},
  workflows: [],
  workflowsError: null,
  usage: null,
  usageError: null,
  usageAt: 0,
  section: "sessions",
  selectedSessionId: null,
  selectedPtyId: null,
  selectedExecutionId: null,
  lastCwd: readLastCwd(),
  selectedProject: readJson<string | null>(PROJECT_KEY, null),
  pinnedProjects: readJson<string[]>(PINNED_KEY, []),
  theme: readJson<Theme>(THEME_KEY, "dark"),
  hiddenProjects: readJson<Record<string, number>>(HIDDEN_KEY, {}),
  arrivals: { projects: 0, sessions: 0, questions: 0, approvals: 0, executions: 0 },

  init: async () => {
    applyTheme(get().theme);
    if (!subscribed) {
      subscribed = true;
      window.cockpit.sessions.onChange((sessions) => {
        const sorted = sortSessions(sessions);
        const { selectedSessionId, selectedPtyId } = get();
        const selected = sorted.find((s) => s.id === selectedSessionId) ?? sorted.find((s) => s.ptyId && s.ptyId === selectedPtyId);
        set({
          sessions: sorted,
          selectedSessionId: selected?.id ?? selectedSessionId,
          selectedPtyId: selected?.ptyId ?? selectedPtyId,
        });
      });
      window.cockpit.asks.onChange((pending) => {
        const known = new Set(get().pending.map((p) => p.id));
        const arrivals = { ...get().arrivals };
        const now = Date.now();
        for (const p of pending) if (!known.has(p.id)) arrivals[sectionOf(p)] = now;
        set({ pending: [...pending].sort((a, b) => b.askedAt - a.askedAt), arrivals });
      });
      window.cockpit.executions.onEvent((frame: StreamFrame) => {
        if (frame.type === "snapshot") {
          // The stream's snapshot carries only running runs and a poll carries
          // recent ones: either way it is merged, so a finished run stays on
          // the list until a fresh list says otherwise.
          const byId = new Map(get().executions.map((e) => [e.id, e]));
          for (const e of frame.executions) byId.set(e.id, e);
          set({ executions: sortExecutions([...byId.values()]) });
          return;
        }
        const { executions, events } = get();
        const list = events[frame.executionId] ?? [];
        set({
          executions: applyFrame(executions, frame),
          events: { ...events, [frame.executionId]: [...list, frame] },
        });
        if (frame.type === "workflow.started" && !executions.some((e) => e.id === frame.executionId)) {
          void get().refreshExecutions();
        }
      });
    }

    const [setup, sessions, pending, executions] = await Promise.all([
      window.cockpit.setup.status(),
      window.cockpit.sessions.list(),
      window.cockpit.asks.list(),
      window.cockpit.executions.list(),
    ]);
    const sorted = sortSessions(sessions);
    const first = sorted.find((s) => s.presence === "live") ?? null;
    set({
      ready: true,
      setup,
      setupDismissed: !setupNeeded(setup),
      sessions: sorted,
      pending: [...pending].sort((a, b) => b.askedAt - a.askedAt),
      executions: sortExecutions(executions),
      selectedSessionId: get().selectedSessionId ?? first?.id ?? null,
      selectedPtyId: get().selectedPtyId ?? first?.ptyId ?? null,
      lastCwd: get().lastCwd || sorted[0]?.cwd || "",
    });
    if (setup.gate.connected) {
      void get().refreshUsage();
      // A window reading arrives with every gateway reply, so a minute is plenty; nothing here polls Anthropic.
      setInterval(() => void get().refreshUsage(), 60_000);
    }
  },

  refreshSetup: async () => {
    const setup = await window.cockpit.setup.status();
    set({ setup });
    return setup;
  },

  dismissSetup: () => set({ setupDismissed: true }),

  installPlugin: async () => {
    const result = await window.cockpit.setup.installPlugin();
    await get().refreshSetup();
    return result;
  },

  updatePlugin: async () => {
    const result = await window.cockpit.setup.updatePlugin();
    await get().refreshSetup();
    return result;
  },

  setTheme: (theme) => {
    writeJson(THEME_KEY, theme);
    applyTheme(theme);
    set({ theme });
  },

  selectProject: (path) => {
    writeJson(PROJECT_KEY, path);
    // Narrowing to a project drops a selection that is not in it, so the
    // stage does not show a terminal the list no longer has.
    const { sessions, selectedSessionId, selectedPtyId } = get();
    const keep = path === null || sessions.some((s) => s.cwd === path && (s.id === selectedSessionId || (s.ptyId !== null && s.ptyId === selectedPtyId)));
    set({
      selectedProject: path,
      section: "sessions",
      ...(keep ? {} : { selectedSessionId: null, selectedPtyId: null }),
      ...(path ? { lastCwd: path } : {}),
    });
  },

  pinProject: (path) => {
    const pinned = [...new Set([...get().pinnedProjects, path])];
    const { [path]: _shown, ...hidden } = get().hiddenProjects;
    writeJson(PINNED_KEY, pinned);
    writeJson(HIDDEN_KEY, hidden);
    set({ pinnedProjects: pinned, hiddenProjects: hidden });
  },

  removeProject: (path) => {
    const pinned = get().pinnedProjects.filter((p) => p !== path);
    const hidden = { ...get().hiddenProjects, [path]: Date.now() };
    writeJson(PINNED_KEY, pinned);
    writeJson(HIDDEN_KEY, hidden);
    const deselect = get().selectedProject === path;
    if (deselect) writeJson(PROJECT_KEY, null);
    set({ pinnedProjects: pinned, hiddenProjects: hidden, ...(deselect ? { selectedProject: null } : {}) });
  },

  connectGate: async (token) => {
    const result = await window.cockpit.setup.connect(token);
    if (result.ok) set({ setup: result.value });
    else await get().refreshSetup();
    return result;
  },

  setSection: (section) => set({ section }),

  selectSession: async (session) => {
    set({ section: "sessions", selectedSessionId: session.id, selectedPtyId: session.ptyId });
    if (session.presence === "live" && session.ptyId) return null;
    const result = await window.cockpit.sessions.open(session.id);
    if (result.ok) set({ selectedSessionId: session.id, selectedPtyId: result.value.ptyId });
    return result;
  },

  startSession: async (cwd, prompt) => {
    const result = await window.cockpit.sessions.start(cwd, prompt);
    if (result.ok) {
      writeLastCwd(cwd);
      set({ section: "sessions", lastCwd: cwd, selectedPtyId: result.value.ptyId, selectedSessionId: null });
    }
    return result;
  },

  closeSession: async (ptyId) => {
    await window.cockpit.sessions.close(ptyId);
    if (get().selectedPtyId === ptyId) set({ selectedPtyId: null });
  },

  answerAsk: async (id, answer) => {
    const result = await window.cockpit.asks.answer(id, answer);
    if (result.ok) set({ pending: get().pending.filter((p) => p.id !== id) });
    return result;
  },

  decidePermission: async (id, decision) => {
    const result = await window.cockpit.asks.decide(id, decision);
    if (result.ok) set({ pending: get().pending.filter((p) => p.id !== id) });
    return result;
  },

  refreshUsage: async () => {
    const result = await window.cockpit.gate.usage();
    if (result.ok) set({ usage: result.value, usageError: null, usageAt: Date.now() });
    else set({ usageError: result.error, usageAt: Date.now() });
  },

  refreshExecutions: async () => {
    const executions = await window.cockpit.executions.list();
    set({ executions: sortExecutions(executions) });
  },

  selectExecution: (id) => {
    set({ selectedExecutionId: id });
    if (!id) return;
    void get().loadEvents(id);
    const execution = get().executions.find((e) => e.id === id);
    if (execution && !get().graphs[execution.workflowId]) void get().loadGraph(execution.workflowId);
  },

  loadEvents: async (executionId) => {
    const fetched = await window.cockpit.executions.events(executionId);
    const lastAt = fetched.length ? fetched[fetched.length - 1].at : 0;
    // Frames that arrived while the fetch was in flight are newer than anything fetched; keep them.
    const live = (get().events[executionId] ?? []).filter((e) => e.at > lastAt);
    set({ events: { ...get().events, [executionId]: [...fetched, ...live] } });
  },

  loadGraph: async (workflowId) => {
    const result = await window.cockpit.executions.graph(workflowId);
    if (result.ok) {
      const { [workflowId]: _dropped, ...rest } = get().graphErrors;
      set({ graphs: { ...get().graphs, [workflowId]: result.value }, graphErrors: rest });
    } else {
      set({ graphErrors: { ...get().graphErrors, [workflowId]: result.error } });
    }
  },

  loadWorkflows: async () => {
    try {
      const result = await window.cockpit.executions.workflows();
      if (result.ok) set({ workflows: result.value, workflowsError: result.value.length ? null : "the team's mirror lists no workflows — run /gate:login or any gate command to pull it" });
      else set({ workflowsError: result.error });
    } catch (e) {
      // A main process older than this renderer (dev without a restart) has no handler for the call.
      set({ workflowsError: `${(e as Error).message} — restart the app if it was updated while running` });
    }
  },

  startRun: async (cwd, workflowId, task) => {
    // One line: a newline would submit the prompt early in the terminal.
    const brief = task.replace(/\s*\n\s*/g, " ").trim();
    const prompt = brief ? `/gate:run ${workflowId} ${brief}` : `/gate:run ${workflowId}`;
    return get().startSession(cwd, prompt);
  },

  cancelExecution: async (id) => {
    const result = await window.cockpit.executions.cancel(id);
    if (result.ok) await get().refreshExecutions();
    return result;
  },
}));

// ------------------------------------------------------------------ selectors

export function useBadgeCounts(): Record<Section, number> {
  return useStore(
    useShallow((s) => {
    let questions = 0;
    let approvals = 0;
    for (const p of s.pending) {
      if (p.kind === "question") questions += 1;
      else approvals += 1;
    }
    const sessions = s.sessions.filter((x) => x.presence === "live" && (x.status === "waiting" || x.status === "blocked")).length;
    const executions = s.executions.filter((x) => x.status === "running" && x.pausedAt !== null).length;
    return { projects: 0, sessions, questions, approvals, executions };
    }),
  );
}

/** The projects on this machine: every directory a session ran in, plus the ones added by hand. */
export function useProjects(): Project[] {
  return useStore(
    useShallow((s) => {
      const byPath = new Map<string, Project>();
      const name = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;
      for (const path of s.pinnedProjects) {
        byPath.set(path, { path, name: name(path), sessions: 0, live: 0, attention: 0, lastActiveAt: 0, pinned: true });
      }
      const waitingSessions = new Set(s.pending.map((p) => p.sessionId));
      for (const x of s.sessions) {
        if (!x.cwd) continue;
        const p = byPath.get(x.cwd) ?? { path: x.cwd, name: name(x.cwd), sessions: 0, live: 0, attention: 0, lastActiveAt: 0, pinned: false };
        p.sessions += 1;
        if (x.presence === "live") p.live += 1;
        if ((x.presence === "live" && (x.status === "waiting" || x.status === "blocked")) || waitingSessions.has(x.id)) p.attention += 1;
        p.lastActiveAt = Math.max(p.lastActiveAt, x.lastActiveAt);
        byPath.set(x.cwd, p);
      }
      // A hidden project comes back when a session newer than the hiding runs there, or when it is live now.
      const visible = [...byPath.values()].filter((p) => {
        const hiddenAt = s.hiddenProjects[p.path];
        return hiddenAt === undefined || p.live > 0 || p.lastActiveAt > hiddenAt;
      });
      return visible.sort((a, b) => b.attention - a.attention || b.live - a.live || b.lastActiveAt - a.lastActiveAt);
    }),
  );
}

export function useExecutionById(id: string | null): Execution | null {
  return useStore((s) => (id ? (s.executions.find((e) => e.id === id) ?? null) : null));
}
