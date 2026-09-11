import clsx from "clsx";
import { Check, CircleDashed, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/Button";
import { setupNeeded, useStore } from "@/store";

type StepState = "ok" | "missing" | "pending";

function Step({ n, state, title, children }: { n: number; state: StepState; title: string; children?: React.ReactNode }) {
  const Icon = state === "ok" ? Check : state === "missing" ? X : CircleDashed;
  return (
    <li className="flex gap-3 rounded-md border border-zinc-800 bg-[#14171d] p-3">
      <span
        className={clsx(
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs",
          state === "ok" && "border-emerald-500/50 bg-emerald-500/15 text-emerald-300",
          state === "missing" && "border-rose-500/50 bg-rose-500/15 text-rose-300",
          state === "pending" && "border-zinc-700 text-zinc-500",
        )}
      >
        <Icon size={13} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-zinc-100">
          <span className="mr-1.5 text-zinc-500">{n}.</span>
          {title}
        </div>
        {children && <div className="mt-1.5 text-xs text-zinc-400">{children}</div>}
      </div>
    </li>
  );
}

export function Setup() {
  const setup = useStore((s) => s.setup);
  const refreshSetup = useStore((s) => s.refreshSetup);
  const installPlugin = useStore((s) => s.installPlugin);
  const connectGate = useStore((s) => s.connectGate);
  const dismissSetup = useStore((s) => s.dismissSetup);

  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  if (!setup) return null;
  const allGreen = !setupNeeded(setup);

  const install = async () => {
    setInstalling(true);
    setInstallError(null);
    const result = await installPlugin();
    setInstalling(false);
    if (!result.ok) setInstallError(result.error);
  };

  const connect = async () => {
    const t = token.trim();
    if (!t) return;
    setConnecting(true);
    setConnectError(null);
    const result = await connectGate(t);
    setConnecting(false);
    if (!result.ok) setConnectError(result.error);
    else setToken("");
  };

  const recheck = async () => {
    setChecking(true);
    await refreshSetup();
    setChecking(false);
  };

  return (
    <div className="flex h-full w-full items-start justify-center overflow-y-auto p-8">
      <div className="w-full max-w-xl">
        <h1 className="text-lg font-semibold text-zinc-100">gate cockpit</h1>
        <p className="mt-1 text-xs text-zinc-400">Three things need to be in place before the cockpit can drive a run.</p>

        <ol className="mt-5 flex flex-col gap-3">
          <Step n={1} state={setup.claude.found ? "ok" : "missing"} title={setup.claude.found ? `Claude Code found${setup.claude.version ? ` (${setup.claude.version})` : ""}` : "Claude Code not found"}>
            {setup.claude.found ? (
              setup.claude.path && <span className="font-mono text-[11px] text-zinc-500">{setup.claude.path}</span>
            ) : (
              <>
                Install Claude Code so the cockpit can start sessions: <span className="font-mono text-zinc-300">npm install -g @anthropic-ai/claude-code</span>, then press Check again.
              </>
            )}
          </Step>

          <Step n={2} state={!setup.claude.found ? "pending" : setup.plugin.installed ? "ok" : "missing"} title={setup.plugin.installed ? `gate plugin installed${setup.plugin.version ? ` (${setup.plugin.version})` : ""}` : "gate plugin not installed"}>
            {!setup.plugin.installed && (
              <div className="flex flex-wrap items-center gap-2">
                <span>The plugin gives Claude Code the /gate:run skill and the hooks this window listens to.</span>
                <Button variant="primary" size="sm" disabled={installing || !setup.claude.found} onClick={() => void install()}>
                  {installing ? "Installing…" : "Install"}
                </Button>
                {installError && <span className="text-rose-400">{installError}</span>}
              </div>
            )}
          </Step>

          <Step n={3} state={setup.gate.connected ? "ok" : "missing"} title={setup.gate.connected ? `gate connected as ${setup.gate.person ?? "?"}@${setup.gate.team ?? "?"}` : "gate not connected"}>
            {setup.gate.connected ? (
              setup.gate.url && <span className="font-mono text-[11px] text-zinc-500">{setup.gate.url}</span>
            ) : (
              <form
                className="flex flex-col gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  void connect();
                }}
              >
                <span>Paste the token from your team's page on the gate dashboard. It starts with <span className="font-mono text-zinc-300">gatec_</span>.</span>
                <div className="flex gap-2">
                  <input
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="gatec_…"
                    spellCheck={false}
                    autoComplete="off"
                    className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
                  />
                  <Button variant="primary" size="sm" type="submit" disabled={connecting || !token.trim()}>
                    {connecting ? "Connecting…" : "Connect"}
                  </Button>
                </div>
                {connectError && <span className="text-rose-400">{connectError}</span>}
              </form>
            )}
          </Step>
        </ol>

        <div className="mt-5 flex items-center gap-2">
          {allGreen ? (
            <Button variant="primary" onClick={dismissSetup}>
              Continue
            </Button>
          ) : (
            <Button onClick={() => void recheck()} disabled={checking}>
              {checking ? "Checking…" : "Check again"}
            </Button>
          )}
          <span className="ml-auto text-[11px] text-zinc-600">cockpit {window.cockpit.version}</span>
        </div>
      </div>
    </div>
  );
}
