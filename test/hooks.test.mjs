// The hook plane end to end: the shim script, the settings file, the socket
// path and HookServer, driven over a real unix socket by the real shim running
// under plain node (node:test, no Electron).
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");

/** Bundles one TS module from src/ to a temp .mjs and imports it, so tests need no build step. */
async function load(rel) {
  const out = await build({
    entryPoints: [resolve(root, rel)],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
    tsconfig: resolve(root, "tsconfig.node.json"),
  });
  const file = join(mkdtempSync(join(tmpdir(), "cockpit-test-")), "mod.mjs");
  writeFileSync(file, out.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

const shim = await load("src/main/hookShim.ts");
const hooks = await load("src/main/hooks.ts");
const sock = await load("src/shared/sockPath.ts");

const { ensureShim, hookCommand, writeSessionSettings, SHIM_SOURCE, STATUS_ARG } = shim;
const { HookServer, permissionSummary, sessionEventFor, askReply } = hooks;
const { cockpitSockPath, MAX_UNIX_SOCK_PATH } = sock;

const tmp = () => mkdtempSync(join(tmpdir(), "cockpit-hooks-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error("timed out waiting");
}

/** Runs the real shim as Claude Code would: payload on stdin, env for the socket and pty. */
function runShim(shimPath, payload, env, args = []) {
  const child = spawn(process.execPath, [shimPath, ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  const done = new Promise((r) => child.on("exit", (code) => r({ code, stdout })));
  child.stdin.end(JSON.stringify(payload));
  return done;
}

// ------------------------------------------------------------- sockPath

test("cockpitSockPath: beside the base dir when short, hashed in tmp when too deep, a pipe on windows", () => {
  assert.equal(cockpitSockPath("/tmp/base", "darwin", "/tmp"), "/tmp/base/cockpit.sock");
  const deep = "/" + "d".repeat(120);
  const p = cockpitSockPath(deep, "darwin", "/tmp/");
  assert.ok(p.startsWith("/tmp/cockpit-"));
  assert.ok(Buffer.byteLength(p) <= MAX_UNIX_SOCK_PATH);
  assert.equal(p, cockpitSockPath(deep, "linux", "/tmp"), "stable per base dir");
  assert.notEqual(p, cockpitSockPath(deep + "x", "linux", "/tmp"));
  assert.match(cockpitSockPath("C:\\Users\\x", "win32", "C:\\tmp"), /^\\\\\.\\pipe\\gate-cockpit-[0-9a-f]{12}$/);
  assert.equal(typeof cockpitSockPath("/tmp/base"), "string");
});

// ------------------------------------------------------------- hookShim

test("ensureShim writes the shim once and leaves it alone when unchanged", async () => {
  const dir = join(tmp(), "nested");
  const p = ensureShim(dir);
  assert.equal(p, join(dir, "cockpit-hook.cjs"));
  assert.equal(readFileSync(p, "utf8"), SHIM_SOURCE);
  const before = statSync(p).mtimeMs;
  await sleep(20);
  assert.equal(ensureShim(dir), p);
  assert.equal(statSync(p).mtimeMs, before, "not rewritten");
  writeFileSync(p, "tampered");
  ensureShim(dir);
  assert.equal(readFileSync(p, "utf8"), SHIM_SOURCE, "restored");
});

test("hookCommand runs this binary as node with quoted paths", () => {
  assert.equal(hookCommand("/a b/shim.cjs"), `ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "/a b/shim.cjs"`);
  assert.equal(hookCommand('/q"x', STATUS_ARG), `ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "/q\\"x" "${STATUS_ARG}"`);
});

test("writeSessionSettings routes every event through the shim, with a day's timeout on the two blocking hooks", () => {
  const dir = tmp();
  const p = writeSessionSettings(dir, "pty/1", "/x/shim.cjs");
  assert.equal(p, join(dir, "settings-pty_1.json"));
  const s = JSON.parse(readFileSync(p, "utf8"));
  const cmd = hookCommand("/x/shim.cjs");
  for (const ev of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Notification", "Stop", "SessionEnd"]) {
    assert.ok(Array.isArray(s.hooks[ev]) && s.hooks[ev].length > 0, ev);
    for (const entry of s.hooks[ev]) for (const h of entry.hooks) {
      assert.equal(h.type, "command");
      assert.ok(h.command.startsWith(cmd), `${ev}: ${h.command}`);
    }
  }
  const ask = s.hooks.PreToolUse.find((e) => e.matcher === "AskUserQuestion");
  assert.equal(ask.hooks[0].timeout, 86400);
  assert.equal(ask.hooks[0].command, cmd);
  const status = s.hooks.PreToolUse.find((e) => e.matcher === "*");
  assert.equal(status.hooks[0].command, hookCommand("/x/shim.cjs", STATUS_ARG));
  assert.equal(s.hooks.PermissionRequest[0].matcher, "*");
  assert.equal(s.hooks.PermissionRequest[0].hooks[0].timeout, 86400);
  assert.equal(s.hooks.PostToolUse[0].matcher, "*");
  assert.equal(s.hooks.Stop[0].matcher, undefined);
  const before = statSync(p).mtimeMs;
  writeSessionSettings(dir, "pty/1", "/x/shim.cjs");
  assert.equal(statSync(p).mtimeMs, before, "idempotent");
});

test("the shim exits 0 with no output at once when the socket is unreachable or unset", async () => {
  const shimPath = ensureShim(tmp());
  const t0 = Date.now();
  const gone = await runShim(shimPath, { hook_event_name: "PermissionRequest", session_id: "s" }, { COCKPIT_SOCK: join(tmp(), "none.sock"), COCKPIT_PTY: "p" });
  assert.deepEqual(gone, { code: 0, stdout: "" });
  assert.ok(Date.now() - t0 < 3000, "did not wait for a timeout");
  const unset = await runShim(shimPath, { hook_event_name: "Stop" }, { COCKPIT_SOCK: "", COCKPIT_PTY: "" });
  assert.deepEqual(unset, { code: 0, stdout: "" });
});

// ------------------------------------------------------------ pure bits

test("permissionSummary: the command, the file, the plan's title, else the tool", () => {
  assert.equal(permissionSummary("Bash", { command: "  npm test\n&& more" }), "npm test");
  assert.equal(permissionSummary("Edit", { file_path: "/a/b.ts" }), "/a/b.ts");
  assert.equal(permissionSummary("Write", { file_path: "/a/c.ts" }), "/a/c.ts");
  assert.equal(permissionSummary("NotebookEdit", { notebook_path: "/n.ipynb" }), "/n.ipynb");
  assert.equal(permissionSummary("ExitPlanMode", { plan: "# Ship it\n\nsteps" }), "Approve the plan: Ship it");
  assert.equal(permissionSummary("ExitPlanMode", {}), "Approve the plan");
  assert.equal(permissionSummary("WebFetch", { url: "x" }), "WebFetch");
});

test("sessionEventFor maps hook events to session kinds", () => {
  const base = { session_id: "s1", cwd: "/w", transcript_path: "/t.jsonl", pty_id: "p1" };
  const kind = (p) => sessionEventFor({ ...base, ...p }, 5)?.kind ?? null;
  assert.equal(kind({ hook_event_name: "SessionStart", source: "startup" }), "start");
  assert.equal(kind({ hook_event_name: "UserPromptSubmit", prompt: "hi" }), "prompt");
  assert.equal(kind({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }), "working");
  assert.equal(kind({ hook_event_name: "PostToolUse", tool_name: "Bash" }), "working");
  assert.equal(kind({ hook_event_name: "Stop", last_assistant_message: "done" }), "idle");
  assert.equal(kind({ hook_event_name: "Notification", notification_type: "permission_prompt" }), "blocked");
  assert.equal(kind({ hook_event_name: "Notification", notification_type: "idle_prompt" }), "waiting");
  assert.equal(kind({ hook_event_name: "Notification", notification_type: "agent_needs_input" }), "waiting");
  assert.equal(kind({ hook_event_name: "Notification", notification_type: "auth_success" }), null);
  assert.equal(kind({ hook_event_name: "SessionEnd", reason: "exit" }), "end");
  assert.equal(kind({ hook_event_name: "PreCompact" }), null);
  const e = sessionEventFor({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash" }, 5);
  assert.deepEqual(e, { sessionId: "s1", ptyId: "p1", cwd: "/w", transcriptPath: "/t.jsonl", at: 5, kind: "working", detail: "Bash" });
  assert.equal(sessionEventFor({ hook_event_name: "Stop" }), null, "no session id, no event");
});

test("askReply echoes the questions as received and carries answers and response", () => {
  const input = { questions: [{ question: "Which?", header: "Pick", options: [{ label: "A", description: "" }], multiSelect: false }] };
  const r = askReply(input, { answers: { "Which?": "A" } });
  assert.deepEqual(r, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { questions: input.questions, answers: { "Which?": "A" } } } });
  const r2 = askReply(input, { answers: {}, response: "my own words" });
  assert.equal(r2.hookSpecificOutput.updatedInput.response, "my own words");
});

// --------------------------------------------------------------- server

/** A server on a fresh socket, with a gate home holding one run pointer, and the shim to reach it. */
async function fixture(pointer) {
  const base = tmp();
  const home = join(base, "gate");
  mkdirSync(join(home, "sessions"), { recursive: true });
  if (pointer) writeFileSync(join(home, "sessions", "sess-1.json"), JSON.stringify(pointer));
  const server = new HookServer(home);
  const sockPath = cockpitSockPath(base);
  await server.start(sockPath);
  const shimPath = ensureShim(join(base, "bin"));
  const env = { COCKPIT_SOCK: sockPath, COCKPIT_PTY: "pty-7" };
  const transcript = join(base, "t.jsonl");
  writeFileSync(
    transcript,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "review my plan" }, timestamp: "2026-09-11T08:00:00.000Z", cwd: "/w" }),
      JSON.stringify({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "The plan: two steps." }] }, timestamp: "2026-09-11T08:00:01.000Z", cwd: "/w" }),
      JSON.stringify({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t", name: "AskUserQuestion", input: {} }] }, timestamp: "2026-09-11T08:00:02.000Z", cwd: "/w" }),
    ].join("\n") + "\n",
  );
  const changes = [];
  const events = [];
  server.onChange((p) => changes.push(p));
  server.onSessionEvent((e) => events.push(e));
  return { base, home, server, sockPath, shimPath, env, transcript, changes, events };
}

