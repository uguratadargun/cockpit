import { Cloud } from "lucide-react";

import { RelativeTime } from "@/components/RelativeTime";
import { basename, sessionTitle } from "@/lib/format";
import { useStore } from "@/store";

import type { Pending } from "@shared/types";

/** The line above a question or approval: which session, which run and node, how long ago. */
export function AskHeader({ item, headline }: { item: Pending; headline?: string }) {
  const session = useStore((s) => s.sessions.find((x) => x.id === item.sessionId) ?? null);
  const execution = useStore((s) => (item.executionId ? (s.executions.find((e) => e.id === item.executionId) ?? null) : null));
  const title = session ? sessionTitle(session) : basename(item.cwd) || item.cwd;
  const run = item.executionId ? [execution?.workflowId ?? item.executionId.slice(0, 8), item.nodeId].filter(Boolean).join(" · ") : null;
  return (
    <div className="mb-2 flex flex-col gap-0.5">
      <div className="flex items-baseline gap-2">
        <span className="truncate text-sm font-semibold text-zinc-100">{headline ?? title}</span>
        <RelativeTime at={item.askedAt} className="ml-auto shrink-0 text-[11px] text-zinc-500" />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-400">
        {item.location === "remote" && (
          <span className="flex shrink-0 items-center gap-1 text-sky-300/80" title="This session runs on the gate server">
            <Cloud size={10} /> gate server
          </span>
        )}
        {headline && <span className="truncate">{title}</span>}
        {run && <span className="truncate text-amber-300/80">{run}</span>}
        <span className="truncate text-zinc-600" title={item.cwd}>
          {item.cwd}
        </span>
      </div>
    </div>
  );
}
