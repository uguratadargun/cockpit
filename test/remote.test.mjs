import "./_ts.mjs";

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const { GateClient, REMOTE_UNSUPPORTED } = await import("../src/main/gate.ts");
const { InputQueue, RemoteHub, RepoPaths, handleForPtyId, isRemotePtyId, matchRepo, normalizeGitUrl, ptyIdForHandle, tail } = await import(
  "../src/main/remote.ts"
);

const KEY = `gate_${"cd".repeat(24)}`;

const until = async (pred, ms = 3000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("normalizeGitUrl / matchRepo", () => {
  test("scp, https and ssh forms of one remote read the same", () => {
    const want = "github.com/org/thing";
    for (const url of [
      "git@github.com:org/thing.git",
      "git@github.com:Org/Thing",
      "https://github.com/org/thing",
      "https://user:tok@github.com/org/thing.git/",
      "ssh://git@github.com:22/org/thing.git",
      "  git+ssh://git@github.com/org/thing.git\n",
    ]) {
      assert.equal(normalizeGitUrl(url), want, url);
    }
  });

  test("paths and nothing are not remotes", () => {
    assert.equal(normalizeGitUrl(""), null);
    assert.equal(normalizeGitUrl(null), null);
    assert.equal(normalizeGitUrl("/srv/repos/thing"), null);
    assert.equal(normalizeGitUrl("C:\\repos\\thing"), null);
    assert.equal(normalizeGitUrl("file:///srv/thing.git"), null);
  });

  test("matchRepo picks the connected repo with the same source, else null", () => {
    const repos = [
      { id: "web", name: "web", source: "https://gitlab.example.com/team/web.git", status: "ready" },
      { id: "api", name: "api", source: "git@gitlab.example.com:team/api.git", status: "ready" },
      { id: "local", name: "local", source: "/srv/checkout", status: "ready" },
    ];
    assert.equal(matchRepo("git@gitlab.example.com:team/web.git", repos)?.id, "web");
    assert.equal(matchRepo("https://gitlab.example.com/team/api", repos)?.id, "api");
    assert.equal(matchRepo("https://gitlab.example.com/team/other", repos), null);
    assert.equal(matchRepo(null, repos), null);
  });
});

describe("terminal ids and repo paths", () => {
  test("a remote terminal is its handle behind r-", () => {
    assert.equal(ptyIdForHandle("h1"), "r-h1");
    assert.equal(isRemotePtyId("r-h1"), true);
    assert.equal(isRemotePtyId("t123"), false);
    assert.equal(handleForPtyId("r-h1"), "h1");
    assert.equal(handleForPtyId("t123"), null);
    assert.equal(tail("abcdef", 3), "def");
  });

  test("RepoPaths remembers a repo's project across instances, with a gate: fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "cockpit-remote-"));
    const a = RepoPaths.in(dir);
    assert.equal(a.cwdFor("web"), "gate:web");
    assert.equal(a.cwdFor(null), "gate:server");
    a.set("web", "/Users/me/web");
    assert.equal(RepoPaths.in(dir).cwdFor("web"), "/Users/me/web");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "remote-projects.json"), "utf8")), { web: "/Users/me/web" });
  });
});

describe("InputQueue", () => {
  test("batches what is typed together and keeps order across in-flight sends", async () => {
    const sent = [];
    let release;
    const q = new InputQueue(async (key, data) => {
      sent.push([key, data]);
      if (data === "ab") await new Promise((r) => (release = r));
    }, 5);
    q.push("t", "a");
    q.push("t", "b");
    await until(() => sent.length === 1);
    assert.deepEqual(sent, [["t", "ab"]]);
    // Typed while "ab" is out: waits for it, then goes together.
    q.push("t", "c");
    q.push("t", "d");
    q.push("u", "x");
    await until(() => sent.length === 2);
    assert.deepEqual(sent[1], ["u", "x"], "another terminal does not wait");
    release();
    await q.drain("t");
    assert.deepEqual(sent, [["t", "ab"], ["u", "x"], ["t", "cd"]]);
  });

  test("a failed send is reported and the queue carries on", async () => {
    const sent = [];
    const errors = [];
    const q = new InputQueue(
      async (_key, data) => {
        sent.push(data);
        if (data === "1") throw new Error("gone");
      },
      2,
      (key, e) => errors.push([key, e.message]),
    );
    q.push("t", "1");
    await q.drain("t");
    q.push("t", "2");
    await q.drain("t");
    assert.deepEqual(sent, ["1", "2"]);
    assert.deepEqual(errors, [["t", "gone"]]);
  });
});

