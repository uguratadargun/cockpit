import { ShieldCheck } from "lucide-react";
import { useState } from "react";

import type { PendingAsk, PendingPermission, PermissionDecision, Result } from "@shared/types";

import { AskForm } from "@/components/AskForm";
import { AskHeader } from "@/components/AskHeader";
import { Button } from "@/components/Button";
import { Disclosure, Pre } from "@/components/Disclosure";
import { prettyJson } from "@/lib/format";
import { Empty } from "@/panels/Questions";
import { useStore } from "@/store";

type Item = PendingAsk | PendingPermission;

export function Approvals() {
  const items = useStore((s) => s.pending.filter((p): p is Item => p.kind === "approval" || p.kind === "permission"));
  const answerAsk = useStore((s) => s.answerAsk);
  const decidePermission = useStore((s) => s.decidePermission);

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2">
        <ShieldCheck size={14} className="text-zinc-400" />
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Approvals</span>
        <span className="text-[11px] text-zinc-600">{items.length ? `${items.length} waiting` : "nothing waiting"}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {items.length === 0 && <Empty text="Nothing is waiting for your approval." />}
        <div className="flex max-w-3xl flex-col gap-4">
          {items.map((item) =>
            item.kind === "permission" ? (
              <PermissionCard key={item.id} item={item} onDecide={(d) => decidePermission(item.id, d)} />
            ) : (
              <article key={item.id} className="rounded-md border border-amber-900/40 bg-[#14171d] p-3">
                <AskHeader item={item} />
                <AskForm ask={item} contextOpen approval onSubmit={(answer) => answerAsk(item.id, answer)} />
              </article>
            ),
          )}
        </div>
      </div>
    </section>
  );
}

function PermissionCard({ item, onDecide }: { item: PendingPermission; onDecide: (d: PermissionDecision) => Promise<Result> }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: PermissionDecision) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onDecide(decision);
      if (!result.ok) setError(result.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="rounded-md border border-rose-900/40 bg-[#14171d] p-3">
      <AskHeader item={item} headline={item.summary} />
      <div className="mb-2 text-[11px] text-zinc-400">
        Permission for <span className="rounded bg-zinc-800 px-1 py-px font-mono text-zinc-200">{item.toolName}</span>
      </div>
      <Disclosure label="Tool input" className="mb-3">
        <Pre>{prettyJson(item.toolInput)}</Pre>
      </Disclosure>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void decide({ behavior: "allow" })}>
          Allow once
        </Button>
        {item.suggestions.length > 0 && (
          <Button disabled={busy} onClick={() => void decide({ behavior: "allow", always: true })} title="Allow and record the rules Claude Code proposed">
            Allow always
          </Button>
        )}
        <span className="mx-1 h-4 w-px bg-zinc-800" />
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Why not / what to do instead (optional)"
          className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
        />
        <Button variant="danger" disabled={busy} onClick={() => void decide({ behavior: "deny", message: message.trim() })}>
          Deny
        </Button>
      </div>
      {error && <div className="mt-2 text-xs text-rose-400">{error}</div>}
    </article>
  );
}
