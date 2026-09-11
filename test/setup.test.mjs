import "./_ts.mjs";

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

const { PLUGIN_ID, PLUGIN_MARKETPLACE, findClaude, installPlugin, isNewer, pluginStatus, setupStatus } = await import("../src/main/setup.ts");

describe("setup", () => {
  let root;
  let bin;
  let config;
  let saved;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cockpit-setup-"));
    bin = join(root, "bin");
    config = join(root, "claude");
    mkdirSync(bin);
    mkdirSync(join(config, "plugins"), { recursive: true });
    saved = { GATE_HOME: process.env.GATE_HOME, GATE_URL: process.env.GATE_URL, GATE_KEY: process.env.GATE_KEY, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
    process.env.GATE_HOME = join(root, "gate");
    delete process.env.GATE_URL;
    delete process.env.GATE_KEY;
    delete process.env.CLAUDE_CONFIG_DIR;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  /** A stand-in `claude` on PATH: `--version` prints like the real one; plugin commands are logged, and fail on demand. */
  const fakeClaude = (body) => {
    const path = join(bin, "claude");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const env = () => ({ PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: config, HOME: root });

  test("findClaude: the first claude on the given PATH and its version", () => {
    const path = fakeClaude('[ "$1" = "--version" ] && echo "2.1.266 (Claude Code)"');
    assert.deepEqual(findClaude(env()), { path, version: "2.1.266" });
  });

  test("findClaude: null when PATH has none, or when it fails to run", () => {
    assert.equal(findClaude({ PATH: "/nonexistent" }), null);
    fakeClaude("exit 1");
    assert.equal(findClaude(env()), null);
  });

  test("pluginStatus reads installed_plugins.json and the install's own plugin.json", () => {
    assert.deepEqual(pluginStatus(env()), { installed: false, version: null, latest: null, updateAvailable: false });
    const installPath = join(config, "plugins", "cache", "gateway", "gate", "0.33.0");
    mkdirSync(join(installPath, ".claude-plugin"), { recursive: true });
    writeFileSync(join(installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "gate", version: "0.33.1" }));
    writeFileSync(
      join(config, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "context7@claude-plugins-official": [{ scope: "user", installPath: "/nowhere", version: "1" }],
          [PLUGIN_ID]: [{ scope: "user", installPath, version: "0.33.0", installedAt: "2026-09-09T12:02:27.842Z" }],
        },
      }),
    );
    assert.deepEqual(pluginStatus(env()), { installed: true, version: "0.33.1", latest: null, updateAvailable: false });
    // An entry whose install directory is gone is not an install.
    writeFileSync(join(config, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { [PLUGIN_ID]: [{ scope: "user", installPath: join(root, "gone"), version: "0.1.0" }] } }));
    assert.deepEqual(pluginStatus(env()), { installed: false, version: null, latest: null, updateAvailable: false });
    // No installPath recorded: the version stands on its own.
    writeFileSync(join(config, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { [PLUGIN_ID]: [{ scope: "user", version: "0.9.0" }] } }));
    assert.deepEqual(pluginStatus(env()), { installed: true, version: "0.9.0", latest: null, updateAvailable: false });
  });

  test("installPlugin runs marketplace add then install --yes, non-interactively", async () => {
    const log = join(root, "calls.log");
    fakeClaude(`echo "$@" >> "${log}"; [ -t 0 ] && echo "stdin is a tty" >> "${log}"; exit 0`);
    const r = await installPlugin(env());
    assert.deepEqual(r, { ok: true, value: undefined });
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      `plugin marketplace add ${PLUGIN_MARKETPLACE}`,
      `plugin install ${PLUGIN_ID} --yes`,
    ]);
  });

  test("installPlugin skips marketplace add when the marketplace is already known", async () => {
    const log = join(root, "calls.log");
    writeFileSync(join(config, "plugins", "known_marketplaces.json"), JSON.stringify({ gateway: { source: { source: "git", url: "git@mirror:ai/ai.git" } } }));
    fakeClaude(`echo "$@" >> "${log}"; exit 0`);
    assert.equal((await installPlugin(env())).ok, true);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [`plugin install ${PLUGIN_ID} --yes`]);
  });

  test("installPlugin reports stderr on failure, and a missing claude", async () => {
    fakeClaude('echo "some progress"; echo "fatal: could not read from remote repository" >&2; exit 128');
    const r = await installPlugin(env());
    assert.equal(r.ok, false);
    assert.match(r.error, /claude plugin marketplace add .* failed \(exit 128\)/);
    assert.match(r.error, /could not read from remote repository/);
    const none = await installPlugin({ PATH: "/nonexistent" });
    assert.equal(none.ok, false);
    assert.match(none.error, /claude was not found/);
  });

  test("setupStatus: not connected without a login; an unreachable gate keeps its url", async () => {
    fakeClaude('echo "2.1.266 (Claude Code)"');
    const s1 = await setupStatus(env());
    assert.deepEqual(s1, {
      claude: { found: true, version: "2.1.266", path: join(bin, "claude") },
      plugin: { installed: false, version: null, latest: null, updateAvailable: false },
      gate: { connected: false, url: null, person: null, team: null, version: null, live: false },
    });
    process.env.GATE_URL = "http://127.0.0.1:1";
    process.env.GATE_KEY = "gate_x";
    const s2 = await setupStatus(env());
    assert.deepEqual(s2.gate, { connected: false, url: "http://127.0.0.1:1", person: null, team: null, version: null, live: false });
  });
});

test("isNewer: dotted numbers, missing parts as zero, garbage never newer", () => {
  assert.equal(isNewer("0.34.0", "0.33.0"), true);
  assert.equal(isNewer("0.33.0", "0.34.0"), false);
  assert.equal(isNewer("0.34", "0.34.0"), false);
  assert.equal(isNewer("1.0.0", "0.99.9"), true);
  assert.equal(isNewer(null, "0.1.0"), false);
  assert.equal(isNewer("dev", "0.1.0"), false);
});
