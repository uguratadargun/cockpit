import clsx from "clsx";
import { FolderOpen, MessageCircleQuestion, Moon, ShieldCheck, Sun, Terminal, Workflow, type LucideIcon } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";

import { Badge } from "@/components/Badge";
import { Approvals } from "@/panels/Approvals";
import { Executions } from "@/panels/Executions";
import { Projects } from "@/panels/Projects";
import { Questions } from "@/panels/Questions";
import { SessionsList, TerminalStage } from "@/panels/Sessions";
import { Setup } from "@/panels/Setup";
import { SECTIONS, setupNeeded, useBadgeCounts, useStore, type Section } from "@/store";

const NAV: Record<Section, { label: string; icon: LucideIcon; tone: "neutral" | "attention" }> = {
  projects: { label: "Projects", icon: FolderOpen, tone: "neutral" },
  sessions: { label: "Sessions", icon: Terminal, tone: "neutral" },
  questions: { label: "Questions", icon: MessageCircleQuestion, tone: "attention" },
  approvals: { label: "Approvals", icon: ShieldCheck, tone: "attention" },
  executions: { label: "Executions", icon: Workflow, tone: "neutral" },
};

export function App() {
  const ready = useStore((s) => s.ready);
  const setup = useStore((s) => s.setup);
  const setupDismissed = useStore((s) => s.setupDismissed);
  const init = useStore((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  if (!ready) return <div className="flex h-full items-center justify-center text-xs text-zinc-500">Starting…</div>;
  if (setupNeeded(setup) && !setupDismissed) return <Setup />;
  return <Shell />;
}

function Shell() {
  const section = useStore((s) => s.section);
  const setSection = useStore((s) => s.setSection);
  const counts = useBadgeCounts();
  const arrivals = useStore((s) => s.arrivals);
  const setup = useStore((s) => s.setup);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* The window's handle: a frameless window is moved by whatever is
          marked draggable, and on macOS the traffic lights sit in the first
          ~70px of it, so the title starts after them. */}
      <div
        className="flex h-9 shrink-0 select-none items-center gap-2 border-b border-zinc-800 bg-[var(--surface-2)] pr-3 pl-20"
        style={{ WebkitAppRegion: "drag" } as CSSProperties}
      >
        <span className="text-xs font-semibold text-zinc-200">gate cockpit</span>
        <span className="text-[10px] text-zinc-600">{window.cockpit.version}</span>
      </div>
      <div className="flex min-h-0 flex-1">
      <nav className="flex w-[220px] shrink-0 flex-col border-r border-zinc-800 bg-[var(--surface-2)] pt-2">
        <ul className="flex flex-col gap-0.5 px-2">
          {SECTIONS.map((key) => {
            const { label, icon: Icon, tone } = NAV[key];
            const active = section === key;
            return (
              <li key={key}>
                <button
                  type="button"
                  onClick={() => setSection(key)}
                  className={clsx(
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs",
                    active ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-100",
                  )}
                >
                  <Icon size={14} className="shrink-0" />
                  <span>{label}</span>
                  <Badge count={counts[key]} arrivedAt={arrivals[key]} tone={tone} className="ml-auto" />
                </button>
              </li>
            );
          })}
        </ul>
        <div className="mt-auto flex flex-col gap-1 border-t border-zinc-800 px-3 py-2 text-[10px] text-zinc-600">
          {setup?.gate.connected ? (
            <span className="truncate" title={setup.gate.url ?? undefined}>
              {setup.gate.person}@{setup.gate.team}
            </span>
          ) : (
            <span>gate not connected</span>
          )}
          <UsageLine />
          <PluginLine />
          <ThemeSwitch />
        </div>
      </nav>

      <main className="relative flex min-w-0 flex-1">
        {/* The sessions layout is always mounted so terminals keep their size and scrollback; other sections cover it. */}
        <SessionsList className={section !== "sessions" ? "invisible" : undefined} />
        <div className="relative min-w-0 flex-1">
          <TerminalStage />
        </div>
        {section !== "sessions" && (
          <div className="absolute inset-0 z-10 flex bg-[var(--surface-0)]">
            {section === "projects" && <Projects />}
            {section === "questions" && <Questions />}
            {section === "approvals" && <Approvals />}
            {section === "executions" && <Executions />}
          </div>
        )}
      </main>
      </div>
    </div>
  );
}

/**
 * The plugin's version, and the update when the gate serves a newer one.
 *
 * The gate and its plugin share a version, so a gate ahead of this machine
 * is an update waiting. Clicking runs what /gate:update runs. A terminal
 * already open keeps the plugin it started with; new ones get the update.
 */
