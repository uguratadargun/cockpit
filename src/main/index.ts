import { app, BrowserWindow, ipcMain, Menu, Notification, shell } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { invoke, push } from "../shared/ipc";
import type {
  AskAnswer,
  ClaudeSession,
  Execution,
  Pending,
  PermissionDecision,
  Result,
  SessionStatus,
  StreamFrame,
  WorkflowEvent,
} from "../shared/types";
import { cockpitSockPath } from "../shared/sockPath";
import { GateClient, parseConnectInput, readConnection, writeConnection } from "./gate";
import { loadWorkflowGraph } from "./graph";
import { HookServer, type SessionHookEvent } from "./hooks";
import { ensureShim, writeSessionSettings } from "./hookShim";
import { loginShellEnv, PtyManager, registerPtyIpc } from "./pty";
import { discoverSessions, readRunPointer, watchSessions } from "./sessions";
import { findClaude, installPlugin, setupStatus, updatePlugin } from "./setup";

/**
 * The main process: one window, and the four things it shows wired together.
 *
 * - Terminals are real `claude` processes in ptys (PtyManager). Each is
 *   started with a settings file whose hooks talk to this process over a
 *   unix socket (HookServer), so a question or a permission prompt in any of
 *   them is held here until the person answers it in the window — the
 *   terminal never shows the prompt, and nothing is typed into it.
 * - Sessions are what is on disk under ~/.claude/projects, merged with the
 *   ptys this window owns and with what the hooks last said each one was
 *   doing. A session asleep on disk is woken with `claude --resume`.
 * - Runs come from gate's client API on the person's own key: a snapshot of
 *   their unfinished runs, then every event as it happens.
 */

let win: BrowserWindow | null = null;
const ptys = new PtyManager();
const hooks = new HookServer();
let gate: GateClient | null = null;
let teamId: string | undefined;

/** Session id ↔ terminal, learned from the SessionStart hook. */
const sessionOfPty = new Map<string, string>();
const ptyOfSession = new Map<string, string>();
/** What each session's hooks last said. */
const statusOf = new Map<string, { status: SessionStatus; at: number }>();
/** Live events per run, from the stream; what `executions:events` serves after the recorded steps. */
const liveEvents = new Map<string, WorkflowEvent[]>();
let executions: Execution[] = [];

const hookDir = () => join(app.getPath("userData"), "hooks");

// ------------------------------------------------------------------ window

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "gate cockpit",
    backgroundColor: "#0f1115",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void w.loadFile(join(__dirname, "../renderer/index.html"));
  w.on("closed", () => {
    // Terminals belong to the window that showed them.
    ptys.killByOwner(w.webContents);
    win = null;
  });
  return w;
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------------------------------------------------------- sessions

function sessionList(): ClaudeSession[] {
  const seen = new Set<string>();
  const out: ClaudeSession[] = [];
  const now = Date.now();
  for (const s of discoverSessions({ limit: 60 })) {
    seen.add(s.id);
    const ptyId = ptyOfSession.get(s.id) ?? null;
    const live = ptyId ? ptys.get(ptyId) : null;
    const said = statusOf.get(s.id);
    out.push({
      id: s.id,
      ptyId: live?.alive ? ptyId : null,
      cwd: s.cwd ?? homedir(),
      title: s.title,
      startedAt: s.startedAt,
      lastActiveAt: Math.max(s.lastActiveAt, live?.lastOutputAt ?? 0, said?.at ?? 0),
      presence: live?.alive ? "live" : "asleep",
      status: live?.alive ? (said?.status ?? "idle") : "exited",
      run: readRunPointer(s.id),
    });
  }
  // A terminal whose session id is not known yet (just started, no hook
  // heard) still deserves a row, or the person cannot see what they opened.
  for (const p of ptys.list()) {
    if (!p.alive) continue;
    const sid = sessionOfPty.get(p.ptyId);
    if (sid && seen.has(sid)) continue;
    out.push({
      id: sid ?? `pty:${p.ptyId}`,
      ptyId: p.ptyId,
      cwd: p.cwd,
      title: null,
      startedAt: now,
      lastActiveAt: p.lastOutputAt || now,
      presence: "live",
      status: statusOf.get(sid ?? "")?.status ?? "working",
      run: sid ? readRunPointer(sid) : null,
    });
  }
  out.sort((a, b) => Number(b.presence === "live") - Number(a.presence === "live") || b.lastActiveAt - a.lastActiveAt);
  return out;
}

