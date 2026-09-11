import clsx from "clsx";
import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-sky-600 hover:bg-sky-500 text-white border-sky-500/60",
  secondary: "bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border-zinc-700",
  danger: "bg-rose-700/80 hover:bg-rose-600 text-white border-rose-600/60",
  ghost: "bg-transparent hover:bg-zinc-800 text-zinc-300 border-transparent",
};

export function Button({ variant = "secondary", size = "md", className, type = "button", ...rest }: Props) {
  return (
    <button
      type={type}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded border font-medium leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "px-2 py-1 text-[11px]" : "px-3 py-1.5 text-xs",
        VARIANT[variant],
        className,
      )}
      {...rest}
    />
  );
}
