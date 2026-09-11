import type { ClaudeSession, Execution, Pending, RunPointer, SessionStatus } from "@shared/types";

/** "just now", "4m", "2h", "3d" — short enough for a list row. */
export function relativeTime(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const s = Math.round(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d`;
  return new Date(ms).toLocaleDateString();
}

export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1) || trimmed;
}

export function sessionTitle(session: Pick<ClaudeSession, "title" | "cwd">): string {
  const t = session.title?.trim();
  return t && t.length > 0 ? t : basename(session.cwd) || session.cwd;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export const STATUS_LABEL: Record<SessionStatus, string> = {
  working: "working",
  idle: "idle",
  waiting: "waiting",
  blocked: "blocked",
  exited: "exited",
};

/** Tailwind classes for the status pill. */
export const STATUS_CLASS: Record<SessionStatus, string> = {
  working: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  idle: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
  waiting: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  blocked: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  exited: "bg-zinc-700/30 text-zinc-500 border-zinc-700/40",
};

function runPhrase(run: RunPointer): string {
  if (run.asks === "approval") return "waiting for your approval";
  if (run.asks === "question") return "waiting for your answer";
  switch (run.state) {
    case "agent":
      return run.agent ? `running ${run.agent}` : "running";
    case "wait":
      return "waiting";
    case "delegate":
      return "delegating";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
  }
}

/** "dev · plan-review · waiting for your approval". The workflow id comes from the execution when we know it. */
export function runLine(run: RunPointer, execution?: Execution | null): string {
  const workflow = execution?.workflowId ?? shortId(run.executionId);
  const parts = [workflow];
  if (run.nodeId) parts.push(run.nodeId);
  parts.push(runPhrase(run));
  return parts.join(" · ");
}

export function shortId(id: string): string {
  return id.length > 10 ? id.slice(0, 8) : id;
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function isQuestion(p: Pending): boolean {
  return p.kind === "question";
}

export function isApprovalLike(p: Pending): boolean {
  return p.kind === "approval" || p.kind === "permission";
}

export function durationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  if (m < 60) return `${m}m ${rest}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