describe("GateClient remote methods", () => {
  let server;
  let url;
  let seen = [];
  let remoteRoute = true;
  let script = [];

  before(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null, headers: req.headers });
        const send = (status, body) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: "no API key" });
        if (req.url === "/api/v1/remote") {
          if (!remoteRoute) return send(404, { error: "not found" });
          return send(200, { allowed: true, available: false, reason: "node-pty is not installed", repos: [{ id: "web", name: "web", source: "x", status: "ready" }] });
        }
        if (req.url === "/api/v1/remote/sessions" && req.method === "POST") {
          const b = seen.at(-1).body;
          return send(201, { session: { id: b.resume ?? "remote:h1", handle: "h1", repo: b.repo ?? "web", cwd: "/srv/web", presence: "live", status: "idle" } });
        }
        if (req.url === "/api/v1/remote/terminals/h1/input" && req.method === "POST") return send(200, { ok: true });
        if (req.url === "/api/v1/remote/terminals/h1" && req.method === "DELETE") return send(200, { ok: true });
        if (req.url === "/api/v1/remote/asks/q1" && req.method === "POST") return send(200, { ok: true });
        if (req.url === "/api/v1/remote/asks/nope" && req.method === "POST") return send(404, { error: "no pending ask nope" });
        if (req.url === "/api/v1/remote/executions/e1/changes") return send(200, { files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0, binary: false, untracked: false }] });
        if (req.url === "/api/v1/remote/executions/e1/diff" && req.method === "POST") return send(200, { diff: `diff for ${seen.at(-1).body.file.path}` });
        if (req.url === "/api/v1/remote/stream") {
          const frames = script.shift() ?? [];
          res.writeHead(200, { "content-type": "text/event-stream" });
          let i = 0;
          const tick = () => {
            if (i >= frames.length) return; // held open, like the server
            res.write(frames[i++]);
            setTimeout(tick, 5);
          };
          tick();
          return;
        }
        send(404, { error: "not found" });
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.closeAllConnections?.() ?? server.close());

  test("remoteInfo reads the answer, and a gate without the route is read as unsupported", async () => {
    const c = new GateClient({ url, key: KEY });
    remoteRoute = true;
    assert.deepEqual(await c.remoteInfo(), {
      allowed: true,
      available: false,
      reason: "node-pty is not installed",
      repos: [{ id: "web", name: "web", source: "x", status: "ready" }],
    });
    remoteRoute = false;
    assert.deepEqual(await c.remoteInfo(), REMOTE_UNSUPPORTED);
    remoteRoute = true;
  });

  test("start, resume, input, close, answer, changes and diff", async () => {
    const c = new GateClient({ url, key: KEY });
    seen = [];
    const s = await c.remoteStart({ repo: "web", prompt: "/gate:run dev x" });
    assert.equal(s.handle, "h1");
    assert.deepEqual(seen[0].body, { repo: "web", prompt: "/gate:run dev x" });
    assert.equal((await c.remoteResume("sess-9")).id, "sess-9");
    assert.deepEqual(seen[1].body, { resume: "sess-9" });
    await c.remoteInput("h1", "ls\r");
    assert.deepEqual(seen[2].body, { data: "ls\r" });
    await c.remoteClose("h1");
    assert.equal(seen[3].method, "DELETE");
    assert.deepEqual(await c.remoteAnswer("q1", { answers: { "Which?": "A" } }), { ok: true, value: undefined });
    assert.deepEqual(seen[4].body, { answer: { answers: { "Which?": "A" } } });
    assert.deepEqual(await c.remoteDecide("nope", { behavior: "allow" }), { ok: false, error: "no pending ask nope" });
    const changes = await c.remoteChanges("e1");
    assert.ok(changes.ok);
    assert.equal(changes.value[0].path, "a.ts");
    assert.deepEqual(await c.remoteFileDiff("e1", changes.value[0]), { ok: true, value: "diff for a.ts" });
  });

  test("remoteStream parses hello, screen and data frames and skips heartbeats", async () => {
    const hello = { type: "hello", at: 1, sessions: [{ id: "s1", handle: "h1" }], pending: [] };
    const screen = { type: "screen", handle: "h1", data: "\x1b[2Jprompt> " };
    const data = { type: "data", handle: "h1", data: "hi\r\n" };
    const text = JSON.stringify(data);
    script = [[`data: ${JSON.stringify(hello)}\n\n`, ": hb\n\n", `data: ${JSON.stringify(screen)}\n\n`, `data: ${text.slice(0, 10)}`, `${text.slice(10)}\n\n`]];
    const frames = [];
    const ac = new AbortController();
    new GateClient({ url, key: KEY }).remoteStream((f) => frames.push(f), ac.signal, { minBackoffMs: 20 });
    await until(() => frames.length >= 3);
    ac.abort();
    assert.deepEqual(frames, [hello, screen, data]);
  });
});

