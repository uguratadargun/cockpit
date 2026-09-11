import { Background, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import clsx from "clsx";
import { Pause, Square, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { Execution, WorkflowEvent } from "@shared/types";

import { Pill } from "@/components/Badge";
import { Button } from "@/components/Button";
import { RelativeTime } from "@/components/RelativeTime";
import { clockTime, durationMs, shortId } from "@/lib/format";
import { NODE_H, NODE_W, deriveRunView, edgeKey, layoutGraph, nodeState, type NodeState } from "@/lib/graph";
import { Empty } from "@/panels/Questions";
import { useExecutionById, useStore } from "@/store";

const STATUS_PILL: Record<Execution["status"], string> = {
  running: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  completed: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  failed: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

export function Executions() {
  const executions = useStore((s) => s.executions);
  const selectedId = useStore((s) => s.selectedExecutionId);
  const selectExecution = useStore((s) => s.selectExecution);

  return (
    <section className="flex h-full min-w-0 flex-1">
      <aside className="flex w-80 shrink-0 flex-col border-r border-zinc-800 bg-[#121419]">
        <header className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
          <Workflow size={14} className="text-zinc-400" />
          <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Executions</span>
          <span className="text-[11px] text-zinc-600">{executions.length}</span>
        </header>
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

// ------------------------------------------------------------------- graph

interface WfData extends Record<string, unknown> {
  label: string;
  type: string;
  agent?: string;
  state: NodeState;
  entry: boolean;
}
type WfNode = Node<WfData, "wf">;

const NODE_CLASS: Record<NodeState, string> = {
  idle: "border-zinc-700 bg-zinc-900 text-zinc-300",
  running: "border-sky-400 bg-sky-500/15 text-sky-100 shadow-[0_0_0_3px_rgba(56,189,248,0.2)]",
  paused: "border-amber-400 bg-amber-500/15 text-amber-100 shadow-[0_0_0_3px_rgba(251,191,36,0.25)]",
  completed: "border-zinc-800 bg-zinc-900/60 text-zinc-500",
  failed: "border-rose-500 bg-rose-500/15 text-rose-100",
};

function WfNodeView({ data }: NodeProps<WfNode>) {
  return (
    <div className={clsx("flex flex-col justify-center rounded-md border px-2.5 py-1.5 text-xs", NODE_CLASS[data.state])} style={{ width: NODE_W, height: NODE_H }}>
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !border-0 !bg-zinc-600" />
      <div className="flex items-center gap-1.5">
        <span className="truncate font-medium">{data.label}</span>
        {data.state === "running" && <span className="ml-auto h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-sky-400" />}
      </div>
      <div className="truncate text-[10px] opacity-70">
        {data.state === "paused" ? "waiting for you" : [data.type, data.agent].filter(Boolean).join(" · ")}
      </div>
      <Handle type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !border-0 !bg-zinc-600" />
    </div>
  );
}

const nodeTypes = { wf: WfNodeView };

function Graph({ graphId, events }: { graphId: string; events: WorkflowEvent[] }) {
  const graph = useStore((s) => s.graphs[graphId]);
  const view = useMemo(() => deriveRunView(events), [events]);
  const placed = useMemo(() => (graph ? layoutGraph(graph) : []), [graph]);

  const nodes = useMemo<WfNode[]>(() => {
    if (!graph) return [];
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    return placed.map((p) => {
      const n = byId.get(p.id)!;
      return {
        id: n.id,
        type: "wf",
        position: { x: p.x, y: p.y },
        draggable: false,
        connectable: false,
        selectable: false,
        data: { label: n.label ?? n.id, type: n.type, agent: n.agent, state: nodeState(n.id, view), entry: n.id === graph.entry },
      };
    });
  }, [graph, placed, view]);

  const edges = useMemo<Edge[]>(() => {
    if (!graph) return [];
    return graph.edges.map((e, i) => {
      const taken = view.taken.has(edgeKey(e.from, e.to));
      const color = taken ? "#7dd3fc" : "#3f3f46";
      return {
        id: `${e.from}-${e.to}-${i}`,
        source: e.from,
        target: e.to,
        label: e.label,
        type: "smoothstep",
        animated: taken && view.running !== null && view.running === e.to,
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        style: { stroke: color, strokeWidth: taken ? 1.8 : 1 },
        labelStyle: { fill: taken ? "#bae6fd" : "#71717a", fontSize: 10 },
        labelBgStyle: { fill: "#0f1115", fillOpacity: 0.9 },
        labelBgPadding: [3, 2] as [number, number],
        selectable: false,
        focusable: false,
      };
    });
  }, [graph, view]);

  if (!graph) return null;
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      colorMode="dark"
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
      minZoom={0.2}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      panOnScroll
      zoomOnDoubleClick={false}
      proOptions={{ hideAttribution: true }}
      className="bg-[#0f1115]"
    >
      <Background color="#27272a" gap={20} size={1} />
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
    <div className="h-40 shrink-0 overflow-y-auto border-t border-zinc-800 bg-[#121419] px-3 py-1.5 font-mono text-[11px]">
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
