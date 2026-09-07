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
  "median" | "ciLow" | "ciHigh" | "stability" | "n" | "lowN" | "ciMethod" | "nUnit"
>;

export type StabilityTone = "stable" | "moderate" | "volatile" | "indicative";

const STABLE_THRESHOLD = 0.75;
const MODERATE_THRESHOLD = 0.5;

export const LOW_N_CAVEAT = "échantillon réduit — tendance indicative";

export const STABILITY_HINT =
  "Dispersion des scores résumés. La méthode query-cluster décrit les moyennes par requête, pas la répétabilité d'un moteur. Mesures des API sur le panel observé, pas des interfaces publiques personnalisées.";

export const INTERVAL_HINT =
  "La méthode indiquée distingue le bootstrap historique par échantillon du bootstrap par requête sur un panel fixe d'API. Moins de deux requêtes : intervalle indisponible. Ce n'est pas un test de différence ni une garantie de représentativité.";

export function stabilityTone(value: ScoreDistribution): StabilityTone {
  if (value.lowN || value.stability === null) return "indicative";
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
  stable: "text-foreground",
  moderate: "text-muted-foreground",
  volatile: "text-primary",
  indicative: "text-muted-foreground",
};

export const TONE_FILL: Record<StabilityTone, string> = {
  stable: "bg-foreground/80",
  moderate: "bg-foreground/55",
  volatile: "bg-primary",
  indicative: "bg-muted-foreground",
};

const TONE_BAND: Record<StabilityTone, string> = {
  stable: "bg-foreground/25",
  moderate: "bg-foreground/20",
  volatile: "bg-primary/30",
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
  if (value.median === null || value.n === 0) return "—";
  const rounded = Math.round(value.median);
  return value.lowN ? `≈ ${rounded}` : `${rounded}`;
}

export function formatInterval(value: ScoreDistribution): string {
  if (value.ciLow === null || value.ciHigh === null || value.n === 0) return "IC indisponible";
  const low = Math.round(Math.min(value.ciLow, value.ciHigh));
  const high = Math.round(Math.max(value.ciLow, value.ciHigh));
  return value.lowN
    ? `IC indicatif : ${low}–${high}`
    : `IC 95 % : ${low}–${high}`;
}

export function formatStability(value: ScoreDistribution): string {
  if (value.stability === null || value.n === 0) return "—";
  return `${Math.round(Math.min(1, Math.max(0, value.stability)) * 100)} %`;
}

export function describeDistribution(
  value: ScoreDistribution,
  max: number
): string {
  const base = `médiane ${formatScore(value)} sur ${max}, ${formatInterval(
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
  if (value.median === null || value.n === 0) {
    return <span className="text-muted-foreground">— · analyse indisponible</span>;
  }
  const tone = stabilityTone(value);
  const hasInterval = value.ciLow !== null && value.ciHigh !== null;
  const low = hasInterval ? Math.min(value.ciLow!, value.ciHigh!) : 0;
  const high = hasInterval ? Math.max(value.ciLow!, value.ciHigh!) : 0;

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
          "relative w-full overflow-hidden rounded-sm bg-muted",
          small ? "h-1.5" : "h-2.5"
        )}
      >
        <div
          className={cn(
            "absolute inset-y-0 left-0 rounded-sm opacity-40",
            TONE_FILL[tone]
          )}
          style={{ width: `${medianPct}%` }}
        />
        {hasInterval && <div
          className={cn("absolute inset-y-0 rounded-sm", TONE_BAND[tone])}
          style={{
            left: `${lowPct}%`,
            width: `${bandWidth}%`,
            ...(value.lowN ? INDICATIVE_HATCH : null),
          }}
        />}
        <div
          className={cn("absolute inset-y-0 w-[2px] rounded", TONE_FILL[tone])}
          style={{ left: `${medianPct}%`, transform: "translateX(-50%)" }}
        />
      </div>

      <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span className="truncate">
          Stabilité {formatStability(value)} · {TONE_LABEL[tone]}
        </span>
        <span className="shrink-0 tabular-nums">n = {value.n} {value.nUnit === "queries" ? "requêtes" : "échantillons"}</span>
      </div>
      <p className="text-[10px] text-muted-foreground">{value.ciMethod ?? "méthode historique"}</p>

      {value.lowN && (
        <p className="text-[10px] italic leading-tight text-primary">
          {LOW_N_CAVEAT}
        </p>
      )}
    </div>
  );
}
