import "./_ts.mjs";

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

const { loadWorkflowGraph, parseWorkflowGraph, resolveTeamDir } = await import("../src/main/graph.ts");

const YAML = `
name: Dev
description: A road.
entry: base
nodes:
  - id: base
    type: command
    label: Record the starting commit
    command: [git, log, "-1"]
    next: planner

  - id: planner
    type: agent
    agent: planner
    label: Plan
    next: plan-check

  - id: plan-check
    type: condition
    label: Questions?
    edges:
      - when: outputs.planner.questions != ""
        to: clarify
        label: has questions
      - when: outputs.plan-review.decision == "approve"
        to: implementer
      - to: plan-review
        label: has a plan

  - id: clarify
    type: agent
    agent: clarify
    next: planner

  - id: plan-review
    type: agent
    agent: plan-review
    next: implementer

  - id: implementer
    type: agent
    agent: implementer
    disabled: true
    skipTo: checks
    edges:
      - when: outputs.implementer.changed == false
        to: nothing-changed
        label: deliberately changed nothing
      - to: checks
        label: implemented

  - id: checks
    type: parallel
    label: Review and guard
    branches: [reviewer, guard]
    join: verdict

  - id: reviewer
    type: agent
    agent: reviewer
    next: verdict

  - id: guard
    type: command
    command: [npm, test]
    edges:
      - to: verdict

  - id: verdict
    type: condition
    edges:
      - when: outputs.reviewer.verdict == "approved"
        to: done
        label: approved
      - to: planner

  - id: done
    type: terminal
    label: Merge request opened
    status: completed

  - id: nothing-changed
    type: terminal
    status: failed
`;

describe("parseWorkflowGraph", () => {
  const g = parseWorkflowGraph("dev", YAML);

  test("id, name, entry, nodes", () => {
    assert.equal(g.id, "dev");
    assert.equal(g.name, "Dev");
    assert.equal(g.entry, "base");
    assert.deepEqual(
      g.nodes.map((n) => n.id),
      ["base", "planner", "plan-check", "clarify", "plan-review", "implementer", "checks", "reviewer", "guard", "verdict", "done", "nothing-changed"],
    );
    assert.deepEqual(g.nodes[0], { id: "base", type: "command", label: "Record the starting commit" });
    assert.deepEqual(g.nodes[1], { id: "planner", type: "agent", agent: "planner", label: "Plan" });
    // A terminal carries its status, so the layout can keep the main line off a failed exit.
    assert.deepEqual(g.nodes[11], { id: "nothing-changed", type: "terminal", status: "failed" });
  });

  const edge = (from, to) => g.edges.find((e) => e.from === from && e.to === to);

  test("`next` is one unlabelled edge", () => {
    assert.deepEqual(edge("base", "planner"), { from: "base", to: "planner" });
    assert.deepEqual(edge("clarify", "planner"), { from: "clarify", to: "planner" });
  });

  test("conditional edges keep the author's label, else the condition, else 'otherwise'", () => {
    assert.deepEqual(edge("plan-check", "clarify"), { from: "plan-check", to: "clarify", label: "has questions" });
    assert.deepEqual(edge("plan-check", "implementer"), { from: "plan-check", to: "implementer", label: 'outputs.plan-review.decision == "approve"' });
    assert.deepEqual(edge("plan-check", "plan-review"), { from: "plan-check", to: "plan-review", label: "has a plan" });
    assert.deepEqual(edge("verdict", "planner"), { from: "verdict", to: "planner", label: "otherwise" });
    // a lone unconditional edge in `edges:` needs no label
    assert.deepEqual(edge("guard", "verdict"), { from: "guard", to: "verdict" });
  });

  test("parallel nodes lead to each branch and to the join", () => {
    assert.deepEqual(edge("checks", "reviewer"), { from: "checks", to: "reviewer", label: "branch 1" });
    assert.deepEqual(edge("checks", "guard"), { from: "checks", to: "guard", label: "branch 2" });
    assert.deepEqual(edge("checks", "verdict"), { from: "checks", to: "verdict", label: "join" });
    assert.deepEqual(g.nodes.find((n) => n.id === "checks"), { id: "checks", type: "parallel", label: "Review and guard" });
  });

  test("terminal nodes lead nowhere; a disabled node without a label says so", () => {
    assert.equal(g.edges.filter((e) => e.from === "done" || e.from === "nothing-changed").length, 0);
    assert.equal(g.nodes.find((n) => n.id === "implementer").label, "(disabled)");
  });

  test("the edge order follows the file", () => {
    assert.deepEqual(
      g.edges.filter((e) => e.from === "implementer").map((e) => e.to),
      ["nothing-changed", "checks"],
    );
  });

  test("bad input throws with the workflow's id", () => {
    assert.throws(() => parseWorkflowGraph("x", "just a string"), /"x" is not a YAML mapping/);
    assert.throws(() => parseWorkflowGraph("x", "name: nope\n"), /"x" has no nodes/);
    assert.throws(() => parseWorkflowGraph("x", "nodes: [\n"), /YAML|expected|unexpected|end of the stream/i);
  });

  test("name and entry fall back to the id and the first node", () => {
    const g2 = parseWorkflowGraph("bare", "nodes:\n  - id: only\n    type: terminal\n");
    assert.equal(g2.name, "bare");
    assert.equal(g2.entry, "only");
  });
});