describe("RemoteHub", () => {
  const session = (over = {}) => ({
    id: "s1",
    handle: "h1",
    repo: "web",
    cwd: "/srv/repos/web",
    title: "fix it",
    startedAt: 1,
    lastActiveAt: 2,
    presence: "live",
    status: "idle",
    run: null,
    ...over,
  });

  function makeHub() {
    const dir = mkdtempSync(join(tmpdir(), "cockpit-hub-"));
    const paths = RepoPaths.in(dir);
    paths.set("web", "/Users/me/web");
    const log = { data: [], exit: [], sessions: 0, pending: 0 };
    const calls = [];
    const client = {
      remoteStream: () => {},
      remoteStart: async (o) => (calls.push(["start", o]), session({ id: "remote:h2", handle: "h2", repo: o.repo })),
      remoteResume: async (id) => (calls.push(["resume", id]), session({ id, handle: "h3" })),
      remoteInput: async (h, d) => void calls.push(["input", h, d]),
      remoteResize: async (h, c, r) => void calls.push(["resize", h, c, r]),
      remoteRedraw: async (h) => void calls.push(["redraw", h]),
      remoteClose: async (h) => void calls.push(["close", h]),
      remoteAnswer: async (id) => (calls.push(["answer", id]), { ok: true, value: undefined }),
      remoteDecide: async (id) => (calls.push(["decide", id]), { ok: true, value: undefined }),
    };
    const hub = new RemoteHub(
      paths,
      {
        sessions: () => log.sessions++,
        pending: () => log.pending++,
        data: (ptyId, d) => log.data.push([ptyId, d]),
        exit: (ptyId, code) => log.exit.push([ptyId, code]),
      },
      { inputDelayMs: 2 },
    );
    hub.connect(client);
    return { hub, log, calls };
  }

  test("buffers a terminal until the renderer draws it, then pushes live", async () => {
    const { hub, log, calls } = makeHub();
    hub.onFrame({ type: "hello", at: 1, sessions: [session()], pending: [] });
    hub.onFrame({ type: "screen", handle: "h1", data: "screen;" });
    hub.onFrame({ type: "data", handle: "h1", data: "more;" });
    assert.deepEqual(log.data, [], "nothing pushed before the renderer draws");
    hub.redraw("r-h1");
    assert.deepEqual(log.data, [["r-h1", "screen;more;"]]);
    await until(() => calls.some((c) => c[0] === "redraw"));
    hub.onFrame({ type: "data", handle: "h1", data: "live" });
    assert.deepEqual(log.data.at(-1), ["r-h1", "live"]);
    hub.redraw("r-h1");
    assert.equal(log.data.length, 2, "the buffer is replayed once");
    // A reconnect's screen for a drawn terminal resets it first.
    hub.onFrame({ type: "screen", handle: "h1", data: "fresh" });
    assert.deepEqual(log.data.at(-1), ["r-h1", "\x1bcfresh"]);
    hub.onFrame({ type: "exit", handle: "h1", code: 0 });
    assert.deepEqual(log.exit, [["r-h1", 0]]);
    assert.equal(hub.claudeSessions()[0].presence, "asleep");
  });

  test("maps sessions and pending into the window's words", () => {
    const { hub } = makeHub();
    hub.onFrame({
      type: "hello",
      at: 1,
      sessions: [session({ run: { executionId: "e1", state: "agent", nodeId: "plan", agent: null, asks: null, at: 1 } }), session({ id: "s2", handle: null, presence: "asleep", repo: "api" })],
      pending: [
        { id: "q1", kind: "question", sessionId: "s1", handle: "h1", repo: "web", executionId: "e1", nodeId: "clarify", cwd: "/srv/repos/web", questions: [], context: null, askedAt: 5 },
      ],
    });
    const [live, asleep] = hub.claudeSessions();
    assert.deepEqual(
      { ptyId: live.ptyId, cwd: live.cwd, location: live.location, repo: live.repo, presence: live.presence },
      { ptyId: "r-h1", cwd: "/Users/me/web", location: "remote", repo: "web", presence: "live" },
    );
    assert.deepEqual({ ptyId: asleep.ptyId, cwd: asleep.cwd, presence: asleep.presence }, { ptyId: null, cwd: "gate:api", presence: "asleep" });
    const [p] = hub.pendingItems();
    assert.equal(p.ptyId, "r-h1");
    assert.equal(p.location, "remote");
    assert.equal(p.cwd, "/Users/me/web");
    assert.equal("handle" in p, false);
    assert.equal(hub.isPending("q1"), true);
    assert.equal(hub.sessionForExecution("e1")?.id, "s1");
    assert.equal(hub.sessionForExecution("e9", "s2")?.id, "s2");
    assert.equal(hub.sessionForExecution("e9", null), null);
  });

  test("start remembers the project, write coalesces, close and answer route to the server", async () => {
    const { hub, calls, log } = makeHub();
    const r = await hub.start("api", "/Users/me/api", "/gate:run dev x");
    assert.deepEqual(r, { ok: true, value: { ptyId: "r-h2" } });
    assert.deepEqual(calls[0], ["start", { repo: "api", prompt: "/gate:run dev x" }]);
    assert.equal(hub.claudeSessions()[0].cwd, "/Users/me/api");
    assert.deepEqual(hub.write("r-h2", "a"), { ok: true });
    hub.write("r-h2", "b");
    assert.deepEqual(hub.write("t-local", "x"), { ok: false });
    await until(() => calls.some((c) => c[0] === "input"));
    assert.deepEqual(calls.filter((c) => c[0] === "input"), [["input", "h2", "ab"]]);
    await hub.close("r-h2");
    assert.ok(calls.some((c) => c[0] === "close" && c[1] === "h2"));
    hub.onFrame({ type: "pending", at: 2, pending: [{ id: "q2", kind: "permission", sessionId: "s1", handle: "h1", repo: "web", executionId: null, nodeId: null, cwd: "", toolName: "Bash", toolInput: {}, summary: "ls", suggestions: [], askedAt: 1 }] });
    const before = log.pending;
    assert.deepEqual(await hub.decide("q2", { behavior: "allow" }), { ok: true, value: undefined });
    assert.equal(hub.isPending("q2"), false);
    assert.equal(log.pending, before + 1);
    assert.deepEqual((await hub.resume("sess-7")).value, { ptyId: "r-h3" });
  });
});
