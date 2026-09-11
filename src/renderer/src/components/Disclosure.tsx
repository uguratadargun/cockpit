import clsx from "clsx";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

interface Props {
  label: string;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}

/** A collapsible block: a small chevron row, then the content. */
export function Disclosure({ label, defaultOpen = false, children, className }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <div className={clsx("text-xs", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-zinc-400 hover:text-zinc-200"
        aria-expanded={open}
      >
        <Icon size={12} />
        {label}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

export function Pre({ children, className }: { children: string; className?: string }) {
  return (
    <pre
      className={clsx(
        "max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] leading-snug text-zinc-300",
        className,
      )}
    >
      {children}
    </pre>
  );
}
