import clsx from "clsx";
import { FolderOpen, Pin, Plus, X } from "lucide-react";
import { useState } from "react";

import { Badge, Pill } from "@/components/Badge";
import { Button } from "@/components/Button";
import { RelativeTime } from "@/components/RelativeTime";
import { useProjects, useStore, type Project } from "@/store";

/**
 * Projects: the directories sessions run in.
 *
 * A person works on two or three repositories, each with its own sessions
 * and runs; picking one here narrows the Sessions column to it and makes it
 * the place a new session starts. A project with no session yet is added by
 * path, so a fresh checkout can be started from the same place.
 */
export function Projects() {
  const projects = useProjects();
  const selectedProject = useStore((s) => s.selectedProject);
  const selectProject = useStore((s) => s.selectProject);
  const pinProject = useStore((s) => s.pinProject);
  const removeProject = useStore((s) => s.removeProject);
  const startSession = useStore((s) => s.startSession);
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const dir = path.trim().replace(/\/+$/, "");
    if (!dir.startsWith("/")) {
      setError("an absolute path, like /Users/you/Projects/app");
      return;
    }
    pinProject(dir);
    setPath("");
    setError(null);
    setAdding(false);
  };

  const startHere = async (p: Project) => {
    setError(null);
    const result = await startSession(p.path);
    if (!result.ok) setError(result.error);
  };

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2">
        <FolderOpen size={14} className="text-zinc-400" />
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Projects</span>
        <span className="text-[11px] text-zinc-600">{projects.length}</span>
        {selectedProject && (
          <Button size="sm" className="ml-auto" onClick={() => selectProject(null)} title="Show sessions from every project">
            Show all sessions
          </Button>
        )}
        <Button size="sm" variant="primary" className={selectedProject ? "" : "ml-auto"} onClick={() => setAdding((a) => !a)}>
          <Plus size={12} /> Add project
        </Button>
      </header>
      {adding && (
        <form
          className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-4 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input
            autoFocus
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/path/to/repo"
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
          />
          <Button size="sm" variant="primary" type="submit">
            Add
          </Button>
          <Button size="sm" type="button" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </form>
      )}
      {error && <div className="border-b border-rose-900/50 bg-rose-950/40 px-4 py-1.5 text-[11px] text-rose-300">{error}</div>}
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {projects.length === 0 && (
          <li className="px-4 py-8 text-center text-xs text-zinc-500">No projects yet: start a session, or add a directory above.</li>
        )}
        {projects.map((p) => {
          const selected = p.path === selectedProject;
          return (
            <li
              key={p.path}
              className={clsx("group flex cursor-pointer items-center gap-3 border-b border-zinc-800/70 px-4 py-2.5 hover:bg-zinc-800/40", selected && "bg-zinc-800/70")}
              onClick={() => selectProject(p.path)}
            >
              <FolderOpen size={16} className={clsx("shrink-0", selected ? "text-sky-300" : "text-zinc-500")} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-zinc-100">{p.name}</span>
                  <Badge count={p.attention} tone="attention" />
                  {p.live > 0 && <Pill className="border-emerald-700/50 bg-emerald-900/30 text-emerald-200">{p.live} live</Pill>}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] text-zinc-500">
                  <span className="truncate font-mono" title={p.path}>
                    {p.path}
                  </span>
                  <span className="shrink-0">
                    {p.sessions} session{p.sessions === 1 ? "" : "s"}
                  </span>
                  {p.lastActiveAt > 0 && <RelativeTime at={p.lastActiveAt} className="shrink-0" />}
                </div>
              </div>
              <Button
                size="sm"
                variant="primary"
                className="shrink-0 opacity-0 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  void startHere(p);
                }}
                title={`Start a new session in ${p.path}`}
              >
                <Plus size={12} /> Session
              </Button>
              {!p.pinned && (
                <button
                  type="button"
                  title="Keep in the list even when its sessions are gone"
                  className="shrink-0 rounded p-1 text-zinc-600 opacity-0 hover:bg-zinc-700 hover:text-zinc-200 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    pinProject(p.path);
                  }}
                >
                  <Pin size={12} />
                </button>
              )}
              {/* Every project can be taken off the list; the sessions on disk are untouched, and a new one there brings it back. */}
              <button
                type="button"
                title={p.pinned ? "Remove from the list" : "Remove from the list (its sessions stay; a new session there brings it back)"}
                className="shrink-0 rounded p-1 text-zinc-600 hover:bg-zinc-700 hover:text-rose-300"
                onClick={(e) => {
                  e.stopPropagation();
                  removeProject(p.path);
                }}
              >
                <X size={12} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
