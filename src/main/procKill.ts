/**
 * Process-tree termination helpers.
 *
 * A bare node-pty `proc.kill()` is SIGHUP to the DIRECT child only. Two leaks
 * follow: (1) a child that ignores or queues SIGHUP never dies, so its PID
 * lingers for the machine's uptime; (2) even when the child dies, its own
 * children (MCP servers, helper daemons the session started) are orphaned to
 * PID 1 and never released. A cockpit that opens and closes Claude sessions
 * all day accumulates PIDs steadily without this.
 *
 * The fix: the pty child is a session leader (forkpty does setsid), so its
 * process GROUP covers its descendants — after a graceful kill, wait a grace
 * period and then SIGKILL the whole group (POSIX) or `taskkill /T /F` the tree
 * (Windows).
 *
 * Deliberate scope: callers apply this on EXPLICIT kills (closing a session,
 * respawn, app quit) — never on a natural exit, where a daemon the session
 * intentionally left running (a dev server started via a Bash tool) must
 * survive its parent.
 */
import { spawnSync } from "node:child_process";

/** Grace between the polite signal and the SIGKILL escalation. */
export const KILL_GRACE_MS = 4_000;

/** Is the process still alive? Signal 0 probes without touching it. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Forcefully kill pid and its descendants NOW. Group-SIGKILL on POSIX (falls
 *  back to the single pid when the group id is gone); `taskkill /T /F` on
 *  Windows. Killing the group of an already-dead leader is exactly the
 *  orphan-reaping case: any surviving members still hold the group id. */
export function hardKillTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { timeout: 10_000 });
    } catch {
      /* gone */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
}

/** After a graceful kill (node-pty's SIGHUP), make sure the PIDs actually get
 *  released: wait a short grace, then sweep the process tree. Runs even when
 *  the leader died promptly — the sweep is what reaps grandchildren the polite
 *  signal never reached. The timer is unref'd so it can never keep the app
 *  alive during quit. */
export function ensureKilled(pid: number | undefined, graceMs = KILL_GRACE_MS): void {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return;
  const t = setTimeout(() => hardKillTree(pid), graceMs);
  t.unref?.();
}
