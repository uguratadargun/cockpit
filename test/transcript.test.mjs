// The transcript reader against Claude Code's JSONL shape (node:test, no Electron).
import "./_tmp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
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

const mod = await load("src/main/transcript.ts");
const { readTranscriptSummary, WHOLE_READ_LIMIT } = mod;

const CWD = "/Users/someone/proj";
const line = (o) => JSON.stringify(o);
const user = (content, extra = {}) => line({ type: "user", message: { role: "user", content }, timestamp: "2026-09-11T08:00:00.000Z", cwd: CWD, ...extra });
const assistant = (content, id, ts = "2026-09-11T08:00:05.000Z") => line({ type: "assistant", message: { id, role: "assistant", content }, timestamp: ts, cwd: CWD });

function write(lines) {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-transcript-"));
  const path = join(dir, "s.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

test("a missing file yields all-null", () => {
  assert.deepEqual(readTranscriptSummary("/nonexistent/x.jsonl"), { title: null, lastAssistantText: null, lastAt: null, cwd: null });
});

test("title is the first real prompt: command noise, meta lines and tool results are skipped", () => {
  const path = write([
    line({ type: "mode", mode: "normal" }),
    user("<local-command-caveat>Caveat: ...</local-command-caveat>", { isMeta: true }),
    user("<command-name>/clear</command-name>\n<command-message>clear</command-message>"),
    line({ type: "system", subtype: "local_command", content: "x" }),
    user([{ type: "tool_result", tool_use_id: "t1", content: "not a prompt" }]),
    user("<system-reminder>ignore me</system-reminder>\n\n  Fix the login bug  \nsecond line"),
    assistant([{ type: "text", text: "Looking." }], "m1"),
  ]);
  const s = readTranscriptSummary(path);
  assert.equal(s.title, "Fix the login bug");
  assert.equal(s.cwd, CWD);
});

test("title is cut to 80 characters and comes from array text blocks too", () => {
  const long = "x".repeat(100);
  const s = readTranscriptSummary(write([user([{ type: "text", text: long }])]));
  assert.equal(s.title.length, 80);
  assert.ok(s.title.endsWith("…"));
});

test("lastAssistantText joins the text blocks of the last text-bearing message, across split lines of one id", () => {
  const path = write([
    user("hi"),
    assistant([{ type: "text", text: "old answer" }], "m1"),
    assistant([{ type: "text", text: "Here is the plan." }], "m2", "2026-09-11T09:00:00.000Z"),
    assistant([{ type: "text", text: "Step one, step two." }], "m2", "2026-09-11T09:00:01.000Z"),
    assistant([{ type: "tool_use", id: "t", name: "AskUserQuestion", input: {} }], "m2", "2026-09-11T09:00:02.000Z"),
    line({ type: "attachment", attachment: { type: "hook_success" } }),
    user([{ type: "tool_result", tool_use_id: "t", content: "ok" }], { timestamp: "2026-09-11T09:00:03.000Z" }),
  ]);
  const s = readTranscriptSummary(path);
  assert.equal(s.title, "hi");
  assert.equal(s.lastAssistantText, "Here is the plan.\nStep one, step two.");
  assert.equal(s.lastAt, Date.parse("2026-09-11T09:00:03.000Z"));
});

test("a tool-only assistant message after the text does not erase the text; a later text message replaces it", () => {
  const path = write([
    user("go"),
    assistant([{ type: "text", text: "first" }], "m1"),
    assistant([{ type: "tool_use", id: "t", name: "Bash", input: {} }], "m2"),
  ]);
  assert.equal(readTranscriptSummary(path).lastAssistantText, "first");
  const path2 = write([
    user("go"),
    assistant([{ type: "text", text: "first" }], "m1"),
    assistant([{ type: "tool_use", id: "t", name: "Bash", input: {} }], "m2"),
    assistant("plain string reply", "m3"),
  ]);
  assert.equal(readTranscriptSummary(path2).lastAssistantText, "plain string reply");
});

test("malformed lines are ignored", () => {
  const path = write([user("ok"), "{not json", "", assistant([{ type: "text", text: "done" }], "m1")]);
  const s = readTranscriptSummary(path);
  assert.equal(s.title, "ok");
  assert.equal(s.lastAssistantText, "done");
});

test("a file over the whole-read limit still yields the title from its head and the last text from its tail", () => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-big-"));
  const path = join(dir, "big.jsonl");
  const filler = assistant([{ type: "tool_use", id: "t", name: "Bash", input: { command: "x".repeat(4000) } }], "mf");
  const chunks = [user("the very first prompt")];
  let size = 0;
  while (size < WHOLE_READ_LIMIT + 1024 * 1024) {
    chunks.push(filler);
    size += filler.length + 1;
  }
  chunks.push(assistant([{ type: "text", text: "the last word" }], "mz", "2026-09-11T10:00:00.000Z"));
  writeFileSync(path, chunks.join("\n") + "\n");
  const s = readTranscriptSummary(path);
  assert.equal(s.title, "the very first prompt");
  assert.equal(s.lastAssistantText, "the last word");
  assert.equal(s.lastAt, Date.parse("2026-09-11T10:00:00.000Z"));
});
