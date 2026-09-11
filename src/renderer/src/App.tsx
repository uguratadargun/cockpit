import clsx from "clsx";
import { MessageCircleQuestion, ShieldCheck, Terminal, Workflow, type LucideIcon } from "lucide-react";
import { useEffect, type CSSProperties } from "react";

import { Badge } from "@/components/Badge";
import { Approvals } from "@/panels/Approvals";
import { Executions } from "@/panels/Executions";
import { Questions } from "@/panels/Questions";
import { SessionsList, TerminalStage } from "@/panels/Sessions";
import { Setup } from "@/panels/Setup";
import { SECTIONS, setupNeeded, useBadgeCounts, useStore, type Section } from "@/store";

const NAV: Record<Section, { label: string; icon: LucideIcon; tone: "neutral" | "attention" }> = {
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
        className="flex h-9 shrink-0 select-none items-center gap-2 border-b border-zinc-800 bg-[#0c0e12] pr-3 pl-20"
        style={{ WebkitAppRegion: "drag" } as CSSProperties}
      >
        <span className="text-xs font-semibold text-zinc-200">gate cockpit</span>
        <span className="text-[10px] text-zinc-600">{window.cockpit.version}</span>
      </div>
      <div className="flex min-h-0 flex-1">
      <nav className="flex w-[220px] shrink-0 flex-col border-r border-zinc-800 bg-[#0c0e12] pt-2">
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
        <div className="mt-auto border-t border-zinc-800 px-3 py-2 text-[10px] text-zinc-600">
          {setup?.gate.connected ? (
            <span className="truncate" title={setup.gate.url ?? undefined}>
              {setup.gate.person}@{setup.gate.team}
            </span>
          ) : (
            <span>gate not connected</span>
          )}
        </div>
      </nav>

      <main className="relative flex min-w-0 flex-1">
        {/* The sessions layout is always mounted so terminals keep their size and scrollback; other sections cover it. */}
        <SessionsList className={section !== "sessions" ? "invisible" : undefined} />
        <div className="relative min-w-0 flex-1">
          <TerminalStage />
        </div>
        {section !== "sessions" && (
          <div className="absolute inset-0 z-10 flex bg-[#0f1115]">
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
