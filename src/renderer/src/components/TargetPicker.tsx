import clsx from "clsx";
import { Cloud, Laptop } from "lucide-react";
import { useEffect, useState } from "react";

import type { RunTarget, SessionLocation } from "@shared/types";

import { remoteBlockReason, remoteUsable, useStore } from "@/store";

/**
 * Where a new session or run goes: this machine, or the gate server.
 *
 * On this machine nothing changes — `claude` starts in the project's
 * directory. On the gate server it starts in one of the gate's connected
 * repositories, which is picked for the person when the project's `origin`
 * matches one, and chosen from the list when it does not. The choice of
 * machine is remembered for next time; the repository follows the project.
 */

export interface TargetChoice {
  location: SessionLocation;
  /** The connected repository, when the server is chosen; "" until one is. */
  repo: string;
}

/** The choice as a form's state: follows the saved preference, and re-matches the repository when the project changes. */
export function useTargetChoice(cwd: string): [TargetChoice, (next: TargetChoice) => void] {
  const runTarget = useStore((s) => s.runTarget);
  const remote = useStore((s) => s.remote);
  const loadRemote = useStore((s) => s.loadRemote);
  const setRunTarget = useStore((s) => s.setRunTarget);
  const [choice, setChoice] = useState<TargetChoice>({ location: runTarget, repo: "" });

  useEffect(() => {
    void loadRemote();
  }, [loadRemote]);

  // The saved preference is only a default: a key that cannot use the server starts here.
  const usable = remoteUsable(remote);
  useEffect(() => {
    if (remote && !usable && choice.location === "remote") setChoice((c) => ({ ...c, location: "local" }));
  }, [remote, usable, choice.location]);

  const dir = cwd.trim();
  useEffect(() => {
    if (choice.location !== "remote" || !dir) return;
    let cancelled = false;
    window.cockpit.remote
      .match(dir)
      .then((m) => {
        if (!cancelled && m.repo) setChoice((c) => ({ ...c, repo: m.repo as string }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [dir, choice.location]);

  const update = (next: TargetChoice) => {
    if (next.location !== choice.location) setRunTarget(next.location);
    setChoice(next);
  };
  return [choice, update];
}

/** The choice as a start call wants it, or the reason it cannot be started yet. */
export function targetOf(choice: TargetChoice): RunTarget | { error: string } {
  if (choice.location === "local") return { location: "local" };
  if (!choice.repo) return { error: "pick the gate repository the session should run in" };
  return { location: "remote", repo: choice.repo };
}

export function TargetPicker({ choice, onChange }: { choice: TargetChoice; onChange: (next: TargetChoice) => void }) {
  const remote = useStore((s) => s.remote);
  const blocked = remoteBlockReason(remote);
  const repos = remote?.repos ?? [];
  const field =
    "rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-100 focus:border-sky-500 focus:outline-none";

  const option = (location: SessionLocation, label: string, Icon: typeof Laptop, disabled: string | null) => (
    <button
      type="button"
      disabled={!!disabled}
      title={disabled ?? undefined}
      onClick={() => onChange({ ...choice, location })}
      className={clsx(
        "flex flex-1 items-center justify-center gap-1 px-2 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-40",
        choice.location === location ? "bg-zinc-700 text-zinc-50" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200",
      )}
    >
      <Icon size={11} /> {label}
    </button>
  );

  return (
    <>
      <label className="text-[10px] uppercase tracking-wide text-zinc-500">Runs on</label>
      <div className="flex overflow-hidden rounded border border-zinc-700 bg-zinc-950">
        {option("local", "This machine", Laptop, null)}
        {option("remote", "Gate server", Cloud, blocked)}
      </div>
      {choice.location === "remote" && (
        <select
          value={choice.repo}
          onChange={(e) => onChange({ ...choice, repo: e.target.value })}
          className={field}
          title="The gate's checkout the session starts in; a run still gets its own worktree"
        >
          <option value="">choose a gate repository…</option>
          {repos.map((r) => (
            <option key={r.id} value={r.id} disabled={r.status !== "ready"}>
              {r.name} — {r.source}
              {r.status !== "ready" ? ` (${r.status})` : ""}
            </option>
          ))}
        </select>
      )}
    </>
  );
}
