/**
 * The IPC surface, named once.
 *
 * Every `invoke` channel the renderer may call and every push channel main
 * may send on. The preload builds `window.cockpit` from these; main registers
 * handlers against the same strings; nothing else spells a channel name.
 */

export const invoke = {
  // setup
  setupStatus: "setup:status",
  setupInstallPlugin: "setup:install-plugin",
  setupConnect: "setup:connect",
  setupUpdatePlugin: "setup:update-plugin",
  // sessions
  sessionsList: "sessions:list",
  sessionsOpen: "sessions:open",
  sessionsStart: "sessions:start",
  sessionsClose: "sessions:close",
  // pty
  ptyWrite: "pty:write",
  ptyResize: "pty:resize",
  ptyRedraw: "pty:redraw",
  ptyList: "pty:list",
  // questions and approvals
  asksList: "asks:list",
  asksAnswer: "asks:answer",
  asksDecide: "asks:decide",
  // executions
  executionsList: "executions:list",
  executionsEvents: "executions:events",
  executionsCancel: "executions:cancel",
  executionsGraph: "executions:graph",
  executionsWorkflows: "executions:workflows",
  executionsChangedFiles: "executions:changed-files",
  executionsFileDiff: "executions:file-diff",
  // gate
  gateUsage: "gate:usage",
  // remote sessions
  remoteInfo: "remote:info",
  remoteMatch: "remote:match",
  // window
  windowFocus: "window:focus",
  // update
  updateInstall: "update:install",
} as const;

export const push = {
  sessionsChanged: "sessions:changed",
  asksChanged: "asks:changed",
  executionEvent: "executions:event",
  updateStatus: "update:status",
  /** Per terminal: `pty:data:<ptyId>` carries bytes, `pty:exit:<ptyId>` the exit code. */
  ptyData: (ptyId: string) => `pty:data:${ptyId}`,
  ptyExit: (ptyId: string) => `pty:exit:${ptyId}`,
} as const;