let sessionsTimer: ReturnType<typeof setTimeout> | null = null;
function sessionsChanged(): void {
  if (sessionsTimer) return;
  sessionsTimer = setTimeout(() => {
    sessionsTimer = null;
    send(push.sessionsChanged, sessionList());
  }, 150);
}

function claudeEnv(ptyId: string): Record<string, string> {
  return {
    ...loginShellEnv(),
    COCKPIT_PTY: ptyId,
    COCKPIT_SOCK: cockpitSockPath(app.getPath("userData")),
    // A GUI app's TERM is nothing; the TUI wants a real one.
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  };
}

function spawnClaude(cwd: string, extraArgv: string[], sessionId: string | null): Result<{ ptyId: string }> {
  if (!win) return { ok: false, error: "no window" };
  const env = loginShellEnv();
  const claude = findClaude(env);
  if (!claude) return { ok: false, error: "claude is not on your PATH" };
  const ptyId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const shim = ensureShim(hookDir());
  const settings = writeSessionSettings(hookDir(), ptyId, shim);
  const dir = existsSync(cwd) ? cwd : homedir();
  try {
    ptys.spawn({
      ptyId,
      cwd: dir,
      argv: [claude.path, "--settings", settings, ...extraArgv],
      env: claudeEnv(ptyId),
      sessionId,
      owner: win.webContents,
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (sessionId) {
    sessionOfPty.set(ptyId, sessionId);
    ptyOfSession.set(sessionId, ptyId);
  }
  sessionsChanged();
  return { ok: true, value: { ptyId } };
}

/** Types a first prompt once the TUI has drawn itself and gone quiet. */
function typeWhenReady(ptyId: string, text: string): void {
  const started = Date.now();
  const tick = () => {
    const p = ptys.get(ptyId);
    if (!p || !p.alive) return;
    const quiet = p.hasOutput && Date.now() - p.lastOutputAt > 1200;
    if (quiet || Date.now() - started > 20_000) {
      ptys.write(ptyId, text);
      setTimeout(() => ptys.write(ptyId, "\r"), 200);
      return;
    }
    setTimeout(tick, 250);
  };
  setTimeout(tick, 1500);
}

// ------------------------------------------------------------------- hooks

function onHook(e: SessionHookEvent): void {
  if (e.ptyId) {
    const known = sessionOfPty.get(e.ptyId);
    if (known !== e.sessionId) {
      sessionOfPty.set(e.ptyId, e.sessionId);
      ptyOfSession.set(e.sessionId, e.ptyId);
      ptys.setSession(e.ptyId, e.sessionId);
    }
  }
  const status: SessionStatus | null =
    e.kind === "start" || e.kind === "prompt" || e.kind === "working"
      ? "working"
      : e.kind === "idle"
        ? "idle"
        : e.kind === "waiting"
          ? "waiting"
          : e.kind === "blocked"
            ? "blocked"
            : e.kind === "end"
              ? "exited"
              : null;
  if (status) statusOf.set(e.sessionId, { status, at: e.at });
  sessionsChanged();
}

let lastPendingIds = new Set<string>();
function onPending(pending: Pending[]): void {
  send(push.asksChanged, pending);
  const ids = new Set(pending.map((p) => p.id));
  for (const p of pending) {
    if (lastPendingIds.has(p.id)) continue;
    // A session with a question out is waiting, whatever its last hook said.
    statusOf.set(p.sessionId, { status: p.kind === "permission" ? "blocked" : "waiting", at: p.askedAt });
    notify(p);
  }
  lastPendingIds = ids;
  if (process.platform === "darwin") app.dock?.setBadge(pending.length ? String(pending.length) : "");
  sessionsChanged();
}

function notify(p: Pending): void {
  if (!Notification.isSupported()) return;
  const title = p.kind === "permission" ? "Approval needed" : p.kind === "approval" ? "Your approval" : "A question for you";
  const body = p.kind === "permission" ? `${p.toolName}: ${p.summary}` : (p.questions[0]?.question ?? "");
  const n = new Notification({ title, body, silent: false });
  n.on("click", () => {
    win?.show();
    win?.focus();
  });
  n.show();
}

// -------------------------------------------------------------------- gate

function connectGate(): void {
  const c = readConnection();
  gate = c ? new GateClient(c) : null;
}

let streamAbort: AbortController | null = null;
function startStream(): void {
  streamAbort?.abort();
  streamAbort = null;
  if (!gate) return;
  const abort = new AbortController();
  streamAbort = abort;
  gate.stream((frame: StreamFrame) => {
    if (frame.type === "snapshot") {
      executions = frame.executions;
    } else {
      const list = liveEvents.get(frame.executionId) ?? [];
      list.push(frame);
      if (list.length > 2000) list.shift();
      liveEvents.set(frame.executionId, list);
      const run = executions.find((x) => x.id === frame.executionId);
      if (run) {
        if (frame.type === "run.paused") run.pausedAt = frame.at;
        if (frame.type === "run.resumed") run.pausedAt = null;
        if (frame.type === "workflow.completed") {
          run.status = frame.status;
          run.finishedAt = frame.at;
        }
        if (frame.type === "workflow.failed") {
          run.status = "failed";
          run.finishedAt = frame.at;
          run.error = { code: frame.code, message: frame.message };
        }
      } else {
        // A run started after the snapshot: fetch it so the list has it.
        void refreshExecutions();
      }
    }
    send(push.executionEvent, frame);
  }, abort.signal);
}

async function refreshExecutions(): Promise<Execution[]> {
  if (!gate) return executions;
  try {
    executions = await gate.executions(50);
  } catch {
    // Offline: the last list stands.
  }
  return executions;
}

/** The recorded steps as the events they would have been, then what the stream has added. */
async function eventsFor(executionId: string): Promise<WorkflowEvent[]> {
  const out: WorkflowEvent[] = [];
  if (gate) {
    try {
      const { execution, steps } = await gate.execution(executionId);
      for (const raw of steps as Array<Record<string, unknown>>) {
        const nodeId = String(raw.nodeId);
        const stepIndex = Number(raw.stepIndex);
        const visit = Number(raw.visit ?? 1);
        out.push({ type: "node.started", executionId, at: Number(raw.startedAt), nodeId, stepIndex, visit });
        if (raw.status === "failed") {
          const err = (raw.error as { code: string; message: string } | null) ?? { code: "NODE_FAILED", message: "failed" };
          out.push({ type: "node.failed", executionId, at: Number(raw.finishedAt), nodeId, stepIndex, code: err.code, message: err.message });
        } else {
          out.push({
            type: "node.completed",
            executionId,
            at: Number(raw.finishedAt),
            nodeId,
            stepIndex,
            durationMs: Number(raw.finishedAt) - Number(raw.startedAt),
          });
        }
      }
      const lastStepAt = out.length ? out[out.length - 1].at : 0;
      // What the stream saw after the last recorded step: the node that is
      // out now, and whether the person holds it.
      for (const e of liveEvents.get(executionId) ?? []) if (e.at > lastStepAt) out.push(e);
      if (execution.status === "running" && execution.pausedAt && !out.some((e) => e.type === "run.paused" && e.at >= execution.pausedAt!)) {
        const current = readCurrentNode(executionId);
        if (current) out.push({ type: "run.paused", executionId, at: execution.pausedAt, nodeId: current });
      }
    } catch {
      // Offline: only what the stream had.
      out.push(...(liveEvents.get(executionId) ?? []));
    }
  }
  return out;
}

/** The node a session-driven run is on, from the session that drives it. */
function readCurrentNode(executionId: string): string | null {
  for (const s of discoverSessions({ limit: 60 })) {
    const p = readRunPointer(s.id);
    if (p?.executionId === executionId) return p.nodeId;
  }
  return null;
}

// --------------------------------------------------------------------- ipc

function registerIpc(): void {
  registerPtyIpc(ipcMain, ptys);

  ipcMain.handle(invoke.setupStatus, async () => {
    const status = await setupStatus(loginShellEnv());
    if (status.gate.connected) teamId = status.gate.team ?? undefined;
    return status;
  });
  ipcMain.handle(invoke.setupInstallPlugin, () => installPlugin(loginShellEnv()));
  ipcMain.handle(invoke.setupUpdatePlugin, () => updatePlugin(loginShellEnv()));
  ipcMain.handle(invoke.setupConnect, async (_e, input: string): Promise<Result<unknown>> => {
    const parsed = parseConnectInput(String(input ?? ""));
    if ("error" in parsed) return { ok: false, error: parsed.error };
    try {
      const me = await new GateClient(parsed).me();
      // The same two extra keys the gate CLI writes, so either tool reads the other's login.
      writeConnection(parsed, { team: me.teamId, user: me.email });
      connectGate();
      teamId = me.teamId;
      startStream();
      await refreshExecutions();
      return { ok: true, value: await setupStatus(loginShellEnv()) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(invoke.sessionsList, () => sessionList());
  ipcMain.handle(invoke.sessionsOpen, (_e, sessionId: string): Result<{ ptyId: string }> => {
    const live = ptyOfSession.get(sessionId);
    if (live && ptys.get(live)?.alive) return { ok: true, value: { ptyId: live } };
    const found = discoverSessions({ limit: 200 }).find((s) => s.id === sessionId);
    return spawnClaude(found?.cwd ?? homedir(), ["--resume", sessionId], sessionId);
  });
  ipcMain.handle(invoke.sessionsStart, (_e, cwd: string, prompt: string | null): Result<{ ptyId: string }> => {
    const r = spawnClaude(cwd, [], null);
    if (r.ok && prompt) typeWhenReady(r.value.ptyId, prompt);
    return r;
  });
  ipcMain.handle(invoke.sessionsClose, async (_e, ptyId: string) => {
    await ptys.kill(ptyId);
    sessionsChanged();
  });

  ipcMain.handle(invoke.asksList, () => hooks.pending());
  ipcMain.handle(invoke.asksAnswer, (_e, id: string, answer: AskAnswer) => hooks.answer(id, answer));
  ipcMain.handle(invoke.asksDecide, (_e, id: string, decision: PermissionDecision) => hooks.decide(id, decision));

  ipcMain.handle(invoke.executionsList, () => refreshExecutions());
  ipcMain.handle(invoke.executionsEvents, (_e, id: string) => eventsFor(id));
  ipcMain.handle(invoke.executionsCancel, async (_e, id: string): Promise<Result> => {
    if (!gate) return { ok: false, error: "not connected to a gate" };
    return gate.cancel(id);
  });
  ipcMain.handle(invoke.executionsGraph, (_e, workflowId: string) => loadWorkflowGraph(workflowId, teamId));

  ipcMain.handle(invoke.windowFocus, () => {
    win?.show();
    win?.focus();
  });
}

// -------------------------------------------------------------------- boot

const single = app.requestSingleInstanceLock();
if (!single) app.quit();

app.on("second-instance", () => {
  win?.show();
  win?.focus();
});

app.whenReady().then(async () => {
  mkdirSync(hookDir(), { recursive: true, mode: 0o700 });
  // Boots the login shell once (~0.5 s) so the first terminal does not pay for it.
  loginShellEnv();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
      { role: "editMenu" as const },
      { role: "viewMenu" as const },
      { role: "windowMenu" as const },
    ]),
  );
  registerIpc();
  hooks.onSessionEvent(onHook);
  hooks.onChange(onPending);
  await hooks.start(cockpitSockPath(app.getPath("userData")));
  ptys.onExit((ptyId) => {
    const sid = sessionOfPty.get(ptyId);
    if (sid) statusOf.set(sid, { status: "exited", at: Date.now() });
    sessionsChanged();
  });
  ptys.onOutput(() => sessionsChanged());
  watchSessions(sessionsChanged);

  connectGate();
  if (gate) {
    try {
      teamId = (await gate.me()).teamId;
    } catch {
      // Offline at start: the setup screen says so; the stream reconnects.
    }
    startStream();
    void refreshExecutions();
  }
  win = createWindow();
});

app.on("window-all-closed", () => {
  // Terminals die with the window: a cockpit with nothing to show holds nothing.
  ptys.killAll(0);
  void hooks.stop().finally(() => app.quit());
});

app.on("before-quit", () => {
  // Synchronous: a child trapping SIGHUP must not outlive an app with no tick left to sweep it.
  ptys.killAll(0);
});

app.on("activate", () => {
  if (!win) win = createWindow();
});
