"use client";

import * as React from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  CaretDown,
  ClipboardText,
  DownloadSimple,
  MagnifyingGlassMinus,
  WarningCircle,
} from "@phosphor-icons/react";
import type { OverviewResponse, QueriesResponse } from "@/types/api";
import { Skeleton } from "@/components/ui/skeleton";
import {
  deriveSignalFindings,
  findingDataCompatibility,
  type SignalFinding,
  type SignalFindingKind,
} from "@/lib/dashboard/signal-insights";
import {
  buildMeasurementPassport,
  measurementPassportFilename,
  renderMeasurementPassportMarkdown,
  serializeMeasurementPassport,
  type MeasurementPassportPayload,
  type PassportRunContext,
} from "@/lib/dashboard/measurement-passport";
import { cn } from "@/lib/utils";

type FindingsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; findings: SignalFinding[] };

const FINDING_LABEL: Record<SignalFindingKind, string> = {
  "broad-invisibility": "Invisibilité transversale",
  "grounded-erosion": "Érosion groundée",
  "grounded-recovery": "Récupération groundée",
};

const FINDING_ICON = {
  "broad-invisibility": MagnifyingGlassMinus,
  "grounded-erosion": ArrowDownRight,
  "grounded-recovery": ArrowUpRight,
} satisfies Record<SignalFindingKind, typeof ArrowUpRight>;

function formatMetric(value: number | null): string {
  if (value === null) return "indisponible";
  return value.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
}

