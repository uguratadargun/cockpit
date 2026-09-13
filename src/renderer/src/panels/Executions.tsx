import { BaseEdge, Background, EdgeLabelRenderer, getBezierPath, getSmoothStepPath, Handle, MarkerType, Panel, Position, ReactFlow, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import clsx from "clsx";
import { ArrowRightLeft, ChevronDown, ChevronRight, FileMinus, FilePen, FilePlus, GitCompare, Pause, Play, RefreshCw, Square, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ChangedFile, Execution, WorkflowEvent } from "@shared/types";

import { Pill } from "@/components/Badge";
import { Button } from "@/components/Button";
import { RelativeTime } from "@/components/RelativeTime";
import { TargetPicker, targetOf, useTargetChoice } from "@/components/TargetPicker";
import { clockTime, durationMs, shortId } from "@/lib/format";
import { NODE_H, NODE_W, backEdges, deriveRunView, edgeId, edgeKey, layoutGraph, nodeState, skipEdges, type NodeState } from "@/lib/graph";
import { Empty } from "@/panels/Questions";
import { useExecutionById, useProjects, useStore } from "@/store";

const STATUS_PILL: Record<Execution["status"], string> = {
  running: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  completed: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  failed: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

export function Executions() {
  const executions = useStore((s) => s.executions);
  const selectedId = useStore((s) => s.selectedExecutionId);
  const selectExecution = useStore((s) => s.selectExecution);
  const [starting, setStarting] = useState(false);

  return (
    <section className="flex h-full min-w-0 flex-1">
      <aside className="flex w-80 shrink-0 flex-col border-r border-zinc-800 bg-[var(--surface-1)]">
        <header className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
          <Workflow size={14} className="text-zinc-400" />
          <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Executions</span>
          <span className="text-[11px] text-zinc-600">{executions.length}</span>
          <Button size="sm" variant="primary" className="ml-auto" onClick={() => setStarting((v) => !v)} title="Start a run">
            <Play size={12} /> New run
          </Button>
        </header>
        {starting && <NewRunForm onDone={() => setStarting(false)} />}
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {executions.length === 0 && <li className="px-3 py-6 text-center text-xs text-zinc-500">No runs for you yet.</li>}
          {executions.map((e) => {
            const paused = e.status === "running" && e.pausedAt !== null;
            return (
              <li
                key={e.id}
                onClick={() => selectExecution(e.id)}
                className={clsx("cursor-pointer border-b border-zinc-800/70 px-3 py-2 hover:bg-zinc-800/40", e.id === selectedId && "bg-zinc-800/70")}
              >
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-medium text-zinc-100">{e.workflowId}</span>
                  <Pill className={clsx("ml-auto shrink-0", paused ? "border-amber-500/30 bg-amber-500/15 text-amber-300" : STATUS_PILL[e.status])}>
                    {paused ? "waiting for you" : e.status}
                  </Pill>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] text-zinc-500">
                  <span className="font-mono">{shortId(e.id)}</span>
                  {e.client?.repo && <span className="truncate">{e.client.repo}{e.client.branch ? `@${e.client.branch}` : ""}</span>}
                  <RelativeTime at={e.startedAt} className="ml-auto shrink-0" />
                </div>
              </li>
            );
          })}
        </ul>
      </aside>
      <ExecutionDetail id={selectedId} />
    </section>
  );
}

function ExecutionDetail({ id }: { id: string | null }) {
  const execution = useExecutionById(id);
  const events = useStore((s) => (id ? s.events[id] : undefined));
  const graph = useStore((s) => (execution ? s.graphs[execution.workflowId] : undefined));
  const graphError = useStore((s) => (execution ? s.graphErrors[execution.workflowId] : undefined));
  const loadGraph = useStore((s) => s.loadGraph);
  const cancelExecution = useStore((s) => s.cancelExecution);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  useEffect(() => {
    if (execution && !graph && !graphError) void loadGraph(execution.workflowId);
  }, [execution, graph, graphError, loadGraph]);

  if (!id || !execution) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center">
        <Empty text="Select a run to see where it is." />
      </div>
    );
  }

  const stop = async () => {
    if (!window.confirm(`Stop ${execution.workflowId} (${shortId(execution.id)})? The run cannot be resumed.`)) return;
    setStopping(true);
    setStopError(null);
    const result = await cancelExecution(execution.id);
    setStopping(false);
    if (!result.ok) setStopError(result.error);
  };

  const paused = execution.status === "running" && execution.pausedAt !== null;
  const end = execution.finishedAt ?? Date.now();
  const list = events ?? [];

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-800 px-4 py-2">
        <span className="text-sm font-semibold text-zinc-100">{execution.workflowId}</span>
        <span className="font-mono text-[11px] text-zinc-500">{execution.id}</span>
        <Pill className={clsx(paused ? "border-amber-500/30 bg-amber-500/15 text-amber-300" : STATUS_PILL[execution.status])}>
          {paused ? (
            <>
              <Pause size={10} className="mr-1" /> waiting for you
            </>
          ) : (
            execution.status
          )}
        </Pill>
        <span className="text-[11px] text-zinc-500">
          started <RelativeTime at={execution.startedAt} /> · {durationMs(end - execution.startedAt)}
          {execution.stepCount ? ` · ${execution.stepCount} steps` : ""}
        </span>
        {execution.error && (
          <span className="truncate text-[11px] text-rose-400" title={execution.error.message}>
            {execution.error.code}: {execution.error.message}
          </span>
        )}
        {execution.status === "running" && (
          <Button variant="danger" size="sm" className="ml-auto" disabled={stopping} onClick={() => void stop()}>
            <Square size={10} /> {stopping ? "Stopping…" : "Stop"}
          </Button>
        )}
        {stopError && <span className="text-[11px] text-rose-400">{stopError}</span>}
      </header>

      <ChangedFiles executionId={execution.id} />

      <div className="relative min-h-0 flex-1">
        {graph ? (
          <Graph key={execution.id} graphId={execution.workflowId} events={list} />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-zinc-500">{graphError ? `Cannot draw ${execution.workflowId}: ${graphError}` : "Loading workflow…"}</div>
        )}
      </div>

      <EventLog events={list} />
    </div>
  );
}