const askInput = {
  questions: [
    { question: "Approve?", header: "Plan", options: [{ label: "Yes", description: "go" }, { label: "No", description: "stop" }], multiSelect: false },
    { question: "Which parts?", header: "Parts", options: [{ label: "a", description: "" }, { label: "b", description: "" }], multiSelect: true },
  ],
};

test("an AskUserQuestion is held, classified from the run pointer and the transcript, and answered through the shim", async () => {
  const f = await fixture({ executionId: "ex-1", state: "wait", nodeId: "plan-review", agent: "planner", asks: "approval", at: 1 });
  try {
    const run = runShim(f.shimPath, { hook_event_name: "PreToolUse", session_id: "sess-1", cwd: "/w", transcript_path: f.transcript, tool_name: "AskUserQuestion", tool_input: askInput }, f.env);
    await until(() => f.server.pending().length === 1);
    const [p] = f.server.pending();
    assert.equal(p.kind, "approval");
    assert.equal(p.sessionId, "sess-1");
    assert.equal(p.ptyId, "pty-7");
    assert.equal(p.executionId, "ex-1");
    assert.equal(p.nodeId, "plan-review");
    assert.equal(p.cwd, "/w");
    assert.equal(p.context, "The plan: two steps.");
    assert.deepEqual(p.questions, askInput.questions);
    assert.ok(typeof p.askedAt === "number");
    assert.match(p.id, /^[0-9a-f]{16}$/);
    assert.equal(f.changes.length, 1);
    assert.equal(f.events.at(-1)?.kind, "working");
    assert.equal(f.events.at(-1)?.detail, "AskUserQuestion");

    const answer = { answers: { "Approve?": "Yes", "Which parts?": ["a", "b"] } };
    assert.deepEqual(f.server.answer(p.id, answer), { ok: true, value: undefined });
    assert.equal(f.server.pending().length, 0);
    assert.equal(f.changes.length, 2);
    const res = await run;
    assert.equal(res.code, 0);
    const out = JSON.parse(res.stdout);
    assert.deepEqual(out, {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { questions: askInput.questions, answers: answer.answers } },
    });
    assert.ok(res.stdout.endsWith("\n") && !res.stdout.slice(0, -1).includes("\n"), "exactly one line");
    assert.deepEqual(f.server.answer(p.id, answer), { ok: false, error: `no pending ask ${p.id}` });
  } finally {
    await f.server.stop();
  }
});

