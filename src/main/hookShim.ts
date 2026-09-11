/**
 * The shim every Claude Code hook runs, and the per-terminal settings file
 * that points the hooks at it.
 *
 * The shim is a tiny pipe: read the hook payload on stdin, tag it with the
 * terminal it came from, forward it over the cockpit's unix socket, print the
 * one-line reply. All the real logic lives in `HookServer`. A session whose
 * cockpit is gone behaves as plain Claude Code: the connect fails, the shim
 * exits 0 with no output, and the TUI shows its own prompt.
 *
 * Two hooks may block for as long as a person takes to answer — the
 * AskUserQuestion PreToolUse and PermissionRequest — so the shim waits on
 * those until the server replies or hangs up; every other event self-times
 * out after five seconds so a slow cockpit never stalls a session.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The name of the shim file inside the dir `ensureShim` is given. */
export const SHIM_FILE = "cockpit-hook.cjs";

/** How long a non-blocking hook waits for the server before giving up (ms). */
export const SHIM_STATUS_TIMEOUT_MS = 5000;

/** Seconds Claude Code allows the two blocking hooks; a day, i.e. effectively forever. */
export const BLOCKING_HOOK_TIMEOUT_S = 86400;

/**
 * The argument the status-only PreToolUse entry passes: the shim tags the
 * payload `hook_role: "status"` and never waits, so an AskUserQuestion (which
 * matches both the `AskUserQuestion` and the `*` PreToolUse entries) is held
 * once, by the untagged shim, not twice.
 */
export const STATUS_ARG = "--status";

export const SHIM_SOURCE = `#!/usr/bin/env node
'use strict';
// gate cockpit hook shim — written by the app; edits are overwritten.
const net = require('net');
const crypto = require('crypto');
const isStatus = process.argv.includes('${STATUS_ARG}');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('error', () => {});
process.stdin.on('end', () => {
  const sock = process.env.COCKPIT_SOCK;
  if (!sock) process.exit(0);
  let payload = {};
  try { payload = JSON.parse(data || '{}'); } catch (_) {}
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
  payload.pty_id = process.env.COCKPIT_PTY || null;
  if (isStatus) payload.hook_role = 'status';
  const event = payload.hook_event_name;
  const patient = !isStatus && (event === 'PermissionRequest' || (event === 'PreToolUse' && payload.tool_name === 'AskUserQuestion'));
  const id = crypto.randomBytes(8).toString('hex');
  let buf = '';
  let done = false;
  const finish = (line) => {
    if (done) return;
    done = true;
    if (line) process.stdout.write(line + '\\n');
    process.exit(0);
  };
  const c = net.createConnection(sock, () => {
    c.write(JSON.stringify({ v: 1, id, payload }) + '\\n');
  });
  c.setEncoding('utf8');
  c.on('data', (d) => {
    buf += d;
    const nl = buf.indexOf('\\n');
    if (nl !== -1) finish(buf.slice(0, nl).trim());
  });
  c.on('end', () => finish(buf.trim()));
  c.on('close', () => finish(buf.trim()));
  c.on('error', () => finish(''));
  if (!patient) setTimeout(() => finish(''), ${SHIM_STATUS_TIMEOUT_MS}).unref();
});
`;

/**
 * Writes the shim into `dir` (created if missing) and returns its path.
 * Idempotent: the file is rewritten only when its content differs, so a
 * running session's hooks never see a half-written script.
 */
export function ensureShim(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, SHIM_FILE);
  let current: string | null = null;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = null;
  }
  if (current !== SHIM_SOURCE) writeFileSync(path, SHIM_SOURCE, { encoding: "utf8", mode: 0o644 });
  return path;
}

/** A POSIX double-quoted word: the hook command runs through `sh -c`. */
function quote(s: string): string {
  return `"${s.replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;
}

/**
 * The command a hook entry runs: this very binary as node. Claude Code runs
 * hooks through `sh -c` with a minimal PATH, where bare `node` is often absent;
 * Electron's own executable is a full Node under `ELECTRON_RUN_AS_NODE=1`, and
 * it is guaranteed present — it is us.
 */
export function hookCommand(shimPath: string, ...args: string[]): string {
  return ["ELECTRON_RUN_AS_NODE=1", quote(process.execPath), quote(shimPath), ...args.map(quote)].join(" ");
}

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: "command"; command: string; timeout?: number }>;
}

/** The `hooks` block of a per-terminal settings file, as an object. */
export function sessionHooks(shimPath: string): Record<string, HookEntry[]> {
  const cmd = hookCommand(shimPath);
  const entry = (matcher?: string, timeout?: number, ...args: string[]): HookEntry => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: "command", command: args.length ? hookCommand(shimPath, ...args) : cmd, ...(timeout ? { timeout } : {}) }],
  });
  return {
    SessionStart: [entry()],
    UserPromptSubmit: [entry()],
    PreToolUse: [entry("AskUserQuestion", BLOCKING_HOOK_TIMEOUT_S), entry("*", undefined, STATUS_ARG)],
    PostToolUse: [entry("*")],
    PermissionRequest: [entry("*", BLOCKING_HOOK_TIMEOUT_S)],
    Notification: [entry()],
    Stop: [entry()],
    SessionEnd: [entry()],
  };
}

/**
 * Writes `<dir>/settings-<ptyId>.json` routing every relevant hook through the
 * shim and returns its path. Main passes it as `claude --settings <file>` and
 * sets `COCKPIT_PTY=<ptyId>` and `COCKPIT_SOCK=<socket>` on that terminal's
 * environment; the shim reads both.
 */
export function writeSessionSettings(dir: string, ptyId: string, shimPath: string): string {
  mkdirSync(dir, { recursive: true });
  const safe = ptyId.replace(/[^\w.-]/g, "_");
  const path = join(dir, `settings-${safe}.json`);
  const content = JSON.stringify({ hooks: sessionHooks(shimPath) }, null, 2) + "\n";
  if (!existsSync(path) || readFileSync(path, "utf8") !== content) writeFileSync(path, content, "utf8");
  return path;
}
