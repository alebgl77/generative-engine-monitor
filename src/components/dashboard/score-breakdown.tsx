"use client";

import * as React from "react";
import { AlertTriangle, ExternalLink, Info, Shuffle } from "lucide-react";
import type { SampleDetail } from "@/types/api";
import type { ScoreContribution } from "@/lib/scoring/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type SampleMention = SampleDetail["mentions"][number];

export interface HighlightSegment {
  key: string;
  text: string;
  start: number;
  mention: SampleMention | null;
}

/** Longest span a single mention may highlight, so a bad offset cannot swallow the answer. */
const MAX_HIGHLIGHT_LENGTH = 120;

const TOKEN_AT_OFFSET =
  /^[0-9A-Za-zÀ-ÖØ-öø-ÿ][0-9A-Za-zÀ-ÖØ-öø-ÿ'’\-.&]*/;

const SENTIMENT_LABELS: Record<string, string> = {
  POSITIVE: "positif",
  NEUTRAL: "neutre",
  MIXED: "mitigé",
  NEGATIVE: "négatif",
};

function highlightLength(text: string, start: number, entityName: string): number {
  const name = entityName.trim();
  const remaining = text.length - start;
  if (remaining <= 0) return 0;
  if (
    name.length > 0 &&
    text.slice(start, start + name.length).toLowerCase() === name.toLowerCase()
  ) {
    return Math.min(name.length, remaining);
  }
  const token = TOKEN_AT_OFFSET.exec(text.slice(start, start + MAX_HIGHLIGHT_LENGTH));
  if (token && token[0].length > 0) return token[0].length;
  return Math.min(Math.max(name.length, 1), remaining);
}

/**
 * Turns the stored char offsets into a flat list of segments whose concatenation
 * is byte-for-byte the original answer. Offsets index the text as it was stored,
 * so nothing here may re-tokenise or normalise it.
 */
export function buildHighlightSegments(
  text: string,
  mentions: SampleMention[]
): HighlightSegment[] {
  if (text.length === 0) return [];

  const candidates = mentions
    .filter(
      (m) =>
        Number.isInteger(m.charOffset) && m.charOffset >= 0 && m.charOffset < text.length
    )
    .slice()
    .sort((a, b) =>
      a.charOffset !== b.charOffset
        ? a.charOffset - b.charOffset
        : b.entityName.length - a.entityName.length
    );

  const segments: HighlightSegment[] = [];
  let cursor = 0;

  for (const mention of candidates) {
    const start = mention.charOffset;
    // Overlapping evidence: the first (longest) mention at a position wins, and a
    // duplicate offset can therefore never emit two segments for the same span.
    if (start < cursor) continue;
    const end = start + highlightLength(text, start, mention.entityName);
    if (end <= start) continue;
    if (start > cursor) {
      segments.push({ key: `t${cursor}`, text: text.slice(cursor, start), start: cursor, mention: null });
    }
    segments.push({
      key: `m${start}-${mention.entityId}`,
      text: text.slice(start, end),
      start,
      mention,
    });
    cursor = end;
  }

  if (cursor < text.length) {
    segments.push({ key: `t${cursor}`, text: text.slice(cursor), start: cursor, mention: null });
  }

  return segments;
}

function formatPoints(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  const formatted = Math.abs(rounded).toLocaleString("fr-FR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  if (rounded > 0) return `+${formatted}`;
  if (rounded < 0) return `−${formatted}`;
  return "0,0";
}

/** Offsets past the excerpt index text the panel does not hold, so they cannot be marked. */
function offsetsBeyond(offsets: number[], length: number): number[] {
  return offsets.filter((offset) => offset >= length);
}

function truncationNotice(displayed: number, hiddenMentions: number): string {
  const cut = `[…] Réponse tronquée à ${displayed.toLocaleString("fr-FR")} caractères pour l’affichage.`;
  if (hiddenMentions === 0) return cut;
  return hiddenMentions > 1
    ? `${cut} ${hiddenMentions} mentions situées au-delà ne sont pas surlignées.`
    : `${cut} 1 mention située au-delà n’est pas surlignée.`;
}

function beyondNotice(count: number): string {
  return count > 1
    ? `${count} mentions de cette règle se situent au-delà de l’extrait affiché.`
    : "1 mention de cette règle se situe au-delà de l’extrait affiché.";
}

function evidenceCounts(contribution: ScoreContribution): string[] {
  const parts: string[] = [];
  const offsets = contribution.evidence.charOffsets ?? [];
  const citations = contribution.evidence.citationIds ?? [];
  if (offsets.length > 0) {
    parts.push(`${offsets.length} mention${offsets.length > 1 ? "s" : ""} dans la réponse`);
  }
  if (citations.length > 0) {
    parts.push(`${citations.length} source${citations.length > 1 ? "s" : ""} citée${citations.length > 1 ? "s" : ""}`);
  }
  return parts;
}

export interface ScoreBreakdownProps {
  sample: SampleDetail;
  className?: string;
}

export function ScoreBreakdown({ sample, className }: ScoreBreakdownProps) {
  const [activeRuleId, setActiveRuleId] = React.useState<string | null>(null);
  const markRefs = React.useRef<Map<number, HTMLElement | null>>(new Map());

  const text = sample.text ?? "";
  const segments = React.useMemo(
    () => buildHighlightSegments(text, sample.mentions),
    [text, sample.mentions]
  );

  const hiddenMentions = React.useMemo(() => {
    if (!sample.textTruncated) return 0;
    const offsets = sample.mentions.map((m) => m.charOffset);
    return offsetsBeyond(offsets, text.length).length;
  }, [sample.textTruncated, sample.mentions, text.length]);

  const activeRule =
    sample.contributions.find((c) => c.ruleId === activeRuleId) ?? null;
  const activeOffsets = React.useMemo(
    () => (activeRule ? activeRule.evidence.charOffsets ?? [] : []),
    [activeRule]
  );

  React.useEffect(() => {
    if (activeOffsets.length === 0) return;
    for (const offset of activeOffsets) {
      const element = markRefs.current.get(offset);
      if (element && typeof element.scrollIntoView === "function") {
        element.scrollIntoView({ block: "center", behavior: "smooth" });
        return;
      }
    }
  }, [activeRuleId, activeOffsets]);

  const scale = sample.contributions.reduce(
    (max, c) => Math.max(max, Math.abs(c.weight), Math.abs(c.contribution)),
    1
  );

  return (
    <div className={cn("space-y-4 rounded-lg border bg-card p-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">
            Échantillon {sample.sampleIndex + 1}
          </span>
          {sample.model ? (
            <span className="text-xs text-muted-foreground">{sample.model}</span>
          ) : null}
          {sample.latencyMs !== null ? (
            <span className="text-xs text-muted-foreground">
              {sample.latencyMs.toLocaleString("fr-FR")} ms
            </span>
          ) : null}
        </div>
        <div className="text-right">
          <span className="text-2xl font-semibold tabular-nums">
            {sample.score !== null
              ? sample.score.toLocaleString("fr-FR", { maximumFractionDigits: 1 })
              : "—"}
          </span>
          <span className="ml-1 text-xs text-muted-foreground">/ 100</span>
        </div>
      </div>

      {sample.errorMessage ? (
        <Alert variant="destructive" icon={<AlertTriangle />}>
          <AlertTitle>Échantillon en échec</AlertTitle>
          <AlertDescription>{sample.errorMessage}</AlertDescription>
        </Alert>
      ) : null}

      {sample.contributions.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Détail du score
          </p>
          <ul className="space-y-1.5">
            {sample.contributions.map((contribution) => {
              const isActive = contribution.ruleId === activeRuleId;
              const width = Math.min(
                100,
                (Math.abs(contribution.contribution) / scale) * 100
              );
              const positive = contribution.contribution >= 0;
              const counts = evidenceCounts(contribution);
              const beyond = sample.textTruncated
                ? offsetsBeyond(contribution.evidence.charOffsets ?? [], text.length).length
                : 0;
              return (
                <li
                  key={contribution.ruleId}
                  className={cn(
                    "rounded-md border transition-colors",
                    isActive ? "border-primary bg-accent" : "border-transparent",
                    !contribution.applicable && "opacity-60"
                  )}
                >
                  <button
                    type="button"
                    onClick={() =>
                      setActiveRuleId(isActive ? null : contribution.ruleId)
                    }
                    aria-expanded={isActive}
                    aria-controls={`evidence-${sample.id}-${contribution.ruleId}`}
                    className={cn(
                      "w-full rounded-md px-3 pt-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      !isActive && "hover:bg-muted/50"
                    )}
                  >
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                        {contribution.label}
                        {!contribution.applicable ? (
                          <Badge variant="outline" className="font-normal">
                            Non applicable
                          </Badge>
                        ) : null}
                        {contribution.redistributed ? (
                          <Badge
                            variant="secondary"
                            className="gap-1 font-normal text-amber-700"
                          >
                            <Shuffle className="h-3 w-3" aria-hidden="true" />
                            Budget redistribué
                          </Badge>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-sm tabular-nums">
                        <span
                          className={cn(
                            "font-semibold",
                            !contribution.applicable
                              ? "text-muted-foreground"
                              : positive
                                ? "text-emerald-600"
                                : "text-red-600"
                          )}
                        >
                          {formatPoints(contribution.contribution)}
                        </span>
                        <span className="ml-1 text-xs text-muted-foreground">
                          pts · poids {contribution.weight}
                        </span>
                      </span>
                    </span>
                    <span className="mt-1.5 block h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <span
                        className={cn(
                          "block h-full rounded-full transition-all",
                          !contribution.applicable
                            ? "bg-muted-foreground/40"
                            : positive
                              ? "bg-emerald-500"
                              : "bg-red-500"
                        )}
                        style={{ width: `${width}%` }}
                      />
                    </span>
                  </button>
                  <div
                    id={`evidence-${sample.id}-${contribution.ruleId}`}
                    className="space-y-1 px-3 pb-2 pt-1.5 text-xs text-muted-foreground"
                  >
                    {contribution.evidence.note ? (
                      <p>{contribution.evidence.note}</p>
                    ) : null}
                    {contribution.redistributed ? (
                      <p>
                        Cette règle a absorbé le budget des citations : rien n’a pu
                        être récupéré dans ce mode, la comparaison entre modes
                        resterait sinon faussée.
                      </p>
                    ) : null}
                    {counts.length > 0 ? <p>{counts.join(" · ")}</p> : null}
                    {beyond > 0 ? <p>{beyondNotice(beyond)}</p> : null}
                    {isActive && (contribution.evidence.citationIds ?? []).length > 0 ? (
                      <ul className="space-y-0.5">
                        {(contribution.evidence.citationIds ?? []).map((url) => (
                          <li key={url} className="truncate">
                            {url}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Aucun détail de score enregistré pour cet échantillon.
        </p>
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Réponse analysée
          </p>
          <p className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-sm bg-emerald-200" aria-hidden="true" />
              Marque
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-sm bg-amber-200" aria-hidden="true" />
              Concurrent
            </span>
          </p>
        </div>

        {text.length === 0 ? (
          <Alert variant="warning" icon={<Info />}>
            <AlertDescription>
              Aucune réponse stockée pour cet échantillon.
            </AlertDescription>
          </Alert>
        ) : (
          <p className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/20 p-3 text-sm leading-relaxed">
            {segments.map((segment) =>
              segment.mention ? (
                <mark
                  key={segment.key}
                  ref={(element) => {
                    markRefs.current.set(segment.start, element);
                  }}
                  title={`${segment.mention.entityName} — ${
                    segment.mention.kind === "BRAND" ? "marque" : "concurrent"
                  }${
                    segment.mention.sentiment
                      ? `, sentiment ${SENTIMENT_LABELS[segment.mention.sentiment] ?? segment.mention.sentiment}`
                      : ""
                  }`}
                  className={cn(
                    "rounded-sm px-0.5",
                    segment.mention.kind === "BRAND"
                      ? "bg-emerald-100 text-emerald-900"
                      : "bg-amber-100 text-amber-900",
                    activeOffsets.indexOf(segment.start) >= 0 &&
                      "ring-2 ring-primary ring-offset-1"
                  )}
                >
                  {segment.text}
                </mark>
              ) : (
                <React.Fragment key={segment.key}>{segment.text}</React.Fragment>
              )
            )}
            {sample.textTruncated ? (
              <span className="mt-2 block border-t border-dashed pt-2 text-xs font-medium text-muted-foreground">
                {truncationNotice(text.length, hiddenMentions)}
              </span>
            ) : null}
          </p>
        )}
      </div>

      {sample.citations.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Sources citées
          </p>
          <ul className="space-y-1">
            {sample.citations.map((citation) => (
              <li key={citation.url} className="flex items-center gap-2 text-xs">
                <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                <a
                  href={citation.url}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate text-primary hover:underline"
                >
                  {citation.title ?? citation.url}
                </a>
                <span className="shrink-0 text-muted-foreground">{citation.domain}</span>
                {citation.isBrandDomain ? (
                  <Badge variant="secondary" className="shrink-0 font-normal">
                    Domaine de la marque
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