function PluginLine() {
  const setup = useStore((s) => s.setup);
  const updatePlugin = useStore((s) => s.updatePlugin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const plugin = setup?.plugin;
  if (!plugin) return null;

  const update = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await updatePlugin();
    setBusy(false);
    if (result.ok) setDone(true);
    else setError(result.error);
  };

  if (!plugin.installed) return <span>gate plugin not installed</span>;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <span className="truncate">gate plugin {plugin.version ?? "?"}</span>
        {plugin.updateAvailable && !done && (
          <button
            type="button"
            onClick={() => void update()}
            disabled={busy}
            title={`Update the plugin to ${plugin.latest} (what your gate serves)`}
            className="ml-auto shrink-0 rounded bg-amber-500 px-1.5 py-0.5 font-medium text-black hover:bg-amber-400 disabled:opacity-60"
          >
            {busy ? "updating…" : `update to ${plugin.latest}`}
          </button>
        )}
      </div>
      {done && <span className="text-emerald-400">updated · new terminals use it</span>}
      {error && (
        <span className="text-rose-400" title={error}>
          update failed: {error.split("\n")[0]}
        </span>
      )}
    </div>
  );
}

const WINDOW_LABELS: Record<string, string> = {
  five_hour: "session",
  seven_day: "weekly",
  seven_day_opus: "Opus",
  seven_day_sonnet: "Sonnet",
  seven_day_fable: "Fable",
};

function windowName(w: { name: string; label?: string }): string {
  if (w.label) return w.label.replace(/ limit$/i, "");
  return WINDOW_LABELS[w.name] ?? w.name.replace(/_/g, " ");
}

function untilText(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * What the gate's pool has left: the numbers `/usage` shows before a session
 * joins a gate, and stops showing after. They are the pool's, shared by
 * everyone on it — the best account that can serve now, since that is the
 * one a request would go to. Click to refresh; the store refreshes every
 * minute anyway.
 */
function UsageLine() {
  const setup = useStore((s) => s.setup);
  const usage = useStore((s) => s.usage);
  const usageError = useStore((s) => s.usageError);
  const refreshUsage = useStore((s) => s.refreshUsage);
  if (!setup?.gate.connected) return null;
  if (usageError && !usage) {
    return (
      <button type="button" className="truncate text-left text-rose-400 hover:underline" title={usageError} onClick={() => void refreshUsage()}>
        usage unavailable
      </button>
    );
  }
  if (!usage) return <span>usage…</span>;
  if (!usage.windows.length) {
    return (
      <span className="truncate" title={usage.reason ?? undefined}>
        {usage.reason ?? "no window reading yet"}
      </span>
    );
  }
  const a = usage.accounts;
  const detail = [
    ...usage.windows.map((w) => `${windowName(w)}: ${Math.round(w.remaining)}% left${w.resetsAt ? `, resets in ${untilText(w.resetsAt)}` : ""}`),
    `${a.available} of ${a.enabled} account${a.enabled === 1 ? "" : "s"} serving now` +
      (a.coolingDown ? `, ${a.coolingDown} cooling down` : "") +
      (a.quotaBlocked ? `, ${a.quotaBlocked} held back by the ${usage.floorPercent}% floor` : ""),
    ...(usage.plan ? [usage.plan] : []),
    "click to refresh",
  ].join("\n");
  return (
    <button type="button" className="flex flex-col gap-0.5 text-left" title={detail} onClick={() => void refreshUsage()}>
      {usage.windows.slice(0, 3).map((w) => {
        const pct = Math.max(0, Math.min(100, w.remaining));
        const tone = pct <= usage.floorPercent ? "bg-rose-500" : pct < 25 ? "bg-amber-500" : "bg-emerald-500";
        return (
          <span key={w.name} className="flex items-center gap-1.5">
            <span className="w-11 shrink-0 truncate text-zinc-500">{windowName(w)}</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded bg-zinc-800">
              <span className={clsx("block h-full rounded", tone)} style={{ width: `${pct}%` }} />
            </span>
            <span className="w-8 shrink-0 text-right tabular-nums text-zinc-400">{Math.round(pct)}%</span>
            <span className="w-9 shrink-0 truncate text-right text-zinc-600">{w.resetsAt ? untilText(w.resetsAt) : ""}</span>
          </span>
        );
      })}
    </button>
  );
}

/** Dark or light. One click, kept for next time, and every terminal follows. */
function ThemeSwitch() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      title={`Switch to the ${next} theme`}
      className="mt-0.5 flex items-center gap-1.5 self-start rounded px-1 py-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
    >
      {theme === "dark" ? <Sun size={11} /> : <Moon size={11} />}
      <span>{theme === "dark" ? "light theme" : "dark theme"}</span>
    </button>
  );
}
