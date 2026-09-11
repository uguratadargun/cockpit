import "./_ts.mjs";

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

const gate = await import("../src/main/gate.ts");
const { GateClient, GateApiError, encodeConnectToken, parseConnectInput, readConnection, writeConnection } = gate;

const KEY = `gate_${"ab".repeat(24)}`;

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("parseConnectInput", () => {
  test("decodes a gatec_ token to url and key, trailing slash dropped", () => {
    const token = encodeConnectToken({ url: "https://gate.example.com/", key: KEY });
    assert.ok(token.startsWith("gatec_"));
    assert.deepEqual(parseConnectInput(`  ${token}\n`), { url: "https://gate.example.com", key: KEY });
  });

  test("decodes the same encoding the dashboard produces (base64url of {u,k})", () => {
    const token = "gatec_" + Buffer.from(JSON.stringify({ u: "http://10.0.80.35:4141", k: KEY })).toString("base64url");
    assert.deepEqual(parseConnectInput(token), { url: "http://10.0.80.35:4141", key: KEY });
  });

  test("a bare gate_ key is refused with a pointer to the token", () => {
    const r = parseConnectInput(KEY);
    assert.ok("error" in r);
    assert.match(r.error, /API key, not a connection token/);
    assert.match(r.error, /gatec_/);
  });

  test("an address and a key together are accepted in either order", () => {
    assert.deepEqual(parseConnectInput(`https://g.example.com/ ${KEY}`), { url: "https://g.example.com", key: KEY });
    assert.deepEqual(parseConnectInput(`${KEY}\nhttps://g.example.com`), { url: "https://g.example.com", key: KEY });
  });

  test("damaged and empty tokens say what is wrong", () => {
    assert.match(parseConnectInput("gatec_!!!").error, /damaged/);
    assert.match(parseConnectInput("gatec_" + Buffer.from('{"u":"ftp://x","k":"y"}').toString("base64url")).error, /not an http/);
    assert.match(parseConnectInput("gatec_" + Buffer.from('{"u":"http://x"}').toString("base64url")).error, /missing/);
    assert.match(parseConnectInput("").error, /paste/);
    assert.match(parseConnectInput("hello").error, /does not look like/);
    assert.match(parseConnectInput("https://only.example.com").error, /only the gate's address/);
  });
});

describe("connection file", () => {
  let home;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cockpit-gate-"));
  });
  after(() => rmSync(home, { recursive: true, force: true }));

  test("readConnection: null without a file, env wins over the file", () => {
    withEnv({ GATE_HOME: home, GATE_URL: undefined, GATE_KEY: undefined }, () => {
      assert.equal(readConnection(), null);
      writeConnection({ url: "http://file.example/", key: "gate_file" });
      assert.deepEqual(readConnection(), { url: "http://file.example", key: "gate_file" });
    });
    withEnv({ GATE_HOME: home, GATE_URL: "http://env.example/", GATE_KEY: "gate_env" }, () => {
      assert.deepEqual(readConnection(), { url: "http://env.example", key: "gate_env" });
    });
  });

  test("writeConnection keeps the file's other keys, is 0600, drops fromEnv", () => {
    withEnv({ GATE_HOME: home, GATE_URL: undefined, GATE_KEY: undefined }, () => {
      mkdirSync(home, { recursive: true });
      const file = join(home, "client.json");
      writeFileSync(file, JSON.stringify({ url: "http://old", key: "gate_old", team: "desktop", trusted: { dev: "abc" }, fromEnv: true }));
      writeConnection({ url: "http://new/", key: "gate_new" }, { team: "ulak" });
      const raw = JSON.parse(readFileSync(file, "utf8"));
      assert.deepEqual(raw, { url: "http://new", key: "gate_new", team: "ulak", trusted: { dev: "abc" } });
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(gate.readConnectedTeam(), "ulak");
    });
  });
});

