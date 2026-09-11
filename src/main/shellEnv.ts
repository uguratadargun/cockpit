/**
 * The user's login-shell environment, captured once.
 *
 * An Electron app launched from Finder, the Dock or Spotlight starts from
 * launchd's environment, not the user's shell: no nvm/asdf/volta/brew PATH
 * edits, no exported API keys, no locale. A bare `claude` would ENOENT in a
 * packaged build even though it works fine in the user's own terminal. So we
 * boot the user's interactive login shell once, read its environment out, and
 * hand that to every pty we spawn.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

/** script → captured output, memoised for the process lifetime. Every capture
 *  boots a full interactive login shell (rc files and all) — hundreds of ms of
 *  BLOCKING spawnSync on the main process — and shell PATH / binary locations
 *  don't change mid-session. Only successful captures are cached, so a null
 *  (shell failed / fence missing) stays retryable. */
const shellCapture = new Map<string, string>();

/** Run `script` in the user's INTERACTIVE login shell and return only what the
 *  script itself printed.
 *
 *  An interactive shell is required to pick up nvm/asdf/brew PATH edits, but it
 *  also runs the user's rc files, which are free to print. Some zsh setups emit
 *  `Restored session: <date>` from a session-save plugin BEFORE the script's
 *  own output, which silently poisons every value read back: a plain `.trim()`
 *  on `echo "$PATH"` yields `"Restored session: …\n/opt/homebrew/bin:…"` and
 *  that whole string would become every child's PATH. Fencing the output
 *  between two markers makes rc-file chatter (before, after, or both)
 *  impossible to mistake for a result. Returns null when the shell fails or the
 *  fence never appears. */
export function captureFromLoginShell(script: string): string | null {
  const cached = shellCapture.get(script);
  if (cached !== undefined) return cached;
  const value = captureFromLoginShellUncached(script);
  if (value !== null) shellCapture.set(script, value);
  return value;
}

