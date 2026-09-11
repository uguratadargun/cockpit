import { app, BrowserWindow, ipcMain, Menu, Notification, shell } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { invoke, push } from "../shared/ipc";
import type {
  AskAnswer,
  ChangedFile,
  ClaudeSession,
  Execution,
  Pending,
  PermissionDecision,
  Result,
  RunPointer,
  SessionStatus,
  StreamFrame,
  WorkflowEvent,
} from "../shared/types";
import { cockpitSockPath } from "../shared/sockPath";
import { changedFilesFor, fileDiffFor } from "./changedFiles";
import { GateClient, parseConnectInput, readConnection, writeConnection } from "./gate";
import { listWorkflows, loadWorkflowGraph } from "./graph";
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

// Ubuntu 24.04+ blocks the unprivileged user namespace Chromium's sandbox wants unless an
// AppArmor profile allows it, so it falls back to the setuid chrome-sandbox helper — which
// then refuses to run because its packaged path/ownership isn't the root:root 4755 it demands.
// Neither the .deb (installs to a path with a space) nor the AppImage (extracted per-run,
// never root-owned) can satisfy that, so the sandbox is off on Linux; this renders only our
// own local UI, never arbitrary web content, so the renderer sandbox buys little here anyway.
if (process.platform === "linux") app.commandLine.appendSwitch("no-sandbox");

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
/**
 * A "working" session whose terminal has printed nothing for this long is
 * idle: Claude Code redraws its spinner while it thinks, so a quiet terminal
 * is one at its prompt. Covers a Stop hook that never reached us.
 */
const QUIET_MS = 12_000;

function statusFor(sessionId: string | null, live: { alive: boolean; hasOutput: boolean; lastOutputAt: number } | null, now: number): SessionStatus {
  if (!live?.alive) return "exited";
  const said = sessionId ? statusOf.get(sessionId) : undefined;
  const status = said?.status ?? "idle";
  if (status === "working" && live.hasOutput && now - live.lastOutputAt > QUIET_MS) return "idle";
  return status;
}

/**
 * Idle terminals are put to sleep.
 *
 * A `claude` at its prompt holds 150-400 MB, and a person who opened six
 * runs in a morning has six of them by lunch. One that has been idle this
 * long — nothing typed, nothing printed, no question out, no run in its
 * hands — is ended; its transcript is the session, so clicking it resumes
 * exactly where it was. `COCKPIT_HIBERNATE_MIN` overrides the default; 0
 * turns it off.
 */
const HIBERNATE_MS = Math.max(0, Number(process.env.COCKPIT_HIBERNATE_MIN ?? 10)) * 60_000;
/** When each terminal was last seen doing anything: output, a keystroke, a hook. */
const lastAliveAt = new Map<string, number>();

function touch(ptyId: string, at = Date.now()): void {
  lastAliveAt.set(ptyId, at);
}

/** Whether a terminal may be put to sleep now: idle long enough, nothing waiting on it, no run in its hands. */
function hibernatable(ptyId: string, now: number): boolean {
  const live = ptys.get(ptyId);
  if (!live?.alive) return false;
  const since = Math.max(lastAliveAt.get(ptyId) ?? 0, live.lastOutputAt);
  if (!since || now - since < HIBERNATE_MS) return false;
  const sid = sessionOfPty.get(ptyId);
  if (!sid) return false; // never heard from: too new to judge
  if (statusFor(sid, live, now) !== "idle") return false;
  if (hooks.pending().some((p) => p.sessionId === sid)) return false;
  const run = readRunPointer(sid);
  if (run && (run.state === "agent" || run.state === "wait" || run.state === "delegate")) {
    const execution = executions.find((e) => e.id === run.executionId);
    if (!execution || execution.status === "running") return false;
  }
  return true;
}

async function hibernateIdle(): Promise<void> {
  if (!HIBERNATE_MS) return;
  const now = Date.now();
  for (const p of ptys.list()) {
    if (!hibernatable(p.ptyId, now)) continue;
    const sid = sessionOfPty.get(p.ptyId);
    await ptys.kill(p.ptyId);
    if (sid) statusOf.set(sid, { status: "exited", at: now });
    sessionsChanged();
  }
}

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
  // Taken now: by the time `closed` fires the window is destroyed and
  // `w.webContents` throws ("Object has been destroyed"). The reference
  // itself stays comparable, which is all killByOwner needs.
  const contents = w.webContents;
  w.on("closed", () => {
    // Terminals belong to the window that showed them.
    ptys.killByOwner(contents);
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
      status: statusFor(s.id, live, now),
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
      status: statusFor(sid ?? null, p, now),
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
    touch(e.ptyId, e.at);
    const known = sessionOfPty.get(e.ptyId);
    if (known !== e.sessionId) {
      sessionOfPty.set(e.ptyId, e.sessionId);
      ptyOfSession.set(e.sessionId, e.ptyId);
      ptys.setSession(e.ptyId, e.sessionId);
    }
  }
  // A session that has just started is at its prompt, not working; work
  // begins with the first prompt submitted.
  const status: SessionStatus | null =
    e.kind === "prompt" || e.kind === "working"
      ? "working"
      : e.kind === "idle" || e.kind === "start"
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
  }, abort.signal, {
    onState: (state) => {
      streamConnected = state.connected;
      schedulePoll();
    },
  });
  schedulePoll();
}