test("without a run pointer the ask is a plain question with null run fields; a status-role PreToolUse is not held", async () => {
  const f = await fixture(null);
  try {
    const status = await runShim(f.shimPath, { hook_event_name: "PreToolUse", session_id: "sess-1", cwd: "/w", tool_name: "AskUserQuestion", tool_input: askInput }, f.env, [STATUS_ARG]);
    assert.deepEqual(status, { code: 0, stdout: "{}\n" });
    assert.equal(f.server.pending().length, 0);
    assert.equal(f.events.length, 1);

    const run = runShim(f.shimPath, { hook_event_name: "PreToolUse", session_id: "sess-1", cwd: "/w", tool_name: "AskUserQuestion", tool_input: askInput }, f.env);
    await until(() => f.server.pending().length === 1);
    const [p] = f.server.pending();
    assert.equal(p.kind, "question");
    assert.equal(p.executionId, null);
    assert.equal(p.nodeId, null);
    assert.equal(p.context, null, "no transcript path given");
    f.server.answer(p.id, { answers: {}, response: "do it my way" });
    const out = JSON.parse((await run).stdout);
    assert.equal(out.hookSpecificOutput.updatedInput.response, "do it my way");
  } finally {
    await f.server.stop();
  }
});

test("a PermissionRequest is held with a summary and settled allow-always (rules echoed) or deny (message)", async () => {
  const f = await fixture({ executionId: "ex-2", state: "agent", nodeId: "impl", agent: "implementer", asks: null, at: 1 });
  try {
    const suggestions = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "localSettings" }];
    const payload = { hook_event_name: "PermissionRequest", session_id: "sess-1", cwd: "/w", tool_name: "Bash", tool_input: { command: "npm test", description: "run" }, permission_suggestions: suggestions };
    const run = runShim(f.shimPath, payload, f.env);
    await until(() => f.server.pending().length === 1);
    const [p] = f.server.pending();
    assert.equal(p.kind, "permission");
    assert.equal(p.toolName, "Bash");
    assert.equal(p.summary, "npm test");
    assert.equal(p.executionId, "ex-2");
    assert.equal(p.nodeId, "impl");
    assert.deepEqual(p.toolInput, payload.tool_input);
    assert.deepEqual(p.suggestions, suggestions);
    assert.deepEqual(f.server.answer(p.id, { answers: {} }), { ok: false, error: `${p.id} is a permission, not a question` });
    assert.deepEqual(f.server.decide(p.id, { behavior: "allow", always: true }), { ok: true, value: undefined });
    const out = JSON.parse((await run).stdout);
    assert.deepEqual(out, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: payload.tool_input, updatedPermissions: suggestions } } });

    const run2 = runShim(f.shimPath, { ...payload, tool_name: "ExitPlanMode", tool_input: { plan: "## Big plan\nsteps" }, permission_suggestions: undefined }, f.env);
    await until(() => f.server.pending().length === 1);
    const [p2] = f.server.pending();
    assert.equal(p2.summary, "Approve the plan: Big plan");
    assert.deepEqual(p2.suggestions, []);
    f.server.decide(p2.id, { behavior: "allow" });
    const out2 = JSON.parse((await run2).stdout);
    assert.deepEqual(out2.hookSpecificOutput.decision, { behavior: "allow", updatedInput: { plan: "## Big plan\nsteps" } });

    const run3 = runShim(f.shimPath, payload, f.env);
    await until(() => f.server.pending().length === 1);
    const [p3] = f.server.pending();
    f.server.decide(p3.id, { behavior: "deny", message: "not on main" });
    const out3 = JSON.parse((await run3).stdout);
    assert.deepEqual(out3.hookSpecificOutput.decision, { behavior: "deny", message: "not on main" });
    assert.deepEqual(f.server.decide(p3.id, { behavior: "allow" }), { ok: false, error: `no pending permission ${p3.id}` });
  } finally {
    await f.server.stop();
  }
});

