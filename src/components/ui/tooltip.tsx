"use client";

import * as React from "react";
import { HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";

type TooltipSide = "top" | "bottom";

interface TooltipProps {
  content: React.ReactNode;
  side?: TooltipSide;
  className?: string;
  contentClassName?: string;
  children: React.ReactNode;
}

function Tooltip({
  content,
  side = "top",
  className,
  contentClassName,
  children,
}: TooltipProps) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();

  React.useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  return (
    <span className={cn("relative inline-flex", className)}>
      <span
        tabIndex={0}
        aria-describedby={open ? id : undefined}
        className="inline-flex cursor-help items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        {children}
      </span>
      {open && (
        <span
          id={id}
          role="tooltip"
          className={cn(
            "pointer-events-none absolute left-1/2 z-50 w-max max-w-xs -translate-x-1/2 rounded-md border bg-popover px-2.5 py-1.5 text-xs font-normal normal-case leading-snug text-popover-foreground shadow-md",
            side === "top" ? "bottom-full mb-2" : "top-full mt-2",
            contentClassName
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}

interface InfoTooltipProps {
  label: React.ReactNode;
  side?: TooltipSide;
  className?: string;
}

function InfoTooltip({ label, side, className }: InfoTooltipProps) {
  return (
    <Tooltip content={label} side={side} className={className}>
      <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
      <span className="sr-only">Aide</span>
    </Tooltip>
  );
}

export { Tooltip, InfoTooltip };
