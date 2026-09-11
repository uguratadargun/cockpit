import "./_ts.mjs";

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

const { claudeConfigDir, discoverSessions, readRunPointer, watchSessions } = await import("../src/main/sessions.ts");

/** A transcript the way Claude Code writes one: bookkeeping first, then the person's prompt with cwd and timestamp. */
function transcript(id, cwd, at, prompt = "Fix the login bug") {
  const ts = new Date(at).toISOString();
  return [
    JSON.stringify({ type: "mode", mode: "normal", sessionId: id }),
    JSON.stringify({ type: "file-history-snapshot", messageId: "m1", snapshot: {}, isSnapshotUpdate: false }),
    JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "<local-command-caveat>x</local-command-caveat>" }, timestamp: ts, cwd, sessionId: id }),
    JSON.stringify({ type: "user", message: { role: "user", content: prompt }, timestamp: ts, cwd, sessionId: id }),
    JSON.stringify({ type: "assistant", message: { id: "a1", role: "assistant", content: [{ type: "text", text: "On it." }] }, timestamp: new Date(at + 1000).toISOString(), cwd, sessionId: id }),
    "",
  ].join("\n");
}

describe("sessions on disk", () => {
  let root;
  let saved;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cockpit-sessions-"));
    saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, GATE_HOME: process.env.GATE_HOME };
    process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
    process.env.GATE_HOME = join(root, "gate");
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const write = (project, id, at, cwd = `/Users/me/${project}`, prompt) => {
    const dir = join(process.env.CLAUDE_CONFIG_DIR, "projects", `-Users-me-${project}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}.jsonl`);
    writeFileSync(path, transcript(id, cwd, at, prompt));
    utimesSync(path, new Date(at + 5000), new Date(at + 5000));
    return path;
  };

  test("claudeConfigDir honours CLAUDE_CONFIG_DIR", () => {
    assert.equal(claudeConfigDir(), join(root, "claude"));
  });

  test("no projects directory: an empty list, no throw", () => {
    assert.deepEqual(discoverSessions(), []);
  });

  test("newest first, cwd and start from the transcript, title from its first prompt", () => {
    const t0 = Date.parse("2026-09-11T08:00:00Z");
    const older = write("alpha", "11111111-1111-4111-8111-111111111111", t0, "/Users/me/alpha", "Rename the thing");
    const newer = write("beta", "22222222-2222-4222-8222-222222222222", t0 + 60_000);
    // noise that is not a session: a subagent dir, an empty transcript, a non-jsonl file
    mkdirSync(join(process.env.CLAUDE_CONFIG_DIR, "projects", "-Users-me-beta", "22222222-2222-4222-8222-222222222222", "subagents"), { recursive: true });
    writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, "projects", "-Users-me-beta", "22222222-2222-4222-8222-222222222222", "subagents", "agent-x.jsonl"), "{}\n");
    writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, "projects", "-Users-me-beta", "33333333-3333-4333-8333-333333333333.jsonl"), "");
    writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, "projects", "-Users-me-beta", "notes.txt"), "x");

    const list = discoverSessions();
    assert.deepEqual(
      list.map((s) => s.id),
      ["22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111"],
    );
    const [b, a] = list;
    assert.equal(b.transcriptPath, newer);
    assert.equal(b.projectDir, join(process.env.CLAUDE_CONFIG_DIR, "projects", "-Users-me-beta"));
    assert.equal(b.cwd, "/Users/me/beta");
    assert.equal(b.startedAt, t0 + 60_000);
    assert.equal(b.lastActiveAt, t0 + 65_000);
    assert.equal(b.title, "Fix the login bug");
    assert.equal(a.transcriptPath, older);
    assert.equal(a.cwd, "/Users/me/alpha");
    assert.equal(a.title, "Rename the thing");
    assert.equal(a.startedAt, t0);
  });

  test("limit and sinceMs", () => {
    const t0 = Date.parse("2026-09-11T08:00:00Z");
    write("a", "aaaaaaaa-0000-4000-8000-000000000001", t0);
    write("b", "aaaaaaaa-0000-4000-8000-000000000002", t0 + 10_000);
    write("c", "aaaaaaaa-0000-4000-8000-000000000003", t0 + 20_000);
    assert.deepEqual(
      discoverSessions({ limit: 2 }).map((s) => s.id),
      ["aaaaaaaa-0000-4000-8000-000000000003", "aaaaaaaa-0000-4000-8000-000000000002"],
    );
    assert.deepEqual(
      // mtimes sit 5s after each start: only c's (t0 + 25s) is at or after this
      discoverSessions({ sinceMs: t0 + 20_000 }).map((s) => s.id),
      ["aaaaaaaa-0000-4000-8000-000000000003"],
    );
  });

  test("a transcript with no cwd yet has cwd null", () => {
    const dir = join(process.env.CLAUDE_CONFIG_DIR, "projects", "-Users-me-x");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s1.jsonl"), `${JSON.stringify({ type: "mode", mode: "normal" })}\n`);
    const [s] = discoverSessions();
    assert.equal(s.id, "s1");
    assert.equal(s.cwd, null);
    assert.equal(s.title, null);
    assert.ok(s.startedAt > 0);
  });

  test("readRunPointer: the plugin's file, mapped; null when absent or malformed", () => {
    assert.equal(readRunPointer("nope"), null);
    assert.equal(readRunPointer("../client"), null);
    const dir = join(process.env.GATE_HOME, "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "s1.json"),
      `${JSON.stringify({ session: "s1", executionId: "e1", state: "agent", nodeId: "plan-review", agent: "plan-review", asks: "approval", at: 123 })}\n`,
    );
    assert.deepEqual(readRunPointer("s1"), { executionId: "e1", state: "agent", nodeId: "plan-review", agent: "plan-review", asks: "approval", at: 123 });
    writeFileSync(join(dir, "s2.json"), JSON.stringify({ session: "s2", executionId: "e2", state: "done", nodeId: null, agent: null, asks: null, at: 5 }));
    assert.deepEqual(readRunPointer("s2"), { executionId: "e2", state: "done", nodeId: null, agent: null, asks: null, at: 5 });
    writeFileSync(join(dir, "s3.json"), "{broken");
    assert.equal(readRunPointer("s3"), null);
    writeFileSync(join(dir, "s4.json"), JSON.stringify({ session: "s4" }));
    assert.equal(readRunPointer("s4"), null);
  });

  test("watchSessions: no directories yet, no throw; fires once a transcript appears; unsubscribes", async () => {
    let calls = 0;
    const stop = watchSessions(() => {
      calls++;
    });
    // Directories come into being after the watch started.
    const dir = join(process.env.CLAUDE_CONFIG_DIR, "projects", "-Users-me-w");
    mkdirSync(dir, { recursive: true });
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(join(dir, "w1.jsonl"), transcript("w1", "/Users/me/w", Date.now()));
    const t0 = Date.now();
    while (calls === 0 && Date.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 50));
    assert.ok(calls >= 1, "the callback fired for a new transcript");
    // Debounced: a burst is one call.
    const before = calls;
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, "w1.jsonl"), transcript("w1", "/Users/me/w", Date.now() + i), { flag: "a" });
    await new Promise((r) => setTimeout(r, 700));
    assert.ok(calls - before <= 2, `a burst of writes is debounced (got ${calls - before} calls)`);
    stop();
    const after = calls;
    writeFileSync(join(dir, "w2.jsonl"), transcript("w2", "/Users/me/w", Date.now()));
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(calls, after, "nothing after unsubscribe");
  });
});