// ----------------------------------------------------------------- changes

const STATUS_ICON: Record<ChangedFile["status"], typeof FilePlus> = {
  added: FilePlus,
  modified: FilePen,
  deleted: FileMinus,
  renamed: ArrowRightLeft,
};
const STATUS_COLOR: Record<ChangedFile["status"], string> = {
  added: "text-emerald-400",
  modified: "text-amber-400",
  deleted: "text-rose-400",
  renamed: "text-violet-400",
};

/**
 * What `git status`/`git diff` say about the run's working directory, styled
 * like GitLab's changed-files list: a row per file with its +/- counts, each
 * expandable to the file's own diff. This is not gate's data — the run's
 * session may have moved on (or the repo may have been cleaned up) since.
 */
function ChangedFiles({ executionId }: { executionId: string }) {
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    window.cockpit.executions.changedFiles(executionId).then((r) => {
      setLoading(false);
      if (r.ok) setFiles(r.value);
      else setError(r.error);
    });
  };

  useEffect(() => {
    setFiles(null);
    setError(null);
    setLoading(true);
    let cancelled = false;
    window.cockpit.executions.changedFiles(executionId).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (r.ok) setFiles(r.value);
      else setError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [executionId]);

  const totals = useMemo(() => {
    if (!files) return null;
    return files.reduce((acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }), { add: 0, del: 0 });
  }, [files]);

  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <div className="shrink-0 border-b border-zinc-800 px-4 py-1.5">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-zinc-400 hover:text-zinc-200"
          aria-expanded={open}
        >
          <Icon size={12} />
          <GitCompare size={12} />
          Changed files
        </button>
        {files && <span className="text-[11px] text-zinc-500">{files.length === 0 ? "none" : `${files.length} file${files.length === 1 ? "" : "s"}`}</span>}
        {totals && (totals.add > 0 || totals.del > 0) && (
          <span className="font-mono text-[10px]">
            <span className="text-emerald-400">+{totals.add}</span> <span className="text-rose-400">-{totals.del}</span>
          </span>
        )}
        <button type="button" onClick={load} disabled={loading} title="Refresh" className="ml-auto text-zinc-500 hover:text-zinc-300 disabled:opacity-50">
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      {open && (
        <div className="mt-1.5 max-h-60 overflow-y-auto rounded border border-zinc-800">
          {error && <div className="px-2 py-1.5 text-[11px] text-rose-400">{error}</div>}
          {!error && !files && <div className="px-2 py-1.5 text-[11px] text-zinc-500">Loading…</div>}
          {files && files.length === 0 && <div className="px-2 py-1.5 text-[11px] text-zinc-500">No changes in this run's working directory.</div>}
          {files?.map((f) => <ChangedFileRow key={`${f.oldPath ?? ""}->${f.path}`} executionId={executionId} file={f} />)}
        </div>
      )}
    </div>
  );
}

