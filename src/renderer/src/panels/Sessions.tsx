import clsx from "clsx";
import { FolderOpen, Moon, Plus, X } from "lucide-react";
import { useState } from "react";

import type { ClaudeSession } from "@shared/types";

import { Badge, Pill } from "@/components/Badge";
import { Button } from "@/components/Button";
import { PtyTerminalView } from "@/components/PtyTerminalView";
import { RelativeTime } from "@/components/RelativeTime";
import { STATUS_CLASS, STATUS_LABEL, runLine, sessionTitle } from "@/lib/format";
import { useStore } from "@/store";

/** The session list column. It stays laid out (invisible) while another section is on screen so the terminals keep their geometry. */
export function SessionsList({ className }: { className?: string }) {
  const sessions = useStore((s) => s.sessions);
  const executions = useStore((s) => s.executions);
  const selectedSessionId = useStore((s) => s.selectedSessionId);
  const selectedPtyId = useStore((s) => s.selectedPtyId);
  const selectSession = useStore((s) => s.selectSession);
  const closeSession = useStore((s) => s.closeSession);
  const pending = useStore((s) => s.pending);
  const selectedProject = useStore((s) => s.selectedProject);
  const selectProject = useStore((s) => s.selectProject);
  const setSection = useStore((s) => s.setSection);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The column shows one project's sessions when one is chosen; every session otherwise.
  const shown = selectedProject ? sessions.filter((s) => s.cwd === selectedProject) : sessions;
  const projectName = selectedProject ? selectedProject.replace(/\/+$/, "").split("/").pop() || selectedProject : null;

  const open = async (session: ClaudeSession) => {
    setError(null);
    const result = await selectSession(session);
    if (result && !result.ok) setError(result.error);
  };

  return (
    <aside className={clsx("flex w-72 shrink-0 flex-col border-r border-zinc-800 bg-[var(--surface-1)]", className)}>
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Sessions</span>
        <Button size="sm" variant="primary" className="ml-auto" onClick={() => setCreating((c) => !c)} title={selectedProject ? `New session in ${selectedProject}` : "New session"}>
          <Plus size={12} /> New
        </Button>
      </div>
      {/* Which project this column is narrowed to, and the way out of it. */}
      <div className="flex items-center gap-1.5 border-b border-zinc-800 bg-zinc-900/40 px-3 py-1.5 text-[11px]">
        <FolderOpen size={11} className="shrink-0 text-zinc-500" />
        {projectName ? (
          <>
            <button type="button" className="truncate font-medium text-sky-300 hover:underline" title={selectedProject ?? undefined} onClick={() => setSection("projects")}>
              {projectName}
            </button>
            <button type="button" className="ml-auto shrink-0 text-zinc-500 hover:text-zinc-200" onClick={() => selectProject(null)} title="Show sessions from every project">
              all
            </button>
          </>
        ) : (
          <>
            <span className="text-zinc-500">all projects</span>
            <button type="button" className="ml-auto shrink-0 text-zinc-500 hover:text-zinc-200" onClick={() => setSection("projects")}>
              choose
            </button>
          </>
        )}
      </div>
      {creating && <NewSessionForm onDone={() => setCreating(false)} />}
      {error && <div className="border-b border-rose-900/50 bg-rose-950/40 px-3 py-1.5 text-[11px] text-rose-300">{error}</div>}
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 && (
          <li className="px-3 py-6 text-center text-xs text-zinc-500">
            {selectedProject ? "No sessions in this project yet. Start one above." : "No sessions yet. Start one above."}
          </li>
        )}
        {shown.map((s) => {
          const selected = s.id === selectedSessionId || (s.ptyId !== null && s.ptyId === selectedPtyId);
          const execution = s.run ? executions.find((e) => e.id === s.run?.executionId) : null;
          const waitingOnYou = pending.filter((p) => p.sessionId === s.id).length;
          return (
            <li
              key={s.id}
              className={clsx(
                "group cursor-pointer border-b border-zinc-800/70 px-3 py-2 hover:bg-zinc-800/40",
                selected && "bg-zinc-800/70",
                s.presence === "asleep" && "opacity-70",
              )}
              onClick={() => void open(s)}
            >
              <div className="flex items-center gap-1.5">
                {s.presence === "asleep" && <Moon size={11} className="shrink-0 text-zinc-500" />}
                <span className="truncate text-xs font-medium text-zinc-100" title={s.title ?? s.cwd}>
                  {sessionTitle(s)}
                </span>
                <Pill className={clsx("ml-auto shrink-0", STATUS_CLASS[s.status])}>{STATUS_LABEL[s.status]}</Pill>
                <Badge count={waitingOnYou} className="shrink-0" />
                {s.presence === "live" && s.ptyId && (
                  <button
                    type="button"
                    title="Close terminal"
                    onClick={(e) => {
                      e.stopPropagation();
                      void closeSession(s.ptyId as string);
                    }}
                    className="ml-0.5 shrink-0 rounded p-0.5 text-zinc-600 opacity-0 hover:bg-zinc-700 hover:text-zinc-200 group-hover:opacity-100"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
              {s.run && (
                <div className={clsx("mt-0.5 truncate text-[11px]", s.run.asks ? "text-amber-300" : "text-zinc-400")} title={runLine(s.run, execution)}>
                  {runLine(s.run, execution)}
                </div>
              )}
              <div className="mt-0.5 flex items-center gap-2 text-[10px] text-zinc-500">
                <span className="truncate" title={s.cwd}>
                  {s.cwd}
                </span>
                <RelativeTime at={s.lastActiveAt} className="ml-auto shrink-0" />
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function NewSessionForm({ onDone }: { onDone: () => void }) {
  const lastCwd = useStore((s) => s.lastCwd);
  const selectedProject = useStore((s) => s.selectedProject);
  const startSession = useStore((s) => s.startSession);
  // The chosen project is where a new session goes; the field stays editable for the odd exception.
  const [cwd, setCwd] = useState(selectedProject ?? lastCwd);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    const dir = cwd.trim();
    if (!dir || busy) return;
    setBusy(true);
    setError(null);
    const result = await startSession(dir, prompt.trim() || undefined);
    setBusy(false);
    if (result.ok) onDone();
    else setError(result.error);
  };

  return (
    <form
      className="flex flex-col gap-1.5 border-b border-zinc-800 bg-zinc-900/60 px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <label className="text-[10px] uppercase tracking-wide text-zinc-500">Directory</label>
      <input
        autoFocus
        value={cwd}
        onChange={(e) => setCwd(e.target.value)}
        placeholder="/path/to/repo"
        spellCheck={false}
        className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
      />
      <label className="text-[10px] uppercase tracking-wide text-zinc-500">First prompt (optional)</label>
      <input
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder='/gate:run dev "..."'
        className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
      />
      {error && <div className="text-[11px] text-rose-400">{error}</div>}
      <div className="flex gap-1.5">
        <Button size="sm" variant="primary" type="submit" disabled={busy || !cwd.trim()}>
          {busy ? "Starting…" : "Start"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Every live terminal, mounted once; only the selected one is visible and active. */
export function TerminalStage() {
  const sessions = useStore((s) => s.sessions);
  const selectedPtyId = useStore((s) => s.selectedPtyId);
  const selectedSessionId = useStore((s) => s.selectedSessionId);
  const onStage = useStore((s) => s.section === "sessions");

  const ptyIds: string[] = [];
  for (const s of sessions) if (s.presence === "live" && s.ptyId && !ptyIds.includes(s.ptyId)) ptyIds.push(s.ptyId);
  // A terminal just started has a pty before the session list knows a session for it.
  if (selectedPtyId && !ptyIds.includes(selectedPtyId)) ptyIds.push(selectedPtyId);

  const selected = sessions.find((s) => s.id === selectedSessionId) ?? null;
  const showing = selectedPtyId !== null;

  return (
    <div className="relative h-full w-full bg-[var(--terminal-bg)]">
      {ptyIds.map((ptyId) => {
        const shown = ptyId === selectedPtyId;
        const active = shown && onStage;
        return (
          <div key={ptyId} className={clsx("absolute inset-0", !shown && "invisible pointer-events-none")} aria-hidden={!shown}>
            <PtyTerminalView ptyId={ptyId} active={active} />
          </div>
        );
      })}
      {!showing && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-xs text-zinc-500">
          {selected && selected.presence === "asleep"
            ? "This session is asleep. Click it again to resume it here."
            : sessions.length
              ? "Pick a session on the left to see its terminal."
              : "No terminal open. Start a session to get one."}
        </div>
      )}
    </div>
  );
}
