import { MessageCircleQuestion } from "lucide-react";

import type { PendingAsk } from "@shared/types";

import { AskForm } from "@/components/AskForm";
import { AskHeader } from "@/components/AskHeader";
import { useStore } from "@/store";

export function Questions() {
  const items = useStore((s) => s.pending.filter((p): p is PendingAsk => p.kind === "question"));
  const answerAsk = useStore((s) => s.answerAsk);

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2">
        <MessageCircleQuestion size={14} className="text-zinc-400" />
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Questions</span>
        <span className="text-[11px] text-zinc-600">{items.length ? `${items.length} open` : "nothing waiting"}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {items.length === 0 && <Empty text="No session is asking you anything right now." />}
        <div className="flex max-w-3xl flex-col gap-4">
          {items.map((ask) => (
            <article key={ask.id} className="rounded-md border border-zinc-800 bg-[#14171d] p-3">
              <AskHeader item={ask} />
              <AskForm ask={ask} contextOpen={false} onSubmit={(answer) => answerAsk(ask.id, answer)} />
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className="py-16 text-center text-xs text-zinc-500">{text}</div>;
}