test("other events get {} at once and become session events", async () => {
  const f = await fixture(null);
  try {
    const cases = [
      [{ hook_event_name: "SessionStart", source: "startup" }, "start"],
      [{ hook_event_name: "UserPromptSubmit", prompt: "hello\nworld" }, "prompt"],
      [{ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: {} }, "working"],
      [{ hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }, "blocked"],
      [{ hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" }, "waiting"],
      [{ hook_event_name: "Stop", last_assistant_message: "All done." }, "idle"],
      [{ hook_event_name: "SessionEnd", reason: "exit" }, "end"],
    ];
    for (const [p, kind] of cases) {
      const t0 = Date.now();
      const res = await runShim(f.shimPath, { session_id: "sess-1", cwd: "/w", transcript_path: f.transcript, ...p }, f.env);
      assert.deepEqual(res, { code: 0, stdout: "{}\n" }, p.hook_event_name);
      assert.ok(Date.now() - t0 < 2000, `${p.hook_event_name} replied at once`);
      const e = f.events.at(-1);
      assert.equal(e.kind, kind, p.hook_event_name);
      assert.equal(e.sessionId, "sess-1");
      assert.equal(e.ptyId, "pty-7");
      assert.equal(e.transcriptPath, f.transcript);
    }
    assert.equal(f.events.find((e) => e.kind === "prompt").detail, "hello");
    assert.equal(f.events.find((e) => e.kind === "idle").detail, "All done.");
    assert.equal(f.server.pending().length, 0);
    assert.equal(f.changes.length, 0);
  } finally {
    await f.server.stop();
  }
});

test("a client that hangs up before its answer drops its pending item; malformed lines are ignored", async () => {
  const f = await fixture(null);
  try {
    const conn = createConnection(f.sockPath);
    await new Promise((r) => conn.once("connect", r));
    conn.write(JSON.stringify({ v: 1, id: "x", payload: { hook_event_name: "PermissionRequest", session_id: "sess-1", tool_name: "Bash", tool_input: { command: "ls" } } }) + "\n");
    await until(() => f.server.pending().length === 1);
    conn.destroy();
    await until(() => f.server.pending().length === 0);
    assert.equal(f.changes.length, 2);

    const bad = createConnection(f.sockPath);
    await new Promise((r) => bad.once("connect", r));
    let got = "";
    bad.on("data", (d) => (got += d));
    const closed = new Promise((r) => bad.once("close", r));
    bad.write("this is not json\n");
    await closed;
    assert.equal(got, "", "no reply to a malformed frame");
    assert.equal(f.server.pending().length, 0);

    const noPayload = createConnection(f.sockPath);
    await new Promise((r) => noPayload.once("connect", r));
    const closed2 = new Promise((r) => noPayload.once("close", r));
    noPayload.write('{"v":1,"id":"y"}\n');
    await closed2;
    assert.equal(f.server.pending().length, 0);
  } finally {
    await f.server.stop();
  }
});

test("stop() hangs up held shims (which exit 0 silently) and removes the socket file; start() again works", async () => {
  const f = await fixture(null);
  const run = runShim(f.shimPath, { hook_event_name: "PermissionRequest", session_id: "sess-1", tool_name: "Bash", tool_input: { command: "ls" } }, f.env);
  await until(() => f.server.pending().length === 1);
  await f.server.stop();
  assert.deepEqual(await run, { code: 0, stdout: "" });
  assert.equal(f.server.pending().length, 0);
  assert.equal(f.server.listening, false);
  assert.throws(() => statSync(f.sockPath));
  await f.server.start(f.sockPath);
  assert.equal(f.server.listening, true);
  const res = await runShim(f.shimPath, { hook_event_name: "Stop", session_id: "sess-1" }, f.env);
  assert.deepEqual(res, { code: 0, stdout: "{}\n" });
  await f.server.stop();
});