function ChangedFileRow({ executionId, file }: { executionId: string; file: ChangedFile }) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const StatusIcon = STATUS_ICON[file.status];
  const Chevron = open ? ChevronDown : ChevronRight;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && diff === null && !error && !file.binary) {
      window.cockpit.executions.fileDiff(executionId, file).then((r) => {
        if (r.ok) setDiff(r.value);
        else setError(r.error);
      });
    }
  };

  return (
    <div className="border-b border-zinc-800/70 last:border-b-0">
      <button type="button" onClick={toggle} className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-zinc-800/40" aria-expanded={open}>
        <Chevron size={11} className="shrink-0 text-zinc-500" />
        <StatusIcon size={12} className={clsx("shrink-0", STATUS_COLOR[file.status])} />
        <span className="truncate font-mono text-[11px] text-zinc-200" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          {file.oldPath ? (
            <>
              <span className="text-zinc-500 line-through">{file.oldPath}</span> → {file.path}
            </>
          ) : (
            file.path
          )}
        </span>
        {file.binary ? (
          <span className="ml-auto shrink-0 text-[10px] text-zinc-500">binary</span>
        ) : (
          <span className="ml-auto shrink-0 font-mono text-[10px]">
            {file.additions > 0 && <span className="text-emerald-400">+{file.additions}</span>} {file.deletions > 0 && <span className="text-rose-400">-{file.deletions}</span>}
          </span>
        )}
      </button>
      {open && !file.binary && (
        <div className="border-t border-zinc-800/70">
          {error && <div className="px-2 py-1.5 text-[11px] text-rose-400">{error}</div>}
          {!error && diff === null && <div className="px-2 py-1.5 text-[11px] text-zinc-500">Loading…</div>}
          {diff !== null && <DiffView diff={diff} />}
        </div>
      )}
    </div>
  );
}