describe("loadWorkflowGraph", () => {
  let home;
  let saved;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cockpit-graph-"));
    saved = { GATE_HOME: process.env.GATE_HOME, GATE_URL: process.env.GATE_URL, GATE_KEY: process.env.GATE_KEY };
    process.env.GATE_HOME = home;
    delete process.env.GATE_URL;
    delete process.env.GATE_KEY;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  });

  const mirror = (team, files) => {
    const dir = join(home, "cache", team, "workflows");
    mkdirSync(dir, { recursive: true });
    for (const [id, text] of Object.entries(files)) writeFileSync(join(dir, `${id}.yaml`), text);
  };

  test("no mirror at all", () => {
    const r = loadWorkflowGraph("dev");
    assert.equal(r.ok, false);
    assert.match(r.error, /no team mirror/);
  });

  test("a single team dir is used without being named", () => {
    mirror("desktop", { dev: YAML });
    const r = loadWorkflowGraph("dev");
    assert.equal(r.ok, true);
    assert.equal(r.value.name, "Dev");
    assert.equal(r.value.nodes.length, 12);
  });

  test("a missing workflow names the file", () => {
    mirror("desktop", { dev: YAML });
    const r = loadWorkflowGraph("blame");
    assert.equal(r.ok, false);
    assert.match(r.error, /"blame" is not in the mirror/);
    assert.match(r.error, /blame\.yaml/);
  });

  test("a bad id is refused before any file is touched", () => {
    const r = loadWorkflowGraph("../etc/passwd");
    assert.equal(r.ok, false);
    assert.match(r.error, /not a workflow id/);
  });

  test("two team dirs: the one named, else the one client.json names, else an error listing both", () => {
    mirror("desktop", { dev: "name: Desktop dev\nentry: a\nnodes:\n  - id: a\n    type: terminal\n" });
    mirror("ulak", { dev: "name: Ulak dev\nentry: a\nnodes:\n  - id: a\n    type: terminal\n" });
    assert.equal(loadWorkflowGraph("dev", "ulak").value.name, "Ulak dev");
    const none = loadWorkflowGraph("dev");
    assert.equal(none.ok, false);
    assert.match(none.error, /several team mirrors .*desktop, ulak/);
    writeFileSync(join(home, "client.json"), JSON.stringify({ url: "http://x", key: "gate_k", team: "desktop" }));
    assert.equal(loadWorkflowGraph("dev").value.name, "Desktop dev");
    const missing = resolveTeamDir("nope");
    assert.equal(missing.ok, false);
    assert.match(missing.error, /no mirror for team "nope"/);
  });

  test("a broken file is an error, not a throw", () => {
    mirror("desktop", { dev: "nodes: [\n" });
    const r = loadWorkflowGraph("dev");
    assert.equal(r.ok, false);
    assert.match(r.error, /could not read/);
  });
});
