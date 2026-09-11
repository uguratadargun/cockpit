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
/** Wider than the dashboard's 250: the gap between two cards is where a forward edge's label lives. */
export const COLUMN_WIDTH = 300;
export const ROW_HEIGHT = 110;

export function edgeId(from: string, to: string): string {
  return `${from}->${to}`;
}

/**
 * The edges that hand control back to an earlier node — a reviewer sending
 * work back to the implementer, a give-up loop — found by a depth-first walk:
 * an edge into a node still on the walk's stack is a loop. Drawn as a return
 * path under the cards, and left out of the layering, so the pipeline reads
 * left to right. The same rule gate's dashboard uses.
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
 * Left-to-right layout, as gate's dashboard draws it.
 *
 * A node's column is the longest forward path from the entry (loops set
 * aside). Within a column, the node with the longest road still ahead — the
 * spine — sits on row 0, so the run's main line reads straight across.
 * Everything else in the column is a side exit or a detour and goes above
 * the spine; the space below is for the return paths, drawn from bottom
 * handle to bottom handle. The one exception is a side node that itself
 * loops back (clarify → planner): it goes below, where its return path does
 * not have to cross the spine's card.
 */
export function layoutGraph(graph: WorkflowGraph): Placed[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const loops = backEdges(graph);
  const outgoing = new Map<string, string[]>();
  for (const n of graph.nodes) outgoing.set(n.id, []);
  for (const e of graph.edges) if (byId.has(e.from) && byId.has(e.to)) outgoing.get(e.from)!.push(e.to);
  const forward = (id: string) => (outgoing.get(id) ?? []).filter((to) => !loops.has(edgeId(id, to)));
  const loopsBack = (id: string) => (outgoing.get(id) ?? []).some((to) => loops.has(edgeId(id, to)));

  const depth = new Map<string, number>();
  const topo: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const to of forward(id)) visit(to);
    topo.push(id);
  };
  if (byId.has(graph.entry)) visit(graph.entry);
  topo.reverse();
  if (byId.has(graph.entry)) depth.set(graph.entry, 0);
  for (const id of topo) {
    const d = depth.get(id);
    if (d === undefined) continue;
    for (const to of forward(id)) depth.set(to, Math.max(depth.get(to) ?? 0, d + 1));
  }
  const order = [...topo];
  for (const n of graph.nodes) if (!seen.has(n.id)) order.push(n.id);
  const depthOf = (id: string) => depth.get(id) ?? 0;

  const reach = new Map<string, number>();
  const reachOf = (id: string): number => {
    const known = reach.get(id);
    if (known !== undefined) return known;
    reach.set(id, 0);
    let best = 0;
    for (const to of forward(id)) best = Math.max(best, 1 + reachOf(to));
    reach.set(id, best);
    return best;
  };

  const columns = new Map<number, string[]>();
  for (const id of order) {
    const d = depthOf(id);
    columns.set(d, [...(columns.get(d) ?? []), id]);
  }
  const failedExit = (id: string) => {
    const n = byId.get(id);
    return n?.type === "terminal" && n.status === "failed";
  };
  const ahead = (a: string, b: string) =>
    reachOf(a) > reachOf(b) || (reachOf(a) === reachOf(b) && !failedExit(a) && failedExit(b));

  const placed: Placed[] = [];
  for (const [d, ids] of columns) {
    let spine = ids[0];
    for (const id of ids) if (ahead(id, spine)) spine = id;
    let above = 0;
    let below = 0;
    for (const id of ids) {
      let row: number;
      if (id === spine) row = 0;
      else if (loopsBack(id)) row = ++below;
      else row = -++above;
      placed.push({ id, depth: d, x: d * COLUMN_WIDTH, y: row * ROW_HEIGHT });
    }
  }
  return placed;
}

/**
 * Forward edges that do not go to the next column over: a shortcut past a
 * gate, an exit to a terminal placed further along. Drawn straight they
 * would cut through the cards between, so they get a lane above the cards,
 * the mirror of what return paths get below.
 */
export function skipEdges(graph: WorkflowGraph, placed: Placed[], loops: Set<string>): Set<string> {
  const pos = new Map(placed.map((p) => [p.id, p]));
  const out = new Set<string>();
  for (const e of graph.edges) {
    const from = pos.get(e.from);
    const to = pos.get(e.to);
    const key = edgeId(e.from, e.to);
    if (!from || !to || loops.has(key)) continue;
    const dx = to.x - from.x;
    if (dx < COLUMN_WIDTH * 0.5 || dx > COLUMN_WIDTH * 1.5) out.add(key);
  }
  return out;
}