/** A unified diff's hunks, each line coloured by its `+`/`-`/context leader — GitLab's inline diff, without the split view. */
function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n").filter((_, i, arr) => i < arr.length - 1 || arr[i] !== "");
  const body = lines.filter((l) => !l.startsWith("diff --git") && !l.startsWith("index ") && !l.startsWith("--- ") && !l.startsWith("+++ "));
  if (body.length === 0) return <div className="px-2 py-1.5 text-[11px] text-zinc-500">No textual changes.</div>;
  return (
    <pre className="max-h-72 overflow-auto bg-zinc-950 py-1 font-mono text-[11px] leading-relaxed">
      {body.map((line, i) => {
        const tone = line.startsWith("@@") ? "text-sky-400" : line.startsWith("+") ? "text-emerald-300 bg-emerald-500/10" : line.startsWith("-") ? "text-rose-300 bg-rose-500/10" : "text-zinc-400";
        return (
          <div key={i} className={clsx("whitespace-pre px-2", tone)}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

// ----------------------------------------------------------------- new run

/**
 * A run starts the way it does in a terminal: a fresh session in the
 * project, with `/gate:run <workflow> <task>` typed as its first prompt.
 * The session then does what /gate:run does — settles the brief, asks what
 * it must (in Questions), calls `begin` — and the run appears here on its
 * own once it has. The form only spares the person the typing.
 */
function NewRunForm({ onDone }: { onDone: () => void }) {
  const projects = useProjects();
  const selectedProject = useStore((s) => s.selectedProject);
  const lastCwd = useStore((s) => s.lastCwd);
  const workflows = useStore((s) => s.workflows);
  const workflowsError = useStore((s) => s.workflowsError);
  const loadWorkflows = useStore((s) => s.loadWorkflows);
  const startRun = useStore((s) => s.startRun);
  const [cwd, setCwd] = useState(selectedProject ?? lastCwd ?? projects[0]?.path ?? "");
  const [workflowId, setWorkflowId] = useState("");
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useTargetChoice(cwd);

  useEffect(() => {
    if (!workflows.length) void loadWorkflows();
  }, [workflows.length, loadWorkflows]);
  useEffect(() => {
    if (!workflowId && workflows.length) setWorkflowId(workflows.find((w) => w.id === "dev")?.id ?? workflows[0].id);
  }, [workflows, workflowId]);

  const chosen = workflows.find((w) => w.id === workflowId) ?? null;
  const needsTask = chosen ? chosen.inputs.includes("task") : true;
  const known = projects.some((p) => p.path === cwd);

  const start = async () => {
    const dir = cwd.trim();
    if (!dir || !workflowId || busy) return;
    if (needsTask && !task.trim()) {
      setError("say what the run should do");
      return;
    }
    const target = targetOf(choice);
    if ("error" in target) {
      setError(target.error);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await startRun(dir, workflowId, task, target);
    setBusy(false);
    if (result.ok) onDone();
    else setError(result.error);
  };

  const field = "rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none";

  return (
    <form
      className="flex flex-col gap-1.5 border-b border-zinc-800 bg-zinc-900/60 px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <label className="text-[10px] uppercase tracking-wide text-zinc-500">Project</label>
      {projects.length > 0 && (
        <select value={known ? cwd : "__other"} onChange={(e) => setCwd(e.target.value === "__other" ? "" : e.target.value)} className={field}>
          {projects.map((p) => (
            <option key={p.path} value={p.path}>
              {p.name} — {p.path}
            </option>
          ))}
          <option value="__other">another directory…</option>
        </select>
      )}
      {(!known || projects.length === 0) && (
        <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/repo" spellCheck={false} className={clsx(field, "font-mono")} />
      )}
      <TargetPicker choice={choice} onChange={setChoice} />
      <label className="text-[10px] uppercase tracking-wide text-zinc-500">Workflow</label>
      {workflowsError ? (
        <div className="text-[11px] text-rose-400">{workflowsError}</div>
      ) : (
        <select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} className={field}>
          {workflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} ({w.id})
            </option>
          ))}
        </select>
      )}
      {chosen?.description && <div className="text-[10px] leading-snug text-zinc-500">{chosen.description}</div>}
      <label className="text-[10px] uppercase tracking-wide text-zinc-500">Task</label>
      <textarea
        autoFocus
        value={task}
        onChange={(e) => setTask(e.target.value)}
        rows={3}
        placeholder={needsTask ? "what should change, in a sentence or two" : "optional"}
        className={clsx(field, "resize-y")}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void start();
        }}
      />
      {error && <div className="text-[11px] text-rose-400">{error}</div>}
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="primary" type="submit" disabled={busy || !workflowId || !cwd.trim()}>
          {busy ? "Starting…" : "Start run"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <span className="ml-auto text-[10px] text-zinc-600">⌘↵ starts</span>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------- graph

interface WfData extends Record<string, unknown> {
  label: string;
  type: string;
  agent?: string;
  state: NodeState;
  entry: boolean;
  terminal: boolean;
  loopIn: boolean;
  loopOut: boolean;
  skipIn: boolean;
  skipOut: boolean;
}
type WfNode = Node<WfData, "wf">;

const LOOP_COLOR = "#f59e0b";
const SKIP_COLOR = "#94a3b8";
const TAKEN_COLOR = "#7dd3fc";
const IDLE_COLOR = "var(--color-zinc-600)";

/** A card's colour is its kind, the same hues the dashboard uses: what a node *is* reads at a glance. */
const KIND_CLASS: Record<string, string> = {
  agent: "border-sky-500/50 bg-sky-500/10",
  command: "border-amber-500/50 bg-amber-500/10",
  condition: "border-violet-500/50 bg-violet-500/10",
  terminal: "border-emerald-500/50 bg-emerald-500/10",
  parallel: "border-fuchsia-500/50 bg-fuchsia-500/10",
};
const KIND_FALLBACK = "border-zinc-700 bg-zinc-900";

/** The dashboard's flat colours for the legend and the minimap. */
const KIND_COLOR: Record<string, string> = {
  agent: "#0ea5e9",
  command: "#f59e0b",
  condition: "#8b5cf6",
  terminal: "#10b981",
  parallel: "#d946ef",
};

/** What the run did to the card: a ring, as on the dashboard, so the kind's colour stays underneath. */
const STATE_CLASS: Record<NodeState, string> = {
  idle: "text-zinc-300",
  running: "text-zinc-50 ring-2 ring-amber-500 animate-pulse",
  paused: "text-amber-50 ring-2 ring-amber-400 shadow-[0_0_0_4px_rgba(251,191,36,0.2)]",
  completed: "text-zinc-100 ring-2 ring-emerald-500",
  failed: "text-rose-50 ring-2 ring-rose-500",
};

const handleClass = "!h-2 !w-2 !border-0";

/**
 * A card with four kinds of handle: in on the left, out on the right, and —
 * only where an edge of that kind exists — a pair under the card for return
 * paths and a pair over it for shortcuts, so neither crosses the forward flow.
 */
function WfNodeView({ data }: NodeProps<WfNode>) {
  return (
    <div
      className={clsx("flex flex-col justify-center rounded-md border px-2.5 py-1.5 text-xs shadow-sm", KIND_CLASS[data.type] ?? KIND_FALLBACK, STATE_CLASS[data.state])}
      style={{ width: NODE_W, height: NODE_H }}
    >
      <Handle id="in" type="target" position={Position.Left} className={clsx(handleClass, "!bg-zinc-600")} />
      {data.loopIn && <Handle id="loop-in" type="target" position={Position.Bottom} style={{ left: "32%", background: LOOP_COLOR }} className={handleClass} />}
      {data.loopOut && <Handle id="loop-out" type="source" position={Position.Bottom} style={{ left: "68%", background: LOOP_COLOR }} className={handleClass} />}
      {data.skipIn && <Handle id="skip-in" type="target" position={Position.Top} style={{ left: "32%", background: SKIP_COLOR }} className={handleClass} />}
      {data.skipOut && <Handle id="skip-out" type="source" position={Position.Top} style={{ left: "68%", background: SKIP_COLOR }} className={handleClass} />}
      <div className="flex items-center gap-1.5">
        <span className="truncate font-medium">{data.label}</span>
        {data.state === "running" && <span className="ml-auto h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-sky-400" />}
      </div>
      <div className="flex items-center gap-1.5 truncate text-[10px] text-zinc-400">
        <span className="uppercase tracking-wide">{data.type}</span>
        {data.state === "paused" ? <span className="text-amber-300">waiting for you</span> : data.agent && <span className="truncate font-mono">{data.agent}</span>}
      </div>
      {!data.terminal && <Handle id="out" type="source" position={Position.Right} className={clsx(handleClass, "!bg-zinc-600")} />}
    </div>
  );
}

const nodeTypes = { wf: WfNodeView };

interface WfEdgeData extends Record<string, unknown> {
  lane: "forward" | "loop" | "skip";
  offset: number;
}

/** Forward edges curve; return paths and shortcuts step around the cards at their lane's offset. */
function WfEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label, markerEnd, style, data }: EdgeProps) {
  const d = data as WfEdgeData | undefined;
  const geometry = { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition };
  const [path, labelX, labelY] =
    d && d.lane !== "forward" ? getSmoothStepPath({ ...geometry, borderRadius: 10, offset: d.offset }) : getBezierPath(geometry);
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {label && (
        <EdgeLabelRenderer>
          {/* A forward edge's midpoint is the gap between two cards, so its
              label sits above the line and is cut to what fits there; a
              lane's label has the whole stretch under or over the cards.
              The full text is the tooltip. */}
          <div
            style={{
              transform:
                d && d.lane !== "forward"
                  ? `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`
                  : `translate(-50%, -100%) translate(${labelX}px, ${labelY - 3}px)`,
            }}
            title={typeof label === "string" ? label : undefined}
            className={clsx(
              "pointer-events-auto absolute truncate rounded bg-[var(--surface-0)]/90 px-1 py-0.5 text-[10px] text-zinc-400",
              d && d.lane !== "forward" ? "max-w-[240px]" : "max-w-[104px]",
            )}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { wf: WfEdgeView };

function Graph({ graphId, events }: { graphId: string; events: WorkflowEvent[] }) {
  const graph = useStore((s) => s.graphs[graphId]);
  const theme = useStore((s) => s.theme);
  const view = useMemo(() => deriveRunView(events), [events]);
  const placed = useMemo(() => (graph ? layoutGraph(graph) : []), [graph]);
  const loops = useMemo(() => (graph ? backEdges(graph) : new Set<string>()), [graph]);
  const skips = useMemo(() => (graph ? skipEdges(graph, placed, loops) : new Set<string>()), [graph, placed, loops]);

  const nodes = useMemo<WfNode[]>(() => {
    if (!graph) return [];
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const has = (set: Set<string>, id: string, side: "from" | "to") =>
      [...set].some((k) => (side === "from" ? k.startsWith(`${id}->`) : k.endsWith(`->${id}`)));
    return placed.map((p) => {
      const n = byId.get(p.id)!;
      return {
        id: n.id,
        type: "wf",
        position: { x: p.x, y: p.y },
        draggable: false,
        connectable: false,
        selectable: false,
        data: {
          label: n.label ?? n.id,
          type: n.type,
          agent: n.agent,
          state: nodeState(n.id, view),
          entry: n.id === graph.entry,
          terminal: n.type === "terminal",
          loopOut: has(loops, n.id, "from"),
          loopIn: has(loops, n.id, "to"),
          skipOut: has(skips, n.id, "from"),
          skipIn: has(skips, n.id, "to"),
        },
      };
    });
  }, [graph, placed, view, loops, skips]);

  const edges = useMemo<Edge[]>(() => {
    if (!graph) return [];
    const pos = new Map(placed.map((p) => [p.id, p]));
    const lowest = placed.reduce((y, p) => Math.max(y, p.y + NODE_H), Number.NEGATIVE_INFINITY);
    const highest = placed.reduce((y, p) => Math.min(y, p.y), Number.POSITIVE_INFINITY);
    // One lane per return path and per shortcut, so two into the same card stay apart.
    const loopLane = new Map<string, number>();
    const skipLane = new Map<string, number>();
    for (const e of graph.edges) {
      const key = edgeId(e.from, e.to);
      if (loops.has(key) && !loopLane.has(key)) loopLane.set(key, loopLane.size);
      else if (skips.has(key) && !skipLane.has(key)) skipLane.set(key, skipLane.size);
    }
    return graph.edges.map((e, i) => {
      const key = edgeId(e.from, e.to);
      const taken = view.taken.has(edgeKey(e.from, e.to));
      const lane: WfEdgeData["lane"] = loops.has(key) ? "loop" : skips.has(key) ? "skip" : "forward";
      const from = pos.get(e.from);
      const to = pos.get(e.to);
      let offset = 0;
      if (lane === "loop" && to) {
        // The horizontal stretch runs `offset` below the target's bottom edge:
        // measured from the lowest card, so it passes under every column between.
        offset = Math.max(26, lowest - (to.y + NODE_H) + 30 + 20 * (loopLane.get(key) ?? 0));
      } else if (lane === "skip" && from && to) {
        offset = Math.max(26, Math.min(from.y, to.y) - highest + 30 + 20 * (skipLane.get(key) ?? 0));
      }
      const color = taken ? TAKEN_COLOR : lane === "loop" ? LOOP_COLOR : lane === "skip" ? SKIP_COLOR : IDLE_COLOR;
      return {
        id: `${e.from}-${e.to}-${i}`,
        source: e.from,
        target: e.to,
        sourceHandle: lane === "loop" ? "loop-out" : lane === "skip" ? "skip-out" : "out",
        targetHandle: lane === "loop" ? "loop-in" : lane === "skip" ? "skip-in" : "in",
        label: e.label,
        type: "wf",
        data: { lane, offset },
        animated: taken && view.running !== null && view.running === e.to,
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        style: { stroke: color, strokeWidth: taken ? 2 : lane === "loop" ? 1.5 : 1, strokeDasharray: lane === "loop" ? "6 4" : undefined },
        selectable: false,
        focusable: false,
      };
    });
  }, [graph, placed, view, loops, skips]);

  if (!graph) return null;
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      colorMode={theme}
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1.2 }}
      minZoom={0.2}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      zoomOnScroll
      panOnDrag
      zoomOnDoubleClick={false}
      proOptions={{ hideAttribution: true }}
      className="bg-[var(--surface-0)]"
    >
      <Background color="var(--color-zinc-800)" gap={20} size={1} />
      <Panel position="bottom-center" className="pointer-events-none !m-2 flex items-center gap-3 rounded-md border border-zinc-800 bg-[var(--surface-0)]/85 px-2 py-1 text-[10px] text-zinc-400 backdrop-blur">
        {Object.entries(KIND_COLOR).map(([kind, color]) => (
          <span key={kind} className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: color }} />
            {kind}
          </span>
        ))}
        <span className="h-3 w-px bg-zinc-700" />
        <span className="flex items-center gap-1">
          <svg width="18" height="6" aria-hidden>
            <line x1="0" y1="3" x2="18" y2="3" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          goes on
        </span>
        <span className="flex items-center gap-1" style={{ color: LOOP_COLOR }}>
          <svg width="18" height="6" aria-hidden>
            <line x1="0" y1="3" x2="18" y2="3" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3" />
          </svg>
          loops back
        </span>
        <span className="flex items-center gap-1" style={{ color: SKIP_COLOR }}>
          <svg width="18" height="6" aria-hidden>
            <line x1="0" y1="3" x2="18" y2="3" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          skips ahead
        </span>
        <span className="flex items-center gap-1" style={{ color: TAKEN_COLOR }}>
          <svg width="18" height="6" aria-hidden>
            <line x1="0" y1="3" x2="18" y2="3" stroke="currentColor" strokeWidth="2" />
          </svg>
          taken
        </span>
      </Panel>
    </ReactFlow>
  );
}

