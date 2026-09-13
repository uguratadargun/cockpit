import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import { invoke, push } from "../shared/ipc";
import type {
  AskAnswer,
  ChangedFile,
  ClaudeSession,
  Execution,
  GateUsage,
  Pending,
  PermissionDecision,
  PtyInfo,
  RemoteInfo,
  Result,
  RunTarget,
  SetupStatus,
  StreamFrame,
  UpdateStatus,
  WorkflowEvent,
  WorkflowGraph,
  WorkflowSummary,
} from "../shared/types";

/**
 * `window.cockpit`: everything the renderer may do, typed, and nothing else.
 *
 * Push channels hand back an unsubscribe; the renderer holds it for the life
 * of the component. Terminal bytes travel on a channel per terminal so a
 * window with six of them open does not fan every byte out six times.
 */

type Unsubscribe = () => void;

function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const handler = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  version: __APP_VERSION__,
  setup: {
    status: (): Promise<SetupStatus> => ipcRenderer.invoke(invoke.setupStatus),
    installPlugin: (): Promise<Result> => ipcRenderer.invoke(invoke.setupInstallPlugin),
    connect: (token: string): Promise<Result<SetupStatus>> => ipcRenderer.invoke(invoke.setupConnect, token),
    /** Refreshes the marketplace and re-installs the plugin; terminals started afterwards run the new one. */
    updatePlugin: (): Promise<Result> => ipcRenderer.invoke(invoke.setupUpdatePlugin),
  },
  sessions: {
    list: (): Promise<ClaudeSession[]> => ipcRenderer.invoke(invoke.sessionsList),
    /** Opens a terminal for a session: attaches if live, `claude --resume` if asleep. */
    open: (sessionId: string): Promise<Result<{ ptyId: string }>> => ipcRenderer.invoke(invoke.sessionsOpen, sessionId),
    /**
     * A fresh `claude` for a project, optionally with a first prompt typed in (e.g. `/gate:run dev "..."`).
     * `target` says where: this machine in `cwd` (the default), or the gate server in a connected repository.
     */
    start: (cwd: string, prompt?: string, target?: RunTarget): Promise<Result<{ ptyId: string }>> =>
      ipcRenderer.invoke(invoke.sessionsStart, cwd, prompt ?? null, target ?? null),
    close: (ptyId: string): Promise<void> => ipcRenderer.invoke(invoke.sessionsClose, ptyId),
    onChange: (cb: (sessions: ClaudeSession[]) => void): Unsubscribe => on(push.sessionsChanged, cb),
  },
  pty: {
    write: (ptyId: string, data: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(invoke.ptyWrite, ptyId, data),
    resize: (ptyId: string, cols: number, rows: number): Promise<void> => ipcRenderer.invoke(invoke.ptyResize, ptyId, cols, rows),
    /** Asks the process to repaint (SIGWINCH dance) after a fresh xterm attaches. */
    redraw: (ptyId: string): Promise<void> => ipcRenderer.invoke(invoke.ptyRedraw, ptyId),
    list: (): Promise<PtyInfo[]> => ipcRenderer.invoke(invoke.ptyList),
    onData: (ptyId: string, cb: (data: string) => void): Unsubscribe => on(push.ptyData(ptyId), cb),
    onExit: (ptyId: string, cb: (code: number) => void): Unsubscribe => on(push.ptyExit(ptyId), cb),
  },
  asks: {
    list: (): Promise<Pending[]> => ipcRenderer.invoke(invoke.asksList),
    answer: (id: string, answer: AskAnswer): Promise<Result> => ipcRenderer.invoke(invoke.asksAnswer, id, answer),
    decide: (id: string, decision: PermissionDecision): Promise<Result> => ipcRenderer.invoke(invoke.asksDecide, id, decision),
    onChange: (cb: (pending: Pending[]) => void): Unsubscribe => on(push.asksChanged, cb),
  },
  executions: {
    list: (): Promise<Execution[]> => ipcRenderer.invoke(invoke.executionsList),
    events: (executionId: string): Promise<WorkflowEvent[]> => ipcRenderer.invoke(invoke.executionsEvents, executionId),
    cancel: (executionId: string): Promise<Result> => ipcRenderer.invoke(invoke.executionsCancel, executionId),
    graph: (workflowId: string): Promise<Result<WorkflowGraph>> => ipcRenderer.invoke(invoke.executionsGraph, workflowId),
    /** The team's workflows, from the mirror on this machine. */
    workflows: (): Promise<Result<WorkflowSummary[]>> => ipcRenderer.invoke(invoke.executionsWorkflows),
    /** What `git status`/`git diff` say in the run's session's cwd — not gate's own data. */
    changedFiles: (executionId: string): Promise<Result<ChangedFile[]>> => ipcRenderer.invoke(invoke.executionsChangedFiles, executionId),
    fileDiff: (executionId: string, file: ChangedFile): Promise<Result<string>> => ipcRenderer.invoke(invoke.executionsFileDiff, executionId, file),
    onEvent: (cb: (frame: StreamFrame) => void): Unsubscribe => on(push.executionEvent, cb),
  },
  gate: {
    /** What the pool has left: the 5h and 7d windows, and when each resets. */
    usage: (): Promise<Result<GateUsage>> => ipcRenderer.invoke(invoke.gateUsage),
  },
  remote: {
    /** Whether this key may run sessions on the gate server, whether it can, and in which repositories. */
    info: (): Promise<RemoteInfo> => ipcRenderer.invoke(invoke.remoteInfo),
    /** The connected repository matching a local project's `origin`, when there is one. */
    match: (cwd: string): Promise<{ repo: string | null; origin: string | null }> => ipcRenderer.invoke(invoke.remoteMatch, cwd),
  },
  window: {
    focus: (): Promise<void> => ipcRenderer.invoke(invoke.windowFocus),
  },
  update: {
    onStatus: (cb: (status: UpdateStatus) => void): Unsubscribe => on(push.updateStatus, cb),
    /** Windows/Linux: installs what's already downloaded and restarts. macOS: opens the release page instead. */
    install: (): Promise<void> => ipcRenderer.invoke(invoke.updateInstall),
  },
};

export type CockpitApi = typeof api;

contextBridge.exposeInMainWorld("cockpit", api);
