import type { Execution } from "./types";

/**
 * Where a finished run's branch went, read off the execution.
 *
 * gate publishes the branch as the worktree is released, after the run itself
 * has been reported done, and records the outcome on the execution: the ref
 * and commit pushed, or the error. A run whose repository publishes nowhere,
 * or one on a gate older than 0.37.0, has neither, and that is `null` here —
 * nothing to say, rather than "not published".
 */
export type Publication = { kind: "published"; ref: string; commit: string; at: number | null } | { kind: "failed"; error: string };

export function publicationOf(execution: Pick<Execution, "publishedRef" | "publishedCommit" | "publishedAt" | "publishError">): Publication | null {
  if (execution.publishedRef && execution.publishedCommit) {
    return {
      kind: "published",
      ref: execution.publishedRef,
      commit: execution.publishedCommit,
      at: typeof execution.publishedAt === "number" ? execution.publishedAt : null,
    };
  }
  if (execution.publishError) return { kind: "failed", error: execution.publishError };
  return null;
}

/** The seven characters of a commit people quote. */
export function shortCommit(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

/**
 * A weekly window one model family reads (`seven_day_fable`), as opposed to
 * the account-wide `five_hour` and `seven_day`. gate's floor reads only the
 * account-wide ones, so a model window under the floor holds nothing back —
 * that model is out on that account until it resets, and the login serves
 * everything else.
 */
export function isModelScopedWindow(name: string): boolean {
  return name.startsWith("seven_day_");
}
