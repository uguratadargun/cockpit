import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import type { Result, SetupStatus } from "../shared/types";
import { GateClient, readConnection } from "./gate";

/**
 * First run: is Claude Code here, is the gate plugin in it, is this machine
 * logged in to a gate.
 *
 * Everything takes the environment it should look in rather than reading
 * process.env: an app launched from the Dock has the PATH of launchd, not
 * of the person's shell, and main is the one that knows how to get the
 * login shell's. The plugin is read from Claude Code's own records instead
 * of `claude plugin list`, which is slower and prints for people.
 */

/** Where the plugin comes from — src/lib/protocol.ts in the gate repository. */
export const PLUGIN_MARKETPLACE = "uguratadargun/gateway";
export const PLUGIN_ID = "gate@gateway";
/** The marketplace's own name: what `known_marketplaces.json` keys it by. */
export const PLUGIN_MARKETPLACE_NAME = PLUGIN_ID.split("@")[1];

export function claudeConfigDirFor(env: Record<string, string>): string {
  return env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first `claude` on the environment's PATH, or a full path named in CLAUDE_PATH. */
export function resolveClaudePath(env: Record<string, string>): string | null {
  if (env.CLAUDE_PATH && isExecutable(env.CLAUDE_PATH)) return env.CLAUDE_PATH;
  const path = env.PATH ?? process.env.PATH ?? "";
  const names = process.platform === "win32" ? ["claude.cmd", "claude.exe", "claude"] : ["claude"];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate) && isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** `claude --version` prints e.g. `2.1.266 (Claude Code)`. */
export function findClaude(env: Record<string, string>): { path: string; version: string } | null {
  const path = resolveClaudePath(env);
  if (!path) return null;
  const res = spawnSync(path, ["--version"], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error || res.status !== 0) return null;
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const match = out.match(/(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/);
  return { path, version: match ? match[1] : out.trim().split("\n")[0] || "unknown" };
}

interface InstalledEntry {
  scope?: string;
  installPath?: string;
  version?: string;
}

/**
 * Whether the gate plugin is installed for this person.
 *
 * <configDir>/plugins/installed_plugins.json (version 2) keys plugins by
 * `<id>@<marketplace>`, each holding a list of installs with `scope`,
 * `installPath` and `version`; the install itself lives under
 * plugins/cache/<marketplace>/<plugin>/<version>/ with a .claude-plugin/plugin.json.
 */
export function pluginStatus(env: Record<string, string>): SetupStatus["plugin"] {
  const pluginsDir = join(claudeConfigDirFor(env), "plugins");
  let entries: InstalledEntry[] = [];
  try {
    const raw = JSON.parse(readFileSync(join(pluginsDir, "installed_plugins.json"), "utf8")) as { plugins?: Record<string, unknown> };
    const value = raw?.plugins?.[PLUGIN_ID];
    if (Array.isArray(value)) entries = value as InstalledEntry[];
    else if (value && typeof value === "object") entries = [value as InstalledEntry];
  } catch {
    return { installed: false, version: null, latest: null, updateAvailable: false };
  }
  const live = entries.filter((e) => !e.installPath || existsSync(e.installPath));
  if (!live.length) return { installed: false, version: null, latest: null, updateAvailable: false };
  const entry = live.find((e) => e.scope === "user") ?? live[0];
  let version = entry.version ?? null;
  if (entry.installPath) {
    try {
      const manifest = JSON.parse(readFileSync(join(entry.installPath, ".claude-plugin", "plugin.json"), "utf8")) as { version?: string };
      if (manifest.version) version = manifest.version;
    } catch {
      // the recorded version stands
    }
  }
  return { installed: true, version, latest: null, updateAvailable: false };
}

/** `a` is a newer version than `b`, comparing dotted numbers; anything unparsable is not newer. */
export function isNewer(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const pa = a.split(".").map((x) => Number.parseInt(x, 10));
  const pb = b.split(".").map((x) => Number.parseInt(x, 10));
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * The two commands /gate:update runs, in order: refresh the marketplace, then
 * re-install from it. The second alone re-installs whatever the stale
 * marketplace had. A terminal already running keeps the plugin it started
 * with; the next one started gets the new version.
 */
export async function updatePlugin(env: Record<string, string>): Promise<Result> {
  const claude = resolveClaudePath(env);
  if (!claude) return { ok: false, error: "claude was not found on PATH — install Claude Code first" };
  const refresh = await run(claude, ["plugin", "marketplace", "update", PLUGIN_MARKETPLACE_NAME], env, 180_000);
  if (refresh.code !== 0) return { ok: false, error: describeFailure(`claude plugin marketplace update ${PLUGIN_MARKETPLACE_NAME}`, refresh) };
  const update = await run(claude, ["plugin", "update", PLUGIN_ID], env, 180_000);
  if (update.code !== 0) return { ok: false, error: describeFailure(`claude plugin update ${PLUGIN_ID}`, update) };
  return { ok: true, value: undefined };
}

function knownMarketplaces(env: Record<string, string>): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(join(claudeConfigDirFor(env), "plugins", "known_marketplaces.json"), "utf8")) as Record<string, unknown>;
    return new Set(Object.keys(raw ?? {}));
  } catch {
    return new Set();
  }
}

