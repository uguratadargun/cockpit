import clsx from "clsx";
import { useEffect, useState } from "react";

const PULSE_MS = 4000;

/** True for a few seconds after `stamp` (a Date.now() value) changes. */
export function useRecent(stamp: number, windowMs = PULSE_MS): boolean {
  const [recent, setRecent] = useState(() => stamp > 0 && Date.now() - stamp < windowMs);
  useEffect(() => {
    if (!stamp) return;
    const remaining = windowMs - (Date.now() - stamp);
    if (remaining <= 0) {
      setRecent(false);
      return;
    }
    setRecent(true);
    const t = window.setTimeout(() => setRecent(false), remaining);
    return () => window.clearTimeout(t);
  }, [stamp, windowMs]);
  return recent;
}

interface Props {
  count: number;
  /** Timestamp of the latest arrival; the badge pulses briefly after it. */
  arrivedAt?: number;
  tone?: "neutral" | "attention";
  className?: string;
}

export function Badge({ count, arrivedAt = 0, tone = "attention", className }: Props) {
  const pulse = useRecent(arrivedAt);
  if (count <= 0) return null;
  return (
    <span
      className={clsx(
        "inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums leading-none",
        tone === "attention" ? "bg-amber-500 text-black" : "bg-zinc-700 text-zinc-200",
        pulse && "animate-pulse ring-2 ring-amber-300/60",
        className,
      )}
    >
      {count}
    </span>
  );
}

/** The small status pill used in lists. */
export function Pill({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={clsx("inline-flex items-center rounded border px-1.5 py-px text-[10px] font-medium leading-tight", className)}>
      {children}
    </span>
  );
}