function captureFromLoginShellUncached(script: string): string | null {
  const mark = "__COCKPIT_SHELL_FENCE__";
  try {
    const res = spawnSync(
      process.env.SHELL ?? "/bin/zsh",
      ["-ilc", `printf %s ${mark}; ${script}; printf %s ${mark}`],
      { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
    );
    const out = res.stdout ?? "";
    const start = out.indexOf(mark);
    const end = out.lastIndexOf(mark);
    if (start < 0 || end <= start) return null;
    return out.slice(start + mark.length, end);
  } catch {
    return null;
  }
}

let cachedPath: string | null = null;

/** The user's interactive-shell PATH, queried once and cached for the session. */
export function userShellPath(): string {
  if (cachedPath !== null) return cachedPath;
  // Windows has no login-shell PATH problem — the process PATH is the user's.
  if (process.platform === "win32") {
    cachedPath = process.env.PATH || "";
    return cachedPath;
  }
  const fromEnv = loginShellEnv().PATH;
  if (fromEnv) {
    cachedPath = fromEnv;
    return cachedPath;
  }
  const shellPath = captureFromLoginShell('printf %s "$PATH"')?.trim();
  // A PATH is a single colon-joined line. Anything multi-line is rc-file noise
  // that slipped the fence — fall back rather than hand the child a corrupt
  // PATH it would carry into every subprocess it spawns.
  cachedPath = shellPath && !shellPath.includes("\n") ? shellPath : process.env.PATH || "";
  return cachedPath;
}

/** Variables that describe the capturing shell itself, not the user's setup.
 *  Carrying them into a child would lie about where it is and how deep it is. */
const SHELL_PRIVATE = new Set(["_", "PWD", "OLDPWD", "SHLVL", "TERM", "TERM_SESSION_ID", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"]);

let cachedEnv: Record<string, string> | null = null;

/**
 * The environment a pty child should start with: the user's login-shell
 * environment merged OVER `process.env`, captured once per app run.
 *
 * `env -0` inside the fence gives every exported variable NUL-separated, so a
 * multi-line value (a PEM key, a function export) cannot split into garbage.
 * When the capture fails (no shell, timeout, fence missing) this degrades to
 * `process.env` plus whatever `userShellPath` can salvage, so a spawn still
 * happens — it just may not find `claude`.
 */
export function loginShellEnv(): Record<string, string> {
  if (cachedEnv !== null) return cachedEnv;
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") base[k] = v;

  if (process.platform === "win32") {
    cachedEnv = base;
    return cachedEnv;
  }

  const captured = captureFromLoginShell("env -0");
  const merged: Record<string, string> = { ...base };
  let gotPath = false;
  if (captured) {
    for (const pair of captured.split("\0")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const key = pair.slice(0, eq);
      if (SHELL_PRIVATE.has(key)) continue;
      const value = pair.slice(eq + 1);
      if (key === "PATH") {
        if (value.includes("\n") || !value) continue; // noise that slipped the fence
        gotPath = true;
      }
      merged[key] = value;
    }
  }
  if (!gotPath) {
    // The full capture failed; a PATH-only capture is cheaper to get right.
    const p = captureFromLoginShell('printf %s "$PATH"')?.trim();
    if (p && !p.includes("\n")) merged.PATH = p;
  }
  // Only a capture that produced a PATH counts as a success worth caching;
  // otherwise the next call retries (the shell may have been slow, not broken).
  if (gotPath || merged.PATH) cachedEnv = merged;
  return merged;
}

/** Resolve a bare command (e.g. 'claude') against the user's PATH plus common
 *  install locations. Returns `found: false` with the bare command when nothing
 *  exists — the spawn would ENOENT, and the caller can say why. Paths (anything
 *  with a separator) pass through, `found` reflecting whether they exist. */
export function resolveCommand(command: string): { path: string; found: boolean } {
  if (command.includes("/") || command.includes("\\")) return { path: command, found: existsSync(command) };
  if (process.platform === "win32") {
    // `where` is the Windows `which`; runs via cmd.exe (shell:true). It can
    // return several matches; the first is often an extensionless sh shim
    // that CreateProcess cannot run, so take the first PATHEXT-eligible hit.
    try {
      const res = spawnSync("where", [command], { encoding: "utf8", timeout: 3000, shell: true });
      const lines = (res.stdout ?? "").trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const pathExts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim().toUpperCase()).filter(Boolean);
      const isExecutable = (p: string): boolean => {
        const dot = p.lastIndexOf(".");
        const sep = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
        if (dot <= sep) return false;
        return pathExts.includes(p.slice(dot).toUpperCase());
      };
      const exe = lines.find((p) => isExecutable(p) && existsSync(p));
      if (exe) return { path: exe, found: true };
    } catch {
      /* fall through */
    }
    const appData = process.env.APPDATA ?? "";
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
    const winCandidates = [
      `${appData}\\npm\\${command}.cmd`,
      `${appData}\\npm\\${command}`,
      `${localAppData}\\Programs\\claude\\${command}.exe`,
      `${home}\\.claude\\local\\${command}.cmd`,
      `${home}\\.claude\\local\\${command}`,
    ];
    for (const c of winCandidates) if (existsSync(c)) return { path: c, found: true };
    return { path: command, found: false };
  }
  // macOS / Linux: search the captured login PATH ourselves first (no shell
  // boot when the env is already cached), then ask the shell, then guess.
  const shellPath = loginShellEnv().PATH ?? process.env.PATH ?? "";
  for (const dir of shellPath.split(":").filter(Boolean)) {
    const p = `${dir}/${command}`;
    if (existsSync(p)) return { path: p, found: true };
  }
  const which = captureFromLoginShell(`which ${command}`);
  if (which) {
    const path = which.trim().split("\n").map((l) => l.trim()).filter(Boolean).pop();
    if (path && existsSync(path)) return { path, found: true };
  }
  const home = process.env.HOME ?? "";
  const candidates = [
    `/opt/homebrew/bin/${command}`,
    `/usr/local/bin/${command}`,
    `${home}/.local/bin/${command}`,
    `${home}/.claude/local/${command}`,
    `${home}/.volta/bin/${command}`,
  ];
  for (const c of candidates) if (existsSync(c)) return { path: c, found: true };
  return { path: command, found: false };
}
