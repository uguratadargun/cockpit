import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { RunPointer } from "../shared/types";
import { gateHome } from "./gate";
import { readTranscriptSummary } from "./transcript";

/**
 * Claude Code sessions as they exist on disk.
 *
 * Claude Code keeps one transcript per session at
 * <configDir>/projects/<encoded cwd>/<sessionId>.jsonl. That file is the
 * session: a live one is being appended to, an asleep one can be woken with
 * `claude --resume <id>`. Nothing else has to be running for the list to be
 * right, which is why the cockpit reads the directory and not a registry.
 *
 * The run a session is driving is a second file, ~/.gate/sessions/<id>.json,
 * written by the plugin's `gate` command each time it hands the session an
 * instruction (src/client/step.ts in the gate repository). Both are watched.
 */

export interface DiscoveredSession {
  id: string;
  transcriptPath: string;
  projectDir: string;
  cwd: string | null;
  startedAt: number;
  lastActiveAt: number;
  title: string | null;
}

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function projectsDir(): string {
  return join(claudeConfigDir(), "projects");
}

export function gateSessionsDir(): string {
  return join(gateHome(), "sessions");
}

/** The first `cwd` and the first `timestamp` in the transcript's opening lines, read without loading the file. */
function readHead(path: string): { cwd: string | null; firstAt: number | null } {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const lines = buf.subarray(0, n).toString("utf8").split("\n");
    let cwd: string | null = null;
    let firstAt: number | null = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec: { cwd?: unknown; timestamp?: unknown };
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // a cut-off last line
      }
      if (cwd === null && typeof rec.cwd === "string" && rec.cwd) cwd = rec.cwd;
      if (firstAt === null && typeof rec.timestamp === "string") {
        const t = Date.parse(rec.timestamp);
        if (Number.isFinite(t)) firstAt = t;
      }
      if (cwd !== null && firstAt !== null) break;
    }
    return { cwd, firstAt };
  } catch {
    return { cwd: null, firstAt: null };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Every transcript on this machine, newest activity first.
 *
 * Only the top-level `.jsonl` of each project directory is a session: the
 * `<sessionId>/` directories next to them hold subagent transcripts and
 * tool results. `sinceMs` drops transcripts not touched since then, before
 * any file is opened; `limit` caps how many are read in full.
 */
export function discoverSessions(opts: { limit?: number; sinceMs?: number } = {}): DiscoveredSession[] {
  const limit = opts.limit ?? 100;
  const root = projectsDir();
  const found: Array<{ path: string; projectDir: string; mtime: number; birth: number }> = [];
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return [];
  }
  for (const project of projects) {
    const dir = join(root, project);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const path = join(dir, entry);
      try {
        const st = statSync(path);
        if (!st.isFile() || st.size === 0) continue;
        if (opts.sinceMs !== undefined && st.mtimeMs < opts.sinceMs) continue;
        found.push({ path, projectDir: dir, mtime: st.mtimeMs, birth: st.birthtimeMs || st.ctimeMs || st.mtimeMs });
      } catch {
        // gone between readdir and stat
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);

  const sessions: DiscoveredSession[] = [];
  for (const f of found.slice(0, limit)) {
    const head = readHead(f.path);
    let summary: ReturnType<typeof readTranscriptSummary> | null = null;
    try {
      summary = readTranscriptSummary(f.path);
    } catch {
      summary = null;
    }
    sessions.push({
      id: basename(f.path, ".jsonl"),
      transcriptPath: f.path,
      projectDir: f.projectDir,
      cwd: head.cwd ?? summary?.cwd ?? null,
      startedAt: Math.round(head.firstAt ?? f.birth),
      lastActiveAt: Math.round(Math.max(f.mtime, summary?.lastAt ?? 0)),
      title: summary?.title ?? null,
    });
  }
  return sessions;
}

const SESSION_ID = /^[A-Za-z0-9._-]{1,80}$/;

/** What ~/.gate/sessions/<id>.json says, or null when the session never drove a run here. */
export function readRunPointer(sessionId: string): RunPointer | null {
  if (!SESSION_ID.test(sessionId)) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(join(gateSessionsDir(), `${sessionId}.json`), "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || typeof raw.executionId !== "string" || typeof raw.state !== "string") return null;
  return {
    executionId: raw.executionId,
    state: raw.state as RunPointer["state"],
    nodeId: typeof raw.nodeId === "string" ? raw.nodeId : null,
    agent: typeof raw.agent === "string" ? raw.agent : null,
    asks: raw.asks === "question" || raw.asks === "approval" ? raw.asks : null,
    at: typeof raw.at === "number" ? raw.at : 0,
  };
}

/**
 * Watches a directory that may not exist yet.
 *
 * When it is missing, the nearest existing ancestor is watched instead and
 * the real watch is attached as soon as the directory appears. A watcher
 * that errors (the directory removed under it) is dropped and re-attached
 * the same way.
 */
function watchDir(dir: string, recursive: boolean, onEvent: () => void): () => void {
  let watcher: FSWatcher | null = null;
  let watching: string | null = null;
  /** True while the watch sits on an ancestor because `dir` is not there yet. */
  let watchedAncestor = false;
  let poll: NodeJS.Timeout | null = null;
  let closed = false;

  /** `dir` itself, or the closest ancestor that exists; null when not even the root does. */
  const nearest = (): string | null => {
    let target = dir;
    while (!existsSync(target)) {
      const parent = dirname(target);
      if (parent === target) return null;
      target = parent;
    }
    return target;
  };

  const retry = () => {
    const t = setTimeout(attach, 1_000);
    t.unref();
  };

  const attach = () => {
    if (closed) return;
    if (watcher) {
      watcher.close();
      watcher = null;
      watching = null;
    }
    const target = nearest();
    if (target === null) return;
    const isTarget = target === dir;
    // Landing on `dir` after waiting for it is itself a change to report:
    // whatever was written in there before this watch existed was missed.
    const arrived = isTarget && watchedAncestor;
    try {
      watcher = watch(target, { persistent: false, recursive: isTarget && recursive }, () => {
        if (isTarget) {
          onEvent();
          return;
        }
        // Waiting for `dir` to appear: step down whenever something closer
        // to it now exists. `mkdir -p` creates several levels at once and a
        // non-recursive watch only sees the first, so one event may have to
        // carry the watch down more than one level.
        if (nearest() !== target) attach();
      });
      watching = target;
      watchedAncestor = !isTarget;
      watcher.on("error", retry);
    } catch {
      watcher = null;
      retry();
      return;
    }
    if (arrived) onEvent();
    // While parked on an ancestor, also look every second: FSEvents starts
    // its stream a beat after watch() returns, and a directory created in
    // that beat is never reported. Cheap, and only until `dir` exists.
    if (!isTarget && !poll) {
      poll = setInterval(() => {
        if (nearest() !== watching) attach();
      }, 1_000);
      poll.unref();
    } else if (isTarget && poll) {
      clearInterval(poll);
      poll = null;
    }
    // Something closer may have appeared between the walk and the watch.
    if (!isTarget && nearest() !== watching) attach();
  };
  attach();

  return () => {
    closed = true;
    watcher?.close();
    watcher = null;
    if (poll) clearInterval(poll);
    poll = null;
  };
}

/** Calls back (debounced, 300ms) when any transcript or run pointer changes. */
export function watchSessions(cb: () => void): () => void {
  let timer: NodeJS.Timeout | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        cb();
      } catch {
        // a listener's failure must not stop the watch
      }
    }, 300);
  };
  const stops = [watchDir(projectsDir(), true, fire), watchDir(gateSessionsDir(), false, fire)];
  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
    for (const stop of stops) stop();
  };
}
