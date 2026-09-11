import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import yaml from "js-yaml";

import type { Result, WorkflowGraph } from "../shared/types";
import { gateHome, readConnectedTeam } from "./gate";

/**
 * A workflow file, parsed just enough to draw.
 *
 * The team's workflows are mirrored to ~/.gate/cache/<team>/workflows/<id>.yaml
 * by the `gate` CLI (src/client/cache.ts in the gate repository), in the same
 * YAML the server holds. The cockpit reads the file rather than asking the
 * server: a graph is needed the moment a run's first event arrives, and the
 * run itself was started from this same mirror.
 *
 * Every way a node can hand control to another becomes an edge:
 *   - `next: x`                      one unconditional edge
 *   - `edges: [{when, to, label}]`   one edge each; the label is the author's,
 *                                    else the condition, else "otherwise" for
 *                                    the fallback among several
 *   - `parallel` nodes               an edge to each branch and one to the join
 * Terminal nodes lead nowhere.
 */

interface RawEdge {
  to?: unknown;
  when?: unknown;
  label?: unknown;
}

interface RawNode {
  id?: unknown;
  type?: unknown;
  agent?: unknown;
  label?: unknown;
  next?: unknown;
  edges?: unknown;
  branches?: unknown;
  join?: unknown;
  disabled?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

export function parseWorkflowGraph(id: string, yamlText: string): WorkflowGraph {
  const doc = yaml.load(yamlText) as unknown;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error(`workflow "${id}" is not a YAML mapping`);
  const def = doc as { name?: unknown; entry?: unknown; nodes?: unknown };
  if (!Array.isArray(def.nodes) || def.nodes.length === 0) throw new Error(`workflow "${id}" has no nodes`);

  const nodes: WorkflowGraph["nodes"] = [];
  const edges: WorkflowGraph["edges"] = [];
  const seen = new Set<string>();
  const addEdge = (from: string, to: string, label?: string) => {
    const key = `${from} ${to} ${label ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(label === undefined ? { from, to } : { from, to, label });
  };

  for (const raw of def.nodes as RawNode[]) {
    if (!raw || typeof raw !== "object") continue;
    const nodeId = str(raw.id);
    if (!nodeId) continue;
    const type = str(raw.type) ?? "unknown";
    const node: WorkflowGraph["nodes"][number] = { id: nodeId, type };
    const agent = str(raw.agent);
    if (agent) node.agent = agent;
    const label = str(raw.label);
    if (label) node.label = label;
    else if (raw.disabled === true) node.label = "(disabled)";
    nodes.push(node);

    if (type === "parallel") {
      const branches = Array.isArray(raw.branches) ? raw.branches : [];
      branches.forEach((b, i) => {
        const to = str(b);
        if (to) addEdge(nodeId, to, `branch ${i + 1}`);
      });
      const joinId = str(raw.join);
      if (joinId) addEdge(nodeId, joinId, "join");
      continue;
    }

    const next = str(raw.next);
    if (next) addEdge(nodeId, next);

    if (Array.isArray(raw.edges)) {
      const list = (raw.edges as RawEdge[]).filter((e) => e && typeof e === "object" && str(e.to));
      const several = list.length > 1;
      for (const e of list) {
        const to = str(e.to) as string;
        const when = str(e.when);
        const edgeLabel = str(e.label) ?? when ?? (several ? "otherwise" : undefined);
        addEdge(nodeId, to, edgeLabel);
      }
    }
  }

  if (nodes.length === 0) throw new Error(`workflow "${id}" has no usable nodes`);
  const entry = str(def.entry) ?? nodes[0].id;
  return { id, name: str(def.name) ?? id, entry, nodes, edges };
}

// ------------------------------------------------------------------ mirror

export function cacheRoot(): string {
  return join(gateHome(), "cache");
}

function teamDirs(): string[] {
  try {
    return readdirSync(cacheRoot()).filter((d) => {
      if (d.startsWith(".")) return false;
      try {
        return statSync(join(cacheRoot(), d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/**
 * Which team's mirror to read. The caller's choice first; then the team the
 * CLI wrote into client.json at login; then the only mirror there is. Two
 * mirrors and no way to choose is an error that names them.
 */
export function resolveTeamDir(teamId?: string): Result<string> {
  if (teamId) {
    const dir = join(cacheRoot(), teamId);
    if (!existsSync(dir)) return { ok: false, error: `no mirror for team "${teamId}" at ${dir} — run /gate:login or any gate command to pull it` };
    return { ok: true, value: dir };
  }
  const dirs = teamDirs();
  const fromLogin = readConnectedTeam();
  if (fromLogin && dirs.includes(fromLogin)) return { ok: true, value: join(cacheRoot(), fromLogin) };
  if (dirs.length === 1) return { ok: true, value: join(cacheRoot(), dirs[0]) };
  if (dirs.length === 0) return { ok: false, error: `no team mirror under ${cacheRoot()} — run /gate:login first` };
  return { ok: false, error: `several team mirrors under ${cacheRoot()} (${dirs.join(", ")}) and no team to choose by` };
}

export function loadWorkflowGraph(workflowId: string, teamId?: string): Result<WorkflowGraph> {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(workflowId)) return { ok: false, error: `"${workflowId}" is not a workflow id` };
  const team = resolveTeamDir(teamId);
  if (!team.ok) return team;
  const file = join(team.value, "workflows", `${workflowId}.yaml`);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { ok: false, error: `workflow "${workflowId}" is not in the mirror (${file})` };
  }
  try {
    return { ok: true, value: parseWorkflowGraph(workflowId, text) };
  } catch (e) {
    return { ok: false, error: `could not read ${file}: ${e instanceof Error ? e.message : String(e)}` };
  }
}