describe("GateClient", () => {
  let server;
  let url;
  let seen;
  let streamConnections = 0;
  let streamScript = [];

  before(async () => {
    server = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, headers: req.headers });
      const send = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: "no API key", code: "NO_API_KEY" });
      if (req.url === "/api/v1/me") {
        return send(200, {
          user: { id: "u1", email: "ugur@example.com", name: "Ugur" },
          team: { id: "desktop", name: "Desktop" },
          scopes: ["workflows"],
          gatewayUrl: `${url}/api/gateway`,
          server: { version: "0.34.0", minClientVersion: "0.13.0" },
        });
      }
      if (req.url === "/api/v1/executions?limit=5") return send(200, { executions: [{ id: "e1", workflowId: "dev", status: "running" }] });
      if (req.url === "/api/v1/executions/e1") return send(200, { execution: { id: "e1" }, steps: [{ stepIndex: 0 }] });
      if (req.url === "/api/v1/executions/e1/cancel" && req.method === "POST") return send(200, { requested: true });
      if (req.url === "/api/v1/executions/e2/cancel" && req.method === "POST") return send(200, { requested: false, reason: "run already completed" });
      if (req.url === "/api/v1/executions/nope" || req.url === "/api/v1/executions/nope/cancel") return send(404, { error: "no such run" });
      if (req.url === "/html") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end("<html>sign in</html>");
      }
      if (req.url === "/api/v1/executions/stream") {
        streamConnections++;
        const script = streamScript.shift() ?? [];
        res.writeHead(200, { "content-type": "text/event-stream" });
        let i = 0;
        const tick = () => {
          if (i >= script.length) return res.end();
          res.write(script[i++]);
          setTimeout(tick, 5);
        };
        tick();
        return;
      }
      send(404, { error: "not found" });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  beforeEach(() => {
    seen = [];
  });
  after(() => server.close());

  test("me() maps the server's answer and sends the key without an x-gate-cli header", async () => {
    const me = await new GateClient({ url, key: KEY }).me();
    assert.deepEqual(me, { person: "Ugur", email: "ugur@example.com", team: "Desktop", teamId: "desktop", version: "0.34.0", scopes: ["workflows"] });
    assert.equal(seen[0].headers.authorization, `Bearer ${KEY}`);
    assert.ok(seen[0].headers["x-gate-host"]);
    assert.equal(seen[0].headers["x-gate-cli"], undefined);
  });

  test("executions(), execution(), cancel()", async () => {
    const c = new GateClient({ url, key: KEY });
    assert.deepEqual(await c.executions(5), [{ id: "e1", workflowId: "dev", status: "running" }]);
    assert.deepEqual(await c.execution("e1"), { execution: { id: "e1" }, steps: [{ stepIndex: 0 }] });
    assert.deepEqual(await c.cancel("e1"), { ok: true, value: undefined });
    assert.deepEqual(await c.cancel("e2"), { ok: false, error: "run already completed" });
    assert.deepEqual(await c.cancel("nope"), { ok: false, error: "no such run" });
  });

  test("errors carry the server's words, status and code", async () => {
    await assert.rejects(new GateClient({ url, key: "gate_wrong" }).me(), (e) => e instanceof GateApiError && e.status === 401 && e.code === "NO_API_KEY" && e.message === "no API key");
    await assert.rejects(new GateClient({ url, key: KEY }).execution("nope"), (e) => e.status === 404 && e.message === "no such run");
    const c = new GateClient({ url: "http://127.0.0.1:1", key: KEY });
    await assert.rejects(c.me(), (e) => e instanceof GateApiError && e.code === "UNREACHABLE" && /cannot reach gate/.test(e.message));
  });

  test("stream: parses data frames, skips heartbeats, reconnects, stops on abort", async () => {
    const snapshot = { type: "snapshot", at: 1, executions: [{ id: "e1" }] };
    const ev = { type: "node.started", executionId: "e1", at: 2, nodeId: "planner", stepIndex: 0, visit: 1 };
    const ev2 = { type: "run.paused", executionId: "e1", at: 3, nodeId: "planner" };
    streamScript = [
      [`data: ${JSON.stringify(snapshot)}\n\n`, ": hb\n\n", `data: ${JSON.stringify(ev).slice(0, 20)}`, `${JSON.stringify(ev).slice(20)}\n\n`],
      [`data: ${JSON.stringify(ev2)}\n\n`],
    ];
    streamConnections = 0;
    const frames = [];
    const states = [];
    const ac = new AbortController();
    const c = new GateClient({ url, key: KEY });
    c.stream((f) => frames.push(f), ac.signal, { minBackoffMs: 20, maxBackoffMs: 40, onState: (s) => states.push(s) });
    const until = async (pred, ms = 3000) => {
      const t0 = Date.now();
      while (!pred()) {
        if (Date.now() - t0 > ms) throw new Error("timed out waiting");
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    await until(() => frames.length >= 3);
    assert.deepEqual(frames, [snapshot, ev, ev2]);
    assert.ok(streamConnections >= 2, "reconnected after the stream ended");
    assert.deepEqual(states[0], { connected: true });
    assert.ok(states.some((s) => s.connected === false));
    ac.abort();
    const at = streamConnections;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(streamConnections, at, "no connections after abort");
    assert.equal(frames.length, 3);
  });

  test("a web page instead of JSON is reported as not a gate", async () => {
    const html = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>sign in</html>");
    });
    await new Promise((r) => html.listen(0, "127.0.0.1", r));
    try {
      const c = new GateClient({ url: `http://127.0.0.1:${html.address().port}`, key: KEY });
      await assert.rejects(c.me(), (e) => e instanceof GateApiError && e.code === "NOT_A_GATE" && /web page/.test(e.message));
    } finally {
      html.close();
    }
  });
});
