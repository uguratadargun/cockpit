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
const GAP_X = 70;
const GAP_Y = 110;

export function edgeId(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

/**
 * The edges that go back up the graph — a reviewer sending work back to the
 * implementer, a give-up loop — found by a depth-first walk from the entry:
 * an edge into a node still on the walk's stack is a loop. Drawn differently,
 * and left out of the layering, so the pipeline reads top-down.
 */
export function backEdges(graph: WorkflowGraph): Set<string> {
  const out = new Map<string, string[]>();
  for (const n of graph.nodes) out.set(n.id, []);
  for (const e of graph.edges) out.get(e.from)?.push(e.to);
  const back = new Set<string>();
  const state = new Map<string, 1 | 2>(); // 1 on the stack, 2 done
  const visit = (id: string) => {
    state.set(id, 1);
    for (const next of out.get(id) ?? []) {
      const st = state.get(next);
      if (st === 1) back.add(edgeId(id, next));
      else if (st === undefined && out.has(next)) visit(next);
    }
    state.set(id, 2);
  };
  if (out.has(graph.entry)) visit(graph.entry);
  for (const n of graph.nodes) if (!state.has(n.id)) visit(n.id);
  return back;
}

/**
 * Top-down layered layout.
 *
 * Depth is the longest forward path from the entry (loops removed), so a
 * node sits below everything that feeds it; nodes the entry cannot reach go
 * under the deepest layer. Within a layer, nodes are ordered by the average
 * position of their neighbours in the layer above (then below, then above
 * again) so edges cross as little as a few sweeps can manage, and each layer
 * is centred on x = 0.
 */
export function layoutGraph(graph: WorkflowGraph): Placed[] {
  const ids = graph.nodes.map((n) => n.id);
  const known = new Set(ids);
  const back = backEdges(graph);
  const forward = graph.edges.filter((e) => known.has(e.from) && known.has(e.to) && !back.has(edgeId(e.from, e.to)));
  const out = new Map<string, string[]>();
  const into = new Map<string, string[]>();
  for (const id of ids) {
    out.set(id, []);
    into.set(id, []);
  }
  for (const e of forward) {
    out.get(e.from)!.push(e.to);
    into.get(e.to)!.push(e.from);
  }

  // Longest path from the entry, in topological order (the graph is a DAG here).
  const depth = new Map<string, number>();
  const indeg = new Map(ids.map((id) => [id, into.get(id)!.length]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  for (const id of queue) depth.set(id, id === graph.entry ? 0 : 0);
  while (queue.length) {
    const cur = queue.shift()!;
    const d = depth.get(cur) ?? 0;
    for (const next of out.get(cur)!) {
      depth.set(next, Math.max(depth.get(next) ?? 0, d + 1));
      indeg.set(next, indeg.get(next)! - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  let deepest = -1;
  for (const d of depth.values()) deepest = Math.max(deepest, d);
  for (const id of ids) if (!depth.has(id)) depth.set(id, deepest + 1);

  const layers: string[][] = [];
  for (const id of ids) {
    const d = depth.get(id)!;
    (layers[d] ??= []).push(id);
  }
  for (let d = 0; d < layers.length; d++) layers[d] ??= [];

  // Barycenter sweeps: down, up, down.
  const index = new Map<string, number>();
  const reindex = () => layers.forEach((layer) => layer.forEach((id, i) => index.set(id, i)));
  reindex();
  const sweep = (dir: 1 | -1) => {
    const order = dir === 1 ? layers.keys() : [...layers.keys()].reverse();
    for (const d of order) {
      const layer = layers[d];
      if (!layer || layer.length < 2) continue;
      const neighbours = dir === 1 ? into : out;
      const key = new Map<string, number>();
      layer.forEach((id, i) => {
        const ns = neighbours.get(id)!.filter((n) => depth.get(n) === d - dir);
        key.set(id, ns.length ? ns.reduce((sum, n) => sum + index.get(n)!, 0) / ns.length : i);
      });
      layer.sort((a, b) => key.get(a)! - key.get(b)! || index.get(a)! - index.get(b)!);
      reindex();
    }
  };
  sweep(1);
  sweep(-1);
  sweep(1);

  const placed: Placed[] = [];
  layers.forEach((layer, d) => {
    const total = layer.length * NODE_W + (layer.length - 1) * GAP_X;
    layer.forEach((id, i) => {
      placed.push({ id, depth: d, x: -total / 2 + i * (NODE_W + GAP_X), y: d * (NODE_H + GAP_Y) });
    });
  });
  return placed;
}
