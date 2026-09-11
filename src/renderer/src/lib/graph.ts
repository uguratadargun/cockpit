import type { WorkflowEvent, WorkflowGraph } from "@shared/types";

export type NodeState = "idle" | "running" | "paused" | "completed" | "failed";

export interface RunView {
  /** Last node.started without a node.completed/failed of its own. */
  running: string | null;
  /** Last run.paused without a run.resumed. */
  paused: string | null;
  completed: Set<string>;
  failed: Set<string>;
  /** "from->to" of every edge.selected, so the road taken can be drawn brighter. */
  taken: Set<string>;
}

export function edgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}

export function deriveRunView(events: WorkflowEvent[]): RunView {
  const view: RunView = { running: null, paused: null, completed: new Set(), failed: new Set(), taken: new Set() };
  for (const e of events) {
    switch (e.type) {
      case "node.started":
        view.running = e.nodeId;
        view.completed.delete(e.nodeId);
        view.failed.delete(e.nodeId);
        break;
      case "node.completed":
        view.completed.add(e.nodeId);
        if (view.running === e.nodeId) view.running = null;
        break;
      case "node.failed":
        view.failed.add(e.nodeId);
        if (view.running === e.nodeId) view.running = null;
        break;
      case "run.paused":
        view.paused = e.nodeId;
        break;
      case "run.resumed":
        view.paused = null;
        break;
      case "edge.selected":
        view.taken.add(edgeKey(e.from, e.to));
        break;
      case "workflow.completed":
      case "workflow.failed":
        view.running = null;
        view.paused = null;
        break;
      default:
        break;
    }
  }
  return view;
}

export function nodeState(id: string, view: RunView): NodeState {
  if (view.paused === id) return "paused";
  if (view.running === id) return "running";
  if (view.failed.has(id)) return "failed";
  if (view.completed.has(id)) return "completed";
  return "idle";
}

export interface Placed {
  id: string;
  x: number;
  y: number;
  depth: number;
}

export const NODE_W = 180;
export const NODE_H = 56;
const GAP_X = 40;
const GAP_Y = 60;

/**
 * Top-down layered layout: depth by BFS from `entry` (nodes the entry cannot
 * reach go under the deepest layer), nodes in a layer keep the order they
 * appear in the workflow and are centred around x = 0.
 */
export function layoutGraph(graph: WorkflowGraph): Placed[] {
  const ids = graph.nodes.map((n) => n.id);
  const out = new Map<string, string[]>();
  for (const id of ids) out.set(id, []);
  for (const e of graph.edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e.to);
  }

  const depth = new Map<string, number>();
  const queue: string[] = [];
  if (ids.includes(graph.entry)) {
    depth.set(graph.entry, 0);
    queue.push(graph.entry);
  }
  while (queue.length) {
    const cur = queue.shift()!;
    const d = depth.get(cur)!;
    for (const next of out.get(cur) ?? []) {
      if (!depth.has(next) && ids.includes(next)) {
        depth.set(next, d + 1);
        queue.push(next);
      }
    }
  }
  let deepest = -1;
  for (const d of depth.values()) deepest = Math.max(deepest, d);
  for (const id of ids) if (!depth.has(id)) depth.set(id, deepest + 1);

  const layers = new Map<number, string[]>();
  for (const id of ids) {
    const d = depth.get(id)!;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d)!.push(id);
  }

  const placed: Placed[] = [];
  for (const [d, layer] of layers) {
    const total = layer.length * NODE_W + (layer.length - 1) * GAP_X;
    layer.forEach((id, i) => {
      placed.push({ id, depth: d, x: -total / 2 + i * (NODE_W + GAP_X), y: d * (NODE_H + GAP_Y) });
    });
  }
  return placed;
}
