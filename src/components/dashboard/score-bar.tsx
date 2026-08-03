"use client";

import * as React from "react";
import type { AxisSummary } from "@/types/api";
import { cn } from "@/lib/utils";

/**
 * A score is a distribution, so the bar renders three things at once: the
 * median, the interval around it, and how much the samples agreed. The colour
 * encodes stability rather than the score — a high median drawn from samples
 * that disagree is the least actionable figure on the page, and painting it
 * green would say the opposite.
 */

export type ScoreDistribution = Pick<
  AxisSummary,
  "median" | "ciLow" | "ciHigh" | "stability" | "n" | "lowN"
>;

export type StabilityTone = "stable" | "moderate" | "volatile" | "indicative";

const STABLE_THRESHOLD = 0.75;
const MODERATE_THRESHOLD = 0.5;

export const LOW_N_CAVEAT = "échantillon réduit — tendance indicative";

export const STABILITY_HINT =
  "Accord entre les répétitions d'une même cellule : 100 % signifie que le moteur a répondu de façon identique, une valeur basse que le score dépend du tirage.";

export const INTERVAL_HINT =
  "Intervalle de confiance à 95 % obtenu par bootstrap sur la médiane des répétitions. Deux scores dont les intervalles se recouvrent ne sont pas départageables.";

export function stabilityTone(value: ScoreDistribution): StabilityTone {
  if (value.lowN) return "indicative";
  if (value.stability >= STABLE_THRESHOLD) return "stable";
  if (value.stability >= MODERATE_THRESHOLD) return "moderate";
  return "volatile";
}

export const TONE_LABEL: Record<StabilityTone, string> = {
  stable: "stable",
  moderate: "modérée",
  volatile: "instable",
  indicative: "indicative",
};

export const TONE_TEXT: Record<StabilityTone, string> = {
  stable: "text-emerald-600",
  moderate: "text-amber-600",
  volatile: "text-red-600",
  indicative: "text-muted-foreground",
};

export const TONE_FILL: Record<StabilityTone, string> = {
  stable: "bg-emerald-500",
  moderate: "bg-amber-500",
  volatile: "bg-red-500",
  indicative: "bg-muted-foreground",
};

const TONE_BAND: Record<StabilityTone, string> = {
  stable: "bg-emerald-500/30",
  moderate: "bg-amber-500/30",
  volatile: "bg-red-500/30",
  indicative: "bg-muted-foreground/25",
};

/** Hatching marks a band that is directional only, so it cannot be read as a measure. */
const INDICATIVE_HATCH: React.CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(45deg, hsl(var(--muted-foreground) / 0.45) 0 3px, transparent 3px 6px)",
};

function clampPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, Math.max(0, (value / max) * 100));
}

export function formatScore(value: ScoreDistribution): string {
  const rounded = Math.round(value.median);
  return value.lowN ? `≈ ${rounded}` : `${rounded}`;
}

export function formatInterval(value: ScoreDistribution): string {
  const low = Math.round(Math.min(value.ciLow, value.ciHigh));
  const high = Math.round(Math.max(value.ciLow, value.ciHigh));
  return value.lowN
    ? `plage observée : ${low}–${high}`
    : `IC 95 % : ${low}–${high}`;
}

export function formatStability(value: ScoreDistribution): string {
  return `${Math.round(Math.min(1, Math.max(0, value.stability)) * 100)} %`;
}

export function describeDistribution(
  value: ScoreDistribution,
  max: number
): string {
  const base = `médiane ${Math.round(value.median)} sur ${max}, ${formatInterval(
    value
  )}, stabilité ${formatStability(value)}, n = ${value.n}`;
  return value.lowN ? `${base} — ${LOW_N_CAVEAT}` : base;
}

interface ScoreBarProps {
  value: ScoreDistribution;
  max?: number;
  label?: React.ReactNode;
  size?: "sm" | "md";
  className?: string;
}

export function ScoreBar({
  value,
  max = 100,
  label,
  size = "md",
  className,
}: ScoreBarProps) {
  const tone = stabilityTone(value);
  const low = Math.min(value.ciLow, value.ciHigh);
  const high = Math.max(value.ciLow, value.ciHigh);

  const medianPct = clampPercent(value.median, max);
  const lowPct = clampPercent(low, max);
  const highPct = clampPercent(high, max);
  const bandWidth = Math.max(highPct - lowPct, 1.5);

  const small = size === "sm";

  return (
    <div className={cn("w-full space-y-1", className)}>
      <div
        className={cn(
          "flex items-baseline justify-between gap-2",
          small ? "text-[11px]" : "text-xs"
        )}
      >
        <span className="flex items-baseline gap-1.5 truncate">
          {label ? (
            <span className="truncate text-muted-foreground">{label}</span>
          ) : null}
          <span
            className={cn(
              "font-semibold tabular-nums",
              small ? "text-xs" : "text-sm",
              TONE_TEXT[tone]
            )}
          >
            {formatScore(value)}
          </span>
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {formatInterval(value)}
        </span>
      </div>

      <div
        role="img"
        aria-label={describeDistribution(value, max)}
        className={cn(
          "relative w-full overflow-hidden rounded-full bg-muted",
          small ? "h-1.5" : "h-2.5"
        )}
      >
        <div
          className={cn(
            "absolute inset-y-0 left-0 rounded-full opacity-40",
            TONE_FILL[tone]
          )}
          style={{ width: `${medianPct}%` }}
        />
        <div
          className={cn("absolute inset-y-0 rounded-full", TONE_BAND[tone])}
          style={{
            left: `${lowPct}%`,
            width: `${bandWidth}%`,
            ...(value.lowN ? INDICATIVE_HATCH : null),
          }}
        />
        <div
          className={cn("absolute inset-y-0 w-[2px] rounded", TONE_FILL[tone])}
          style={{ left: `${medianPct}%`, transform: "translateX(-50%)" }}
        />
      </div>

      <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span className="truncate">
          Stabilité {formatStability(value)} · {TONE_LABEL[tone]}
        </span>
        <span className="shrink-0 tabular-nums">n = {value.n}</span>
      </div>

      {value.lowN && (
        <p className="text-[10px] italic leading-tight text-amber-600">
          {LOW_N_CAVEAT}
        </p>
      )}
    </div>
  );
}
