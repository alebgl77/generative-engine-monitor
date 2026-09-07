"use client";

import * as React from "react";
import type { SamplingMode } from "@prisma/client";
import { Warning, type Icon } from "@phosphor-icons/react";
import type { AxisSummary } from "@/types/api";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { InfoTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  INTERVAL_HINT,
  LOW_N_CAVEAT,
  STABILITY_HINT,
  TONE_FILL,
  TONE_LABEL,
  TONE_TEXT,
  formatInterval,
  formatScore,
  formatStability,
  stabilityTone,
} from "@/components/dashboard/score-bar";

export const MODE_LABEL: Record<SamplingMode, string> = {
  GROUNDED: "Groundé",
  PARAMETRIC: "Paramétrique",
};

export const MODE_HINT: Record<SamplingMode, string> = {
  GROUNDED:
    "Réponses de l'API avec recherche web native activée ; ce n'est pas une mesure de l'interface publique personnalisée.",
  PARAMETRIC:
    "Réponses de l'API sans recherche web native, dans les paramètres de ce run et sur ce panel de requêtes.",
};

export type AxisCardTone = "default" | "accent";

interface AxisCardProps {
  title: string;
  explanation: string;
  summary: AxisSummary | null;
  icon?: Icon;
  tone?: AxisCardTone;
  hint?: string;
  emptyMessage?: string;
  className?: string;
}

export function AxisCard({
  title,
  explanation,
  summary,
  icon: Icon,
  tone = "default",
  hint,
  emptyMessage = "Aucune mesure sur cet axe pour le dernier run.",
  className,
}: AxisCardProps) {
  return (
    <Card
      className={cn(
        tone === "accent" && "border-primary/40 bg-primary/[0.03]",
        className
      )}
    >
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          {Icon ? (
            <Icon size={16} weight="regular" className="text-muted-foreground" aria-hidden />
          ) : null}
          <h3 className="text-sm font-medium">{title}</h3>
          {hint ? <InfoTooltip label={hint} /> : null}
        </div>
        <p className="text-xs leading-snug text-muted-foreground">
          {explanation}
        </p>
      </CardHeader>
      <CardContent>
        {summary ? (
          <AxisBody summary={summary} />
        ) : (
          <p className="py-4 text-sm text-muted-foreground">{emptyMessage}</p>
        )}
      </CardContent>
    </Card>
  );
}

function AxisBody({ summary }: { summary: AxisSummary }) {
  const tone = stabilityTone(summary);
  const stabilityPct = Math.round(
    Math.min(1, Math.max(0, summary.stability ?? 0)) * 100
  );

  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            "font-mono text-4xl font-semibold tabular-nums leading-none tracking-[-0.05em]",
            TONE_TEXT[tone]
          )}
        >
          {formatScore(summary)}
        </span>
        <span className="text-base font-normal text-muted-foreground">
          /100
        </span>
      </div>

      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="tabular-nums">{formatInterval(summary)}</span>
        <InfoTooltip label={INTERVAL_HINT} />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            Stabilité
            <InfoTooltip label={STABILITY_HINT} />
          </span>
          <span className={cn("font-medium tabular-nums", TONE_TEXT[tone])}>
            {formatStability(summary)} · {TONE_LABEL[tone]}
          </span>
        </div>
        <div
          role="img"
          aria-label={summary.stability === null ? "Stabilité indisponible" : `Stabilité ${stabilityPct} %, ${TONE_LABEL[tone]}`}
          className="h-1.5 w-full overflow-hidden rounded-sm bg-muted"
        >
          <div
            className={cn("h-full rounded-sm", TONE_FILL[tone])}
            style={{ width: `${stabilityPct}%` }}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="tabular-nums">n = {summary.n} {summary.nUnit === "queries" ? "requêtes" : "échantillons historiques"}</span>
        <span>
          {summary.ciMethod ?? "méthode historique"} · {summary.rawN == null ? "réponses brutes indisponibles" : `${summary.rawN} réponses brutes`}
          {summary.cellN == null ? "" : ` · ${summary.cellN} cellules`}
        </span>
        <span className="tabular-nums">
          Marque présente : {Math.round(summary.brandPresenceRate * 100)} % des
          réponses
        </span>
      </div>

      {summary.lowN && (
        <p className="flex items-start gap-1.5 rounded-sm border border-primary/40 bg-primary/5 px-2.5 py-1.5 text-[11px] leading-snug text-primary">
          <Warning size={14} weight="regular" className="mt-px shrink-0" aria-hidden />
          {LOW_N_CAVEAT} : aucune conclusion de significativité.
        </p>
      )}
    </div>
  );
}