function formatGap(value: number): string {
  const number = formatMetric(Math.abs(value));
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${number}`;
}

function findingSentence(finding: SignalFinding): string {
  if (finding.kind === "broad-invisibility") {
    return "Aucune présence de la marque observée dans les deux modes de cette cellule.";
  }
  if (finding.kind === "grounded-erosion") {
    return `Le score groundé se situe ${formatMetric(Math.abs(finding.gap))} points sous le score paramétrique.`;
  }
  return `Le score groundé se situe ${formatMetric(finding.gap)} points au-dessus du score paramétrique.`;
}

function intervalText(low: number | null, high: number | null): string {
  if (low === null || high === null) return "IC indisponible";
  return `IC ${formatMetric(low)}–${formatMetric(high)}`;
}

function supportText(finding: SignalFinding): string {
  const groundedRaw = finding.grounded.rawN ?? "indisponible";
  const parametricRaw = finding.parametric.rawN ?? "indisponible";
  const methods = Array.from(
    new Set(
      [finding.grounded.ciMethod, finding.parametric.ciMethod].filter(
        (method): method is string => Boolean(method)
      )
    )
  );
  return `n ${finding.grounded.n}/${finding.parametric.n} · brut ${groundedRaw}/${parametricRaw} · ${methods.length > 0 ? methods.join(" / ") : "méthode indisponible"}`;
}

function compatibilityMessage(
  compatibility: ReturnType<typeof findingDataCompatibility>
): string {
  if (compatibility === "no-run") {
    return "Le registre par requête ne contient aucun run mesuré.";
  }
  if (compatibility === "version-mismatch") {
    return "La version de score du registre par requête ne correspond pas à celle de cette vue.";
  }
  return "Le registre par requête et l’overview ne décrivent pas le même run. Les findings sont masqués pour éviter un rapprochement trompeur.";
}

interface SignalFindingsProps {
  projectId: string;
  projectName: string;
  brandNames: string[];
  scoringVersion: string;
  latestRun: NonNullable<OverviewResponse["latestRun"]>;
}

export function SignalFindings({
  projectId,
  projectName,
  brandNames,
  scoringVersion,
  latestRun,
}: SignalFindingsProps) {
  const [state, setState] = React.useState<FindingsState>({ status: "loading" });
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [preparedAt, setPreparedAt] = React.useState<string | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    // A route transition may reuse this client component. Hide the previous
    // project's evidence before the next network response can settle.
    /* eslint-disable react-hooks/set-state-in-effect -- synchronous privacy boundary on project/run change */
    setState({ status: "loading" });
    setSelectedId(null);
    setPreparedAt(null);
    /* eslint-enable react-hooks/set-state-in-effect */

    async function loadFindings() {
      try {
        const response = await fetch(
          `/api/projects/${projectId}/dashboard/queries`,
          { cache: "no-store", signal: controller.signal }
        );
        if (!response.ok) throw new Error(`Erreur ${response.status}`);
        const data = (await response.json()) as QueriesResponse;
        const compatibility = findingDataCompatibility(
          data,
          latestRun.id,
          scoringVersion
        );
        if (compatibility !== "match") {
          throw new Error(compatibilityMessage(compatibility));
        }
        const findings = deriveSignalFindings(data);
        setState({ status: "ready", findings });
        setSelectedId(findings[0]?.id ?? null);
        setPreparedAt(new Date().toISOString());
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Impossible de lire le registre par requête.",
        });
      }
    }

    void loadFindings();
    return () => controller.abort();
  }, [latestRun.id, projectId, scoringVersion]);

  const findings = state.status === "ready" ? state.findings : [];
  const selected =
    findings.find((finding) => finding.id === selectedId) ?? findings[0] ?? null;

  function selectFinding(finding: SignalFinding) {
    setSelectedId(finding.id);
    setPreparedAt(new Date().toISOString());
  }

  const runContext: PassportRunContext = {
    status: latestRun.status,
    completedAt: latestRun.completedAt,
    progress: latestRun.progress,
  };

  return (
    <section aria-labelledby="signal-findings-title" className="ledger-section">
      <div className="ledger-section-heading">
        <div>
          <p className="ledger-kicker">File d’enquête · données appariées</p>
          <h2 id="signal-findings-title">Constats de signal</h2>
        </div>
        <p className="ledger-section-note">
          Les rapprochements restent descriptifs : ils n’établissent ni cause,
          ni significativité statistique.
        </p>
      </div>

      {state.status === "loading" ? (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.08fr)_minmax(19rem,.92fr)]">
          <div className="space-y-2" aria-label="Chargement des findings">
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="h-24 rounded-md" />
            ))}
          </div>
          <Skeleton className="h-80 rounded-[10px]" />
        </div>
      ) : state.status === "error" ? (
        <div className="border-l-2 border-primary bg-card px-5 py-4" role="status">
          <p className="flex items-center gap-2 font-medium">
            <WarningCircle size={18} weight="regular" aria-hidden />
            Findings indisponibles
          </p>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {state.message} Le reste du relevé reste consultable.
          </p>
        </div>
      ) : findings.length === 0 ? (
        <div className="border-y border-border py-8">
          <p className="font-medium">Aucun écart classable sur ce run.</p>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Il faut deux cellules mesurées pour la même requête et le même
            fournisseur. Les valeurs absentes ne sont jamais remplacées par zéro.
          </p>
        </div>
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.08fr)_minmax(19rem,.92fr)]">
          <div>
            <ol className="divide-y divide-border border-y border-border">
              {findings.map((finding, index) => {
                const Icon = FINDING_ICON[finding.kind];
                const isSelected = finding.id === selected?.id;
                return (
                  <li key={finding.id}>
                    <button
                      type="button"
                      onClick={() => selectFinding(finding)}
                      aria-pressed={isSelected}
                      aria-controls="measurement-passport"
                      className={cn(
                        "group grid w-full grid-cols-[2rem_minmax(0,1fr)_auto] gap-3 px-2 py-4 text-left transition-[background-color,transform] duration-200 active:translate-y-px",
                        isSelected ? "bg-secondary" : "hover:bg-card"
                      )}
                    >
                      <span className="font-mono text-xs text-muted-foreground">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2">
                          <Icon size={18} weight="regular" aria-hidden />
                          <span className="text-sm font-semibold">
                            {FINDING_LABEL[finding.kind]}
                          </span>
                          {finding.lowN ? (
                            <span
                              className={cn(
                                "ledger-tag",
                                isSelected && "border-foreground/40 text-foreground"
                              )}
                            >
                              faible n
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-1 block truncate text-sm">
                          {finding.queryText}
                        </span>
                        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                          {findingSentence(finding)} {supportText(finding)}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "self-center text-right font-mono text-lg font-medium tabular-nums",
                          isSelected ? "text-foreground" : "text-primary"
                        )}
                      >
                        {formatGap(finding.gap)}
                        <span className="block text-[10px] font-normal text-muted-foreground">
                          points
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Ordre éditorial : invisibilité, érosion, récupération ; puis ampleur
              observée. Seuil d’écart : ±5 points. Invisibilité : présence observée
              nulle dans les deux modes appariés.
            </p>
          </div>

          {selected && preparedAt ? (
            <MeasurementPassport
              key={selected.id}
              finding={selected}
              payload={buildMeasurementPassport({
                finding: selected,
                projectName,
                brandNames,
                scoringVersion,
                run: runContext,
                exportedAt: preparedAt,
              })}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}

function MeasurementPassport({
  finding,
  payload,
}: {
  finding: SignalFinding;
  payload: MeasurementPassportPayload;
}) {
  const [message, setMessage] = React.useState<{
    tone: "ok" | "error";
    text: string;
  } | null>(null);
  const markdown = React.useMemo(
    () => renderMeasurementPassportMarkdown(payload),
    [payload]
  );

  async function copyMarkdown() {
    setMessage(null);
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Le presse-papiers n’est pas disponible dans ce navigateur.");
      }
      await navigator.clipboard.writeText(markdown);
      setMessage({ tone: "ok", text: "Markdown copié dans le presse-papiers." });
    } catch (error) {
      setMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "La copie a échoué. Téléchargez le JSON à la place.",
      });
    }
  }

  function downloadJson() {
    setMessage(null);
    let objectUrl: string | null = null;
    try {
      const blob = new Blob([serializeMeasurementPassport(payload)], {
        type: "application/json;charset=utf-8",
      });
      objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = measurementPassportFilename(payload);
      link.hidden = true;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setMessage({ tone: "ok", text: "Passeport JSON téléchargé." });
    } catch {
      setMessage({
        tone: "error",
        text: "Le téléchargement n’a pas pu être préparé.",
      });
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  return (
    <aside
      id="measurement-passport"
      aria-labelledby="measurement-passport-title"
      className="measurement-passport"
    >
      <div className="flex items-start justify-between gap-4 border-b border-current/20 pb-4">
        <div>
          <p className="ledger-kicker text-current/60">Pièce exportable · v1</p>
          <h3 id="measurement-passport-title" className="mt-1 text-xl font-semibold">
            Passeport de mesure
          </h3>
        </div>
        <span className="ledger-tag border-current/30 text-current">
          {finding.lowN ? "indicatif" : "mesuré"}
        </span>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <div>
          <dt className="passport-label">Projet</dt>
          <dd className="mt-1 text-pretty">{payload.project.name}</dd>
        </div>
        <div>
          <dt className="passport-label">Marques mesurées</dt>
          <dd className="mt-1 text-pretty">
            {payload.brands.names.length > 0
              ? payload.brands.names.join(", ")
              : "indisponible"}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="passport-label">Requête</dt>
          <dd className="mt-1 text-pretty">{finding.queryText}</dd>
        </div>
        <div>
          <dt className="passport-label">Fournisseur</dt>
          <dd className="mt-1 font-mono text-xs">{finding.providerLabel}</dd>
        </div>
        <div>
          <dt className="passport-label">Écart G − P</dt>
          <dd className="mt-1 font-mono text-lg tabular-nums">
            {formatGap(finding.gap)} pts
          </dd>
        </div>
      </dl>

      <div className="mt-4 divide-y divide-current/20 border-y border-current/20">
        {payload.measurement.axes.map((axis) => (
          <div key={axis.mode} className="grid grid-cols-[1fr_auto] gap-3 py-3 text-sm">
            <div>
              <p className="passport-label">{axis.mode}</p>
              <p className="mt-1 text-xs text-current/70">
                {intervalText(axis.interval.low, axis.interval.high)} · n = {axis.n}
                {axis.rawN !== null ? ` · brut ${axis.rawN}` : ""}
                {axis.cellN !== null ? ` · ${axis.cellN} cellule(s)` : ""}
              </p>
              <p className="mt-1 font-mono text-[10px] text-current/60">
                {axis.method ?? "méthode indisponible"}
              </p>
            </div>
            <p className="self-center font-mono text-2xl tabular-nums">
              {formatMetric(axis.median)}
            </p>
          </div>
        ))}
      </div>

      <p className="mt-4 text-xs leading-relaxed text-current/70">
        {payload.measurement.notice}
      </p>

      <details className="passport-preview" open>
        <summary>
          Prévisualiser le Markdown
          <CaretDown size={15} weight="regular" aria-hidden />
        </summary>
        <pre>{markdown}</pre>
      </details>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <button type="button" onClick={() => void copyMarkdown()} className="passport-action">
          <ClipboardText size={17} weight="regular" aria-hidden />
          Copier en Markdown
        </button>
        <button type="button" onClick={downloadJson} className="passport-action passport-action-secondary">
          <DownloadSimple size={17} weight="regular" aria-hidden />
          Télécharger JSON
        </button>
      </div>

      <p
        className={cn(
          "mt-3 min-h-5 text-xs",
          message?.tone === "error" ? "font-medium text-background" : "text-current/70"
        )}
        role="status"
        aria-live="polite"
      >
        {message?.text ?? "Aucun identifiant interne ni réponse brute n’est exporté."}
      </p>
    </aside>
  );
}
