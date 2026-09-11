import { useEffect, useState } from "react";

import { relativeTime } from "@/lib/format";

/** Re-renders every 30 seconds so "just now" ages honestly. */
export function RelativeTime({ at, className }: { at: number; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()} className={className}>
      {relativeTime(at, now)}
    </time>
  );
}
