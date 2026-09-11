import clsx from "clsx";
import { useMemo, useState } from "react";

import type { AskAnswer, PendingAsk, Question, Result } from "@shared/types";

import { Button } from "@/components/Button";
import { Disclosure, Pre } from "@/components/Disclosure";

const OTHER = "__other__";

interface Props {
  ask: PendingAsk;
  /** Show `context` expanded (approvals: it is the plan summary) or collapsed (questions). */
  contextOpen: boolean;
  /** Approval mode: the first option is preselected and the submit button carries its label. */
  approval?: boolean;
  onSubmit: (answer: AskAnswer) => Promise<Result>;
}

interface Pick {
  labels: string[];
  otherOn: boolean;
  otherText: string;
}

function initialPicks(questions: Question[], approval: boolean): Pick[] {
  return questions.map((q) => ({
    labels: approval && !q.multiSelect && q.options.length > 0 ? [q.options[0].label] : [],
    otherOn: false,
    otherText: "",
  }));
}

function answerFor(q: Question, pick: Pick): string | string[] | null {
  const typed = pick.otherOn ? pick.otherText.trim() : "";
  if (q.multiSelect) {
    const all = typed ? [...pick.labels, typed] : pick.labels;
    return all.length ? all : null;
  }
  if (typed) return typed;
  return pick.labels[0] ?? null;
}

export function AskForm({ ask, contextOpen, approval = false, onSubmit }: Props) {
  const [picks, setPicks] = useState<Pick[]>(() => initialPicks(ask.questions, approval));
  const [response, setResponse] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answers = useMemo(() => {
    const out: Record<string, string | string[]> = {};
    ask.questions.forEach((q, i) => {
      const a = answerFor(q, picks[i]);
      if (a !== null) out[q.question] = a;
    });
    return out;
  }, [ask.questions, picks]);

  const answered = Object.keys(answers).length;
  const trimmedResponse = response.trim();
  const canSubmit = !busy && (answered > 0 || trimmedResponse.length > 0);

  const update = (i: number, patch: Partial<Pick>) =>
    setPicks((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  const toggleLabel = (i: number, q: Question, label: string) => {
    const p = picks[i];
    if (q.multiSelect) {
      const labels = p.labels.includes(label) ? p.labels.filter((l) => l !== label) : [...p.labels, label];
      update(i, { labels });
    } else {
      update(i, { labels: [label], otherOn: false });
    }
  };

  const toggleOther = (i: number, q: Question) => {
    const p = picks[i];
    if (q.multiSelect) update(i, { otherOn: !p.otherOn });
    else update(i, { otherOn: true, labels: [] });
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const answer: AskAnswer = answered > 0 ? { answers } : { answers: {} };
    if (trimmedResponse) answer.response = trimmedResponse;
    try {
      const result = await onSubmit(answer);
      if (!result.ok) setError(result.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const first = ask.questions[0];
  const primaryLabel =
    approval && first && !first.multiSelect && picks[0]?.labels[0] && !picks[0].otherOn
      ? picks[0].labels[0]
      : answered === 0 && trimmedResponse
        ? "Send reply"
        : "Submit";

  return (
    <div className="flex flex-col gap-3">
      {ask.context && (
        <Disclosure label="Context" defaultOpen={contextOpen}>
          <Pre>{ask.context}</Pre>
        </Disclosure>
      )}

      {ask.questions.map((q, i) => {
        const p = picks[i];
        const inputType = q.multiSelect ? "checkbox" : "radio";
        const name = `${ask.id}-${i}`;
        return (
          <fieldset key={name} className="rounded border border-zinc-800 bg-zinc-900/40 p-2.5">
            <legend className="px-1 text-[11px] uppercase tracking-wide text-zinc-400">{q.header || `Question ${i + 1}`}</legend>
            <p className="mb-2 whitespace-pre-wrap text-sm text-zinc-100">{q.question}</p>
            <div className="flex flex-col gap-1">
              {q.options.map((o) => {
                const on = p.labels.includes(o.label);
                return (
                  <label
                    key={o.label}
                    className={clsx(
                      "flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-zinc-800/60",
                      on && "bg-zinc-800/80",
                    )}
                  >
                    <input type={inputType} name={name} checked={on} onChange={() => toggleLabel(i, q, o.label)} className="mt-0.5 accent-sky-500" />
                    <span className="flex min-w-0 flex-col">
                      <span className="text-xs font-medium text-zinc-100">{o.label}</span>
                      {o.description && <span className="text-[11px] text-zinc-400">{o.description}</span>}
                    </span>
                  </label>
                );
              })}
              <label className={clsx("flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-zinc-800/60", p.otherOn && "bg-zinc-800/80")}>
                <input type={inputType} name={name} checked={p.otherOn} onChange={() => toggleOther(i, q)} className="accent-sky-500" />
                <span className="text-xs font-medium text-zinc-300">Other</span>
                <input
                  type="text"
                  value={p.otherText}
                  placeholder="your own answer"
                  onFocus={() => {
                    if (!p.otherOn) toggleOther(i, q);
                  }}
                  onChange={(e) => update(i, { otherText: e.target.value, otherOn: true })}
                  className="ml-1 min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
                />
              </label>
            </div>
          </fieldset>
        );
      })}

      <div>
        <label className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-400">
          Free-text reply {answered > 0 ? "(sent along with the choices)" : "(replaces the choices)"}
        </label>
        <textarea
          value={response}
          onChange={(e) => setResponse(e.target.value)}
          rows={2}
          placeholder="Anything the options do not cover"
          className="w-full resize-y rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={!canSubmit} onClick={submit}>
          {busy ? "Sending…" : primaryLabel}
        </Button>
        {error && <span className="text-xs text-rose-400">{error}</span>}
      </div>
    </div>
  );
}