// --------------------------------------------------------------- event log

function describe(e: WorkflowEvent): { text: string; tone?: string } {
  switch (e.type) {
    case "workflow.started":
      return { text: `started ${e.workflowId} at ${e.entry}` };
    case "node.started":
      return { text: `${e.nodeId} started${e.visit > 1 ? ` (visit ${e.visit})` : ""}` };
    case "node.completed":
      return { text: `${e.nodeId} completed in ${durationMs(e.durationMs)}${e.usage ? ` · ${e.usage.model}` : ""}` };
    case "node.failed":
      return { text: `${e.nodeId} failed: ${e.code} ${e.message}`, tone: "text-rose-400" };
    case "node.output":
      return { text: `${e.nodeId} produced output`, tone: "text-zinc-500" };
    case "tool.called":
      return { text: `${e.nodeId} · ${e.tool} ${e.ok ? "ok" : "failed"} · ${e.summary}`, tone: e.ok ? "text-zinc-500" : "text-rose-400" };
    case "edge.selected":
      return { text: `${e.from} → ${e.to}${e.label ? ` (${e.label})` : ""}`, tone: "text-zinc-500" };
    case "run.paused":
      return { text: `paused at ${e.nodeId} — waiting for you`, tone: "text-amber-300" };
    case "run.resumed":
      return { text: `resumed at ${e.nodeId}`, tone: "text-amber-200/80" };
    case "workflow.completed":
      return { text: `${e.status} at ${e.terminalNodeId}`, tone: e.status === "completed" ? "text-emerald-300" : "text-rose-400" };
    case "workflow.failed":
      return { text: `failed: ${e.code} ${e.message}`, tone: "text-rose-400" };
  }
}

const LOG_MAX = 60;

function EventLog({ events }: { events: WorkflowEvent[] }) {
  const tail = events.length > LOG_MAX ? events.slice(events.length - LOG_MAX) : events;
  return (
    <div className="h-40 shrink-0 overflow-y-auto border-t border-zinc-800 bg-[var(--surface-1)] px-3 py-1.5 font-mono text-[11px]">
      {tail.length === 0 && <div className="text-zinc-600">No events yet.</div>}
      {tail.map((e, i) => {
        const d = describe(e);
        return (
          <div key={`${e.at}-${i}`} className="flex gap-2 leading-relaxed">
            <span className="shrink-0 text-zinc-600">{clockTime(e.at)}</span>
            <span className={clsx("truncate text-zinc-300", d.tone)} title={d.text}>
              {d.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}