interface RunOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

function run(cmd: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child: ReturnType<typeof spawn>;
    try {
      // stdin closed: the CLI must not wait on a prompt nobody can answer.
      child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, stdout, stderr, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, stdout, stderr, error: `timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function describeFailure(what: string, r: RunOutcome): string {
  const detail = (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-6).join("\n");
  const why = r.error ?? `exit ${r.code}`;
  return `${what} failed (${why})${detail ? `:\n${detail}` : ""}`;
}

/**
 * `claude plugin marketplace add <marketplace>` then `claude plugin install <id> --yes`.
 *
 * The marketplace step is skipped when Claude Code already knows one by that
 * name — a company mirror registered under the same name serves the same
 * plugin, and re-adding would either fail or repoint it.
 */
export async function installPlugin(env: Record<string, string>): Promise<Result> {
  const claude = resolveClaudePath(env);
  if (!claude) return { ok: false, error: "claude was not found on PATH — install Claude Code first" };

  if (!knownMarketplaces(env).has(PLUGIN_MARKETPLACE_NAME)) {
    const add = await run(claude, ["plugin", "marketplace", "add", PLUGIN_MARKETPLACE], env, 180_000);
    const already = /already/i.test(`${add.stdout}\n${add.stderr}`);
    if (add.code !== 0 && !already) return { ok: false, error: describeFailure(`claude plugin marketplace add ${PLUGIN_MARKETPLACE}`, add) };
  }
  const install = await run(claude, ["plugin", "install", PLUGIN_ID, "--yes"], env, 180_000);
  if (install.code !== 0) return { ok: false, error: describeFailure(`claude plugin install ${PLUGIN_ID}`, install) };
  return { ok: true, value: undefined };
}

/** Everything the first-run screen shows, in one call. A gate that cannot be reached keeps its address. */
export async function setupStatus(env: Record<string, string>): Promise<SetupStatus> {
  const found = findClaude(env);
  const plugin = pluginStatus(env);
  const conn = readConnection();
  const status: SetupStatus = {
    claude: { found: found !== null, version: found?.version ?? null, path: found?.path ?? null },
    plugin,
    gate: { connected: false, url: conn?.url ?? null, person: null, team: null },
  };
  if (conn) {
    try {
      const me = await new GateClient(conn).me({ signal: AbortSignal.timeout(8_000) });
      status.gate = { connected: true, url: conn.url, person: me.person, team: me.team };
      // The gate's version is its plugin's version: the two are bumped together.
      status.plugin.latest = me.version;
      status.plugin.updateAvailable = plugin.installed && isNewer(me.version, plugin.version);
    } catch {
      // unreachable, or a key the server no longer takes: not connected, address kept
    }
  }
  return status;
}