/** Fetches the person's recent runs; when the list changed, the renderer gets it as a snapshot. */
async function refreshExecutions(): Promise<Execution[]> {
  if (!gate) return executions;
  try {
    const fresh = await gate.executions(50);
    const changed =
      fresh.length !== executions.length ||
      fresh.some((f, i) => {
        const e = executions[i];
        return !e || e.id !== f.id || e.status !== f.status || e.pausedAt !== f.pausedAt || e.stepCount !== f.stepCount;
      });
    executions = fresh;
    if (changed) send(push.executionEvent, { type: "snapshot", at: Date.now(), executions });
  } catch {
    // Offline: the last list stands.
  }
  return executions;
}

/**
 * The list is also polled, because the stream is not always there: a gate
 * older than 0.34.0 has no stream, and a dropped connection may take a while
 * to come back. Quick while there is no stream, slow while there is one.
 */
let streamConnected = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePoll(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void refreshExecutions().finally(schedulePoll);
  }, streamConnected ? 60_000 : 10_000);
  pollTimer.unref();
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
      if (execution.status === "running") {
        const current = readCurrentNode(executionId);
        if (execution.pausedAt && !out.some((e) => e.type === "run.paused" && e.at >= execution.pausedAt!)) {
          // The person holds a node; the run's clock is stopped on it.
          if (current?.nodeId) out.push({ type: "run.paused", executionId, at: execution.pausedAt, nodeId: current.nodeId });
        } else if (!execution.pausedAt && current?.nodeId && current.at >= lastStepAt && isWorking(current.state)) {
          // What the stream would have shown, had it seen it: the node the
          // session was told to work is still its turn. A bus wiped by a gate
          // restart, or a stream that reconnected mid-run, has nothing to say
          // about it; the session's own pointer does. Guarded to the run it
          // was written for and to an instruction handed out no earlier than
          // the last recorded step, so a stale file cannot relabel the run.
          if (!out.some((e) => e.type === "node.started" && e.at >= current.at)) {
            out.push({ type: "node.started", executionId, at: current.at, nodeId: current.nodeId, stepIndex: steps.length, visit: 1 });
          }
        }
      }
    } catch {
      // Offline: only what the stream had.
      out.push(...(liveEvents.get(executionId) ?? []));
    }
  }
  return out;
}

/** A run state the session is still turning: its node has not yet returned. */
function isWorking(state: RunPointer["state"]): boolean {
  return state === "agent" || state === "wait" || state === "delegate";
}

/** What the session driving this run was last told, from its own pointer file. */
function readCurrentNode(executionId: string): RunPointer | null {
  for (const s of discoverSessions({ limit: 60 })) {
    const p = readRunPointer(s.id);
    if (p?.executionId === executionId) return p;
  }
  return null;
}

/** The directory the run's session is sitting in — gate has no notion of this, only the session's own transcript does. */
function cwdForExecution(executionId: string): string | null {
  const execution = executions.find((e) => e.id === executionId);
  const sessionId = execution?.client?.session;
  if (!sessionId) return null;
  return discoverSessions({ limit: 200 }).find((s) => s.id === sessionId)?.cwd ?? null;
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
  ipcMain.handle(invoke.executionsWorkflows, () => listWorkflows(teamId));
  ipcMain.handle(invoke.executionsChangedFiles, async (_e, id: string): Promise<Result<ChangedFile[]>> => {
    const cwd = cwdForExecution(id);
    if (!cwd) return { ok: false, error: "no working directory known for this run" };
    return changedFilesFor(cwd);
  });
  ipcMain.handle(invoke.executionsFileDiff, async (_e, id: string, file: ChangedFile): Promise<Result<string>> => {
    const cwd = cwdForExecution(id);
    if (!cwd) return { ok: false, error: "no working directory known for this run" };
    return fileDiffFor(cwd, file);
  });

  ipcMain.handle(invoke.gateUsage, async (): Promise<Result<unknown>> => {
    if (!gate) return { ok: false, error: "not connected to a gate" };
    try {
      return { ok: true, value: await gate.usage({ signal: AbortSignal.timeout(10_000) }) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

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
  ptys.onOutput((ptyId, at) => {
    touch(ptyId, at);
    sessionsChanged();
  });
  watchSessions(sessionsChanged);
  if (HIBERNATE_MS) setInterval(() => void hibernateIdle(), 60_000).unref();

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
