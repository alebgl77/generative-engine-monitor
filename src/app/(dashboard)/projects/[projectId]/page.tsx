"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowDownRight,
  ArrowUpRight,
  ArrowsClockwise,
  Globe,
  GlobeHemisphereWest,
  Info,
  Minus,
  Play,
  Users,
  WarningCircle,
} from "@phosphor-icons/react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ErrorBar,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { RunStatus } from "@prisma/client";
import type {
  ApiErrorResponse,
  AxisSummary,
  OverviewResponse,
  ProviderModeScore,
  RunCreatedResponse,
} from "@/types/api";
import { AxisCard, MODE_HINT, MODE_LABEL } from "@/components/dashboard/axis-card";
import { SignalFindings } from "@/components/dashboard/signal-findings";
import { useProjectIdentity } from "@/components/dashboard/project-identity";
import {
  INTERVAL_HINT,
  LOW_N_CAVEAT,
  formatInterval,
  formatScore,
} from "@/components/dashboard/score-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { InfoTooltip, Tooltip } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: OverviewResponse };

const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  PENDING: "En attente",
  RUNNING: "En cours",
  COMPLETED: "Terminé",
  PARTIAL: "Partiel",
  FAILED: "Échoué",
  CANCELLING: "Annulation…",
  CANCELLED: "Annulé",
};

/** Below this many points the two channels are treated as agreeing. */
const GAP_NEUTRAL_BAND = 5;

const CHART_PALETTE = {
  grounded: "hsl(var(--primary))",
  parametric: "hsl(var(--muted-foreground))",
  grid: "hsl(var(--border))",
  axis: "hsl(var(--muted-foreground))",
  errorBar: "hsl(var(--foreground))",
};

function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)} %`;
}

export default function ProjectOverviewPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const router = useRouter();
  const { toast } = useToast();
  const { projectName } = useProjectIdentity();

  const [state, setState] = React.useState<LoadState>({ status: "loading" });
  const [launching, setLaunching] = React.useState(false);
  const [skipped, setSkipped] = React.useState<RunCreatedResponse["skipped"]>([]);
  const requestRef = React.useRef(0);

  const load = React.useCallback(async (signal?: AbortSignal) => {
    const requestId = ++requestRef.current;
    setState({ status: "loading" });
    try {
      const res = await fetch(
        `/api/projects/${projectId}/dashboard/overview`,
        { cache: "no-store", signal }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as ApiErrorResponse | null;
        throw new Error(body?.error ?? `Erreur ${res.status}`);
      }
      const data = (await res.json()) as OverviewResponse;
      if (requestId !== requestRef.current) return;
      setState({ status: "ready", data });
    } catch (error) {
      if (signal?.aborted) return;
      if (requestId !== requestRef.current) return;
      setState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Impossible de charger les résultats.",
      });
    }
  }, [projectId]);

  React.useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [load]);

  async function launchRun() {
    setLaunching(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/runs`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as ApiErrorResponse | null;
        throw new Error(body?.error ?? `Erreur ${res.status}`);
      }
      const created = (await res.json()) as RunCreatedResponse;
      setSkipped(created.skipped);
      if (created.skipped.length > 0) {
        toast({
          title: "Analyse lancée, certaines cellules ont été ignorées",
          description: created.skipped
            .map(
              (s) =>
                `${s.providerCode} · ${MODE_LABEL[s.mode]} : ${s.reason}`
            )
            .join(" — "),
        });
      } else {
        toast({
          title: "Analyse lancée",
          description: `${created.totalTasks} cellules, ${created.totalSamples} appels planifiés.`,
        });
      }
      router.push(`/projects/${projectId}/runs`);
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Le lancement a échoué",
        description:
          error instanceof Error
            ? error.message
            : "Impossible de lancer l'analyse.",
      });
    } finally {
      setLaunching(false);
    }
  }

  if (state.status === "loading") {
    return <OverviewSkeleton />;
  }

  if (state.status === "error") {
    return (
      <Card className="rounded-[10px] border-destructive/40 bg-card shadow-none">
        <CardHeader>
          <div className="flex items-center gap-2">
            <WarningCircle size={20} weight="regular" className="text-destructive" aria-hidden />
            <CardTitle className="text-base">
              Les résultats n&apos;ont pas pu être chargés
            </CardTitle>
          </div>
          <CardDescription>{state.message}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <ArrowsClockwise size={16} weight="regular" className="mr-2" aria-hidden />
            Réessayer
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { data } = state;

  if (!data.latestRun) {
    return (
      <Card className="rounded-[10px] border-foreground/30 bg-card shadow-none">
        <CardHeader>
          <p className="ledger-kicker">Registre vide</p>
          <CardTitle className="text-lg">Aucune analyse disponible</CardTitle>
          <CardDescription>
            Configurez votre marque, vos concurrents et vos requêtes, puis
            lancez une première analyse. Chaque requête sera posée à tous les
            moteurs disponibles, en mode paramétrique et groundé, et répétée
            plusieurs fois afin de produire des intervalles de confiance.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button
            variant="outline"
            onClick={() => router.push(`/projects/${projectId}/settings`)}
          >
            Configurer le projet
          </Button>
          <Button onClick={() => void launchRun()} disabled={launching}>
            <Play size={16} weight="regular" className="mr-2" aria-hidden />
            {launching ? "Lancement…" : "Lancer une analyse"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { latestRun } = data;

  return (
    <div className="ledger-enter space-y-12">
      <header className="grid gap-6 border-b border-foreground/70 pb-7 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div>
          <p className="ledger-kicker">Dernier relevé · preuves API</p>
          <h2 className="mt-2 max-w-3xl text-4xl font-semibold leading-[0.95] tracking-[-0.055em] sm:text-5xl">
            État des signaux
          </h2>
          <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
            <span className="ledger-tag">{RUN_STATUS_LABEL[latestRun.status]}</span>
            <span className="font-mono tabular-nums">
              {latestRun.progress.doneSamples}/{latestRun.progress.totalSamples} appels
            </span>
            {latestRun.progress.failedSamples > 0 ? (
              <span className="font-mono tabular-nums text-destructive">
                {latestRun.progress.failedSamples} en échec
              </span>
            ) : null}
            <span aria-hidden>·</span>
            <span>{data.totalQueries} requêtes</span>
            <span aria-hidden>·</span>
            <Tooltip content="Version de l'algorithme de score utilisée pour ces résultats. Les runs scorés avec des versions différentes ne se comparent pas directement.">
              <span className="font-mono underline decoration-dotted underline-offset-4">
                scoring {data.scoringVersion}
              </span>
            </Tooltip>
            {latestRun.completedAt ? (
              <>
                <span aria-hidden>·</span>
                <time dateTime={latestRun.completedAt} className="font-mono">
                  {new Date(latestRun.completedAt).toLocaleString("fr-FR")}
                </time>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          <Button variant="ghost" size="sm" onClick={() => void load()} className="rounded-sm">
            <ArrowsClockwise size={16} weight="regular" className="mr-2" aria-hidden />
            Actualiser
          </Button>
          <Button onClick={() => void launchRun()} disabled={launching} className="rounded-sm">
            <Play size={16} weight="regular" className="mr-2" aria-hidden />
            {launching ? "Lancement…" : "Nouvelle analyse"}
          </Button>
        </div>
      </header>

      {skipped.length > 0 && (
        <div className="flex items-start gap-2 border-l-2 border-primary bg-card px-4 py-3 text-sm">
          <Info size={16} weight="regular" className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
          <div>
            <p className="font-medium">Cellules ignorées lors du lancement</p>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              {skipped.map((entry) => (
                <li key={`${entry.providerCode}-${entry.mode}`}>
                  {entry.providerCode} · {MODE_LABEL[entry.mode]} —{" "}
                  {entry.reason}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <SignalFindings
        key={`${projectId}:${latestRun.id}:${data.scoringVersion}`}
        projectId={projectId}
        projectName={projectName}
        brandNames={data.shareOfVoice
          .filter((entity) => entity.kind === "BRAND")
          .map((entity) => entity.name)
          .sort()}
        scoringVersion={data.scoringVersion}
        latestRun={latestRun}
      />

      <section aria-labelledby="axes-title" className="ledger-section">
        <div className="ledger-section-heading">
          <div>
            <p className="ledger-kicker">01 · Calibration</p>
            <h2 id="axes-title">Deux canaux, deux lectures</h2>
          </div>
          <p className="ledger-section-note">
            Médianes, intervalles, stabilité et effectifs restent visibles : le
            score seul ne suffit pas à qualifier un signal.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-[1.14fr_.86fr]">
          <AxisCard
            title="Visibilité groundée"
            explanation="Ce que les moteurs récupèrent via leur recherche web native dans les appels API observés."
            summary={data.grounded}
            icon={GlobeHemisphereWest}
            hint={MODE_HINT.GROUNDED}
            emptyMessage="Aucune cellule groundée sur le dernier run : aucun moteur configuré ne sert ce mode."
            className="rounded-[10px] border-foreground/30 bg-card shadow-none"
          />
          <AxisCard
            title="Visibilité paramétrique"
            explanation="Ce que les modèles restituent sans recherche web dans les appels API observés."
            summary={data.parametric}
            icon={Users}
            hint={MODE_HINT.PARAMETRIC}
            emptyMessage="Aucune cellule paramétrique sur le dernier run."
            className="rounded-[10px] border-foreground/30 bg-card shadow-none"
          />
        </div>
      </section>

      <section aria-label="Écart de récupération" className="ledger-section">
        <RetrievalGapCard
          gap={data.retrievalGap}
          retrieval={data.retrieval}
          grounded={data.grounded}
          parametric={data.parametric}
        />
      </section>

      <section aria-labelledby="terrain-title" className="ledger-section">
        <div className="ledger-section-heading">
          <div>
            <p className="ledger-kicker">02 · Terrain observé</p>
            <h2 id="terrain-title">Voix et moteurs</h2>
          </div>
          <p className="ledger-section-note">
            Occupation des réponses et distribution par fournisseur, sur le run
            courant uniquement.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-[.82fr_1.18fr]">
          <ShareOfVoiceCard entities={data.shareOfVoice} />
          <ProviderModeCard scores={data.scoreByProviderMode} />
        </div>
      </section>

      <section aria-labelledby="sources-title" className="ledger-section">
        <div className="ledger-section-heading">
          <div>
            <p className="ledger-kicker">03 · Provenance</p>
            <h2 id="sources-title">Sources citées</h2>
          </div>
          <p className="ledger-section-note">
            Les domaines sont issus des citations du run, jamais d’une liste
            déclarative ou simulée.
          </p>
        </div>
        <TopSourcesCard sources={data.topSources} projectId={projectId} />
      </section>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-12" aria-label="Chargement du relevé">
      <div className="flex items-end justify-between border-b border-foreground/30 pb-7">
        <div className="space-y-3">
          <Skeleton className="h-3 w-36 rounded-sm" />
          <Skeleton className="h-12 w-72 max-w-[80vw] rounded-md" />
        </div>
        <Skeleton className="h-10 w-40" />
      </div>
      <div className="grid gap-5 lg:grid-cols-[1.08fr_.92fr]">
        <div className="space-y-2">
          <Skeleton className="h-24 w-full rounded-md" />
          <Skeleton className="h-24 w-full rounded-md" />
          <Skeleton className="h-24 w-full rounded-md" />
        </div>
        <Skeleton className="h-80 w-full rounded-[10px]" />
      </div>
      <div className="grid gap-4 md:grid-cols-[1.14fr_.86fr]">
        <Skeleton className="h-52 w-full rounded-[10px]" />
        <Skeleton className="h-52 w-full rounded-[10px]" />
      </div>
      <Skeleton className="h-48 w-full rounded-[10px]" />
    </div>
  );
}

interface GapReading {
  icon: typeof ArrowUpRight;
  text: string;
  border: string;
}

function readGap(gap: number): GapReading {
  if (gap > GAP_NEUTRAL_BAND) {
    return {
      icon: ArrowUpRight,
      text: "text-primary",
      border: "border-primary/60",
    };
  }
  if (gap < -GAP_NEUTRAL_BAND) {
    return {
      icon: ArrowDownRight,
      text: "text-primary",
      border: "border-primary/60",
    };
  }
  return {
    icon: Minus,
    text: "text-muted-foreground",
    border: "border-foreground/30",
  };
}

function RetrievalGapCard({
  gap,
  retrieval,
  grounded,
  parametric,
}: {
  gap: number | null;
  retrieval: OverviewResponse["retrieval"];
  grounded: AxisSummary | null;
  parametric: AxisSummary | null;
}) {
  if (gap === null || !grounded || !parametric) {
    return (
      <Card className="rounded-[10px] border-foreground/30 bg-card shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Écart de récupération</CardTitle>
          <CardDescription>
            Cet écart compare ce que les moteurs récupèrent en direct à ce que
            les modèles ont retenu. Il exige les deux axes : lancez une analyse
            couvrant les modes groundé et paramétrique pour l&apos;obtenir.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const reading = readGap(gap);
  const Icon = reading.icon;
  const hasInterval = retrieval?.ciLow != null && retrieval?.ciHigh != null;
  const overlapping = !hasInterval || (retrieval!.ciLow! <= 0 && retrieval!.ciHigh! >= 0);
  const uncertain = !hasInterval || retrieval?.lowN !== false;

  return (
    <Card className={cn("rounded-[10px] border bg-card shadow-none", reading.border)}>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">Écart de récupération</CardTitle>
          <InfoTooltip label="Moyenne des différences groundé − paramétrique dans les mêmes cellules requête/API, puis poids égal des requêtes. Les fournisseurs mono-mode sont exclus. Comparaison descriptive, pas effet causal ni expérience des interfaces publiques." />
        </div>
        <CardDescription>
          Visibilité groundée − visibilité paramétrique
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-baseline gap-2">
            <Icon size={28} weight="regular" className={reading.text} aria-hidden />
            <span
              className={cn(
                "text-5xl font-semibold tabular-nums leading-none",
                reading.text
              )}
            >
              {gap > 0 ? "+" : ""}
              {Math.round(gap)}
            </span>
            <span className="text-base text-muted-foreground">points</span>
          </div>
          <div className="space-y-1 text-xs text-muted-foreground">
            <p className="tabular-nums">
              Groundé {formatScore(grounded)} ({formatInterval(grounded)})
            </p>
            <p className="tabular-nums">
              Paramétrique {formatScore(parametric)} (
              {formatInterval(parametric)})
            </p>
          </div>
        </div>

        <p className={cn("text-sm font-medium", reading.text)}>
{uncertain || overlapping ? "Écart descriptif, interprétation prudente" : "Différence observée sur le panel API apparié"}
        </p>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
Cette comparaison porte sur les réponses API et les paramètres de ce run, pas sur une part de marché ou une expérience publique personnalisée. Le sens de l&apos;écart n&apos;établit pas sa cause.
        </p>

        <p className="text-xs text-muted-foreground">
          {retrieval?.pairedQueries ?? 0} requêtes appariées · {retrieval?.pairedCells ?? 0} cellules · {retrieval?.excludedModeOnlyCells ?? 0} cellules mono-mode exclues.
          {hasInterval ? ` IC apparié : ${retrieval!.ciLow!.toFixed(1)} – ${retrieval!.ciHigh!.toFixed(1)}` : " IC apparié indisponible."}
        </p>
        {overlapping && (
          <p className="flex items-start gap-1.5 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs leading-snug text-muted-foreground">
            <Info size={14} weight="regular" className="mt-px shrink-0" aria-hidden />
            L&apos;intervalle apparié est indisponible ou contient zéro : aucune conclusion de différence.
            Des requêtes distinctes supplémentaires peuvent améliorer la mesure ; répéter les mêmes questions n&apos;augmente pas l&apos;effectif indépendant.
          </p>
        )}
        {uncertain && (
          <p className="text-xs italic text-primary">{LOW_N_CAVEAT}</p>
        )}
      </CardContent>
    </Card>
  );
}

function ShareOfVoiceCard({
  entities,
}: {
  entities: OverviewResponse["shareOfVoice"];
}) {
  const ranked = [...entities].sort((a, b) => b.mentionShare - a.mentionShare);
  const max = ranked.reduce((acc, e) => Math.max(acc, e.mentionShare), 0);

  return (
    <Card className="rounded-[10px] border-foreground/30 bg-card shadow-none">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">Part de voix</CardTitle>
          <InfoTooltip label="Part des mentions captées par chaque entité sur l'ensemble des réponses du run, votre marque et vos concurrents confondus." />
        </div>
        <CardDescription>
          Qui occupe le terrain dans les réponses des moteurs
        </CardDescription>
      </CardHeader>
      <CardContent>
        {ranked.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            Aucune entité détectée dans les réponses du dernier run.
          </p>
        ) : (
          <ol className="space-y-3">
            {ranked.map((entity, index) => {
              const isBrand = entity.kind === "BRAND";
              const width = max > 0 ? (entity.mentionShare / max) * 100 : 0;
              return (
                <li key={entity.entityId} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="w-4 shrink-0 tabular-nums text-xs text-muted-foreground">
                        {index + 1}
                      </span>
                      <span
                        className={cn(
                          "truncate",
                          isBrand ? "font-semibold" : "font-medium"
                        )}
                      >
                        {entity.name}
                      </span>
                      {isBrand && (
                        <Badge variant="default" className="shrink-0 rounded-sm">
                          Votre marque
                        </Badge>
                      )}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {formatPercent(entity.mentionShare)}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-sm bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-sm",
                        isBrand ? "bg-primary" : "bg-muted-foreground/50"
                      )}
                      style={{ width: `${width}%` }}
                    />
                  </div>
                  <p className="text-[11px] tabular-nums text-muted-foreground">
                    Citations {formatPercent(entity.citationShare)} · Présence{" "}
                    {formatPercent(entity.presenceRate)}
                    {entity.avgOrderRank !== null &&
                      ` · Rang moyen ${entity.avgOrderRank.toFixed(1)}`}
                  </p>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

interface ChartRow {
  provider: string;
  GROUNDED?: number;
  GROUNDED_error?: [number, number];
  GROUNDED_meta?: ProviderModeScore;
  PARAMETRIC?: number;
  PARAMETRIC_error?: [number, number];
  PARAMETRIC_meta?: ProviderModeScore;
}

function deviations(score: ProviderModeScore): [number, number] | undefined {
  if (score.median === null || score.ciLow === null || score.ciHigh === null) return undefined;
  return [
    Math.max(0, score.median - score.ciLow),
    Math.max(0, score.ciHigh - score.median),
  ];
}

function buildChartRows(scores: ProviderModeScore[]): ChartRow[] {
  const order: string[] = [];
  const rows: Record<string, ChartRow> = {};
  for (const score of scores) {
    let row = rows[score.providerCode];
    if (!row) {
      row = { provider: score.providerLabel };
      order.push(score.providerCode);
    }
    if (score.mode === "GROUNDED") {
      row.GROUNDED = score.median ?? undefined;
      row.GROUNDED_error = deviations(score);
      row.GROUNDED_meta = score;
    } else {
      row.PARAMETRIC = score.median ?? undefined;
      row.PARAMETRIC_error = deviations(score);
      row.PARAMETRIC_meta = score;
    }
    rows[score.providerCode] = row;
  }
  return order.map((code) => rows[code]);
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: { payload?: ChartRow }[];
}

function ChartTooltip({ active, payload }: ChartTooltipProps) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;

  const entries = [row.GROUNDED_meta, row.PARAMETRIC_meta].filter(
    (meta): meta is ProviderModeScore => Boolean(meta)
  );

  return (
    <div className="rounded-md border border-foreground/30 bg-popover px-3 py-2 text-xs shadow-none">
      <p className="mb-1 font-medium text-popover-foreground">{row.provider}</p>
      {entries.map((meta) => (
        <p key={meta.mode} className="tabular-nums text-muted-foreground">
          {MODE_LABEL[meta.mode]} : {formatScore(meta)} ·{" "}
          {formatInterval(meta)} · n = {meta.n}
          {meta.lowN ? ` · ${LOW_N_CAVEAT}` : ""}
        </p>
      ))}
    </div>
  );
}

function ProviderModeCard({ scores }: { scores: ProviderModeScore[] }) {
  const palette = CHART_PALETTE;
  const rows = React.useMemo(() => buildChartRows(scores), [scores]);
  const hasLowN = scores.some((score) => score.lowN);

  return (
    <Card className="rounded-[10px] border-foreground/30 bg-card shadow-none">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">
            Score par moteur et par mode
          </CardTitle>
          <InfoTooltip label={INTERVAL_HINT} />
        </div>
        <CardDescription>
          Chaque barre porte son intervalle de confiance : deux barres dont les
          moustaches se recouvrent ne sont pas départageables.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            Aucun score par moteur pour le dernier run.
          </p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ backgroundColor: palette.grounded }}
                />
                {MODE_LABEL.GROUNDED}
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ backgroundColor: palette.parametric }}
                />
                {MODE_LABEL.PARAMETRIC}
              </span>
            </div>
            <div aria-hidden="true">
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke={palette.grid}
                  vertical={false}
                />
                <XAxis
                  dataKey="provider"
                  tick={{ fontSize: 11, fill: palette.axis }}
                  stroke={palette.grid}
                />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fontSize: 11, fill: palette.axis }}
                  stroke={palette.grid}
                />
                <RechartsTooltip
                  cursor={{ fill: palette.grid, fillOpacity: 0.3 }}
                  content={<ChartTooltip />}
                />
                <Bar
                  dataKey="GROUNDED"
                  name={MODE_LABEL.GROUNDED}
                  fill={palette.grounded}
                  radius={[3, 3, 0, 0]}
                >
                  {rows.map((row, index) => (
                    <Cell
                      key={`grounded-${index}`}
                      fillOpacity={row.GROUNDED_meta?.lowN ? 0.4 : 1}
                    />
                  ))}
                  <ErrorBar
                    dataKey="GROUNDED_error"
                    width={4}
                    strokeWidth={1.5}
                    stroke={palette.errorBar}
                    direction="y"
                  />
                </Bar>
                <Bar
                  dataKey="PARAMETRIC"
                  name={MODE_LABEL.PARAMETRIC}
                  fill={palette.parametric}
                  radius={[3, 3, 0, 0]}
                >
                  {rows.map((row, index) => (
                    <Cell
                      key={`parametric-${index}`}
                      fillOpacity={row.PARAMETRIC_meta?.lowN ? 0.4 : 1}
                    />
                  ))}
                  <ErrorBar
                    dataKey="PARAMETRIC_error"
                    width={4}
                    strokeWidth={1.5}
                    stroke={palette.errorBar}
                    direction="y"
                  />
                </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <table className="sr-only">
              <caption>
                Scores par fournisseur et par mode, avec support de mesure
              </caption>
              <thead>
                <tr>
                  <th scope="col">Fournisseur</th>
                  <th scope="col">Mode</th>
                  <th scope="col">Médiane</th>
                  <th scope="col">Intervalle</th>
                  <th scope="col">Effectif</th>
                  <th scope="col">Méthode</th>
                  <th scope="col">Faible effectif</th>
                </tr>
              </thead>
              <tbody>
                {scores.map((score) => (
                  <tr key={`${score.providerCode}-${score.mode}`}>
                    <th scope="row">{score.providerLabel}</th>
                    <td>{MODE_LABEL[score.mode]}</td>
                    <td>{formatScore(score)}</td>
                    <td>{formatInterval(score)}</td>
                    <td>
                      n = {score.n}{" "}
                      {score.nUnit === "queries"
                        ? "requêtes"
                        : score.nUnit === "samples"
                          ? "échantillons"
                          : "unité indisponible"}
                    </td>
                    <td>{score.ciMethod ?? "indisponible"}</td>
                    <td>{score.lowN ? "oui" : "non"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {hasLowN && (
              <p className="mt-2 text-[11px] italic text-primary">
                Les barres translucides reposent sur un {LOW_N_CAVEAT}.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TopSourcesCard({
  sources,
  projectId,
}: {
  sources: OverviewResponse["topSources"];
  projectId: string;
}) {
  const max = sources.reduce((acc, s) => Math.max(acc, s.citationShare), 0);

  return (
    <Card className="rounded-[10px] border-foreground/30 bg-card shadow-none">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Globe size={16} weight="regular" className="text-muted-foreground" aria-hidden />
          <CardTitle className="text-base">Sources les plus citées</CardTitle>
        </div>
        <CardDescription>
          Les domaines sur lesquels les moteurs s&apos;appuient pour répondre.
          C&apos;est le levier direct de la visibilité groundée.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sources.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            Aucune source citée sur le dernier run.
          </p>
        ) : (
          <ul className="space-y-2">
            {sources.map((source) => (
              <li
                key={source.domain}
                className={cn(
                  "flex items-center gap-3 rounded-sm border px-3 py-2",
                  source.isBrandDomain
                    ? "border-primary/50 bg-primary/5"
                    : "border-transparent bg-muted/40"
                )}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate font-mono text-sm">
                    {source.domain}
                  </span>
                  {source.isBrandDomain && (
                    <Badge variant="default" className="shrink-0 rounded-sm">
                      Votre domaine
                    </Badge>
                  )}
                </span>
                <span className="hidden h-2 w-32 overflow-hidden rounded-sm bg-muted sm:block">
                  <span
                    className={cn(
                      "block h-full rounded-sm",
                      source.isBrandDomain
                        ? "bg-primary"
                        : "bg-muted-foreground/50"
                    )}
                    style={{
                      width: `${max > 0 ? (source.citationShare / max) * 100 : 0}%`,
                    }}
                  />
                </span>
                <span className="w-28 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {formatPercent(source.citationShare)} ·{" "}
                  {source.citationCount} cit.
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-xs text-muted-foreground">
          <Link
            href={`/projects/${projectId}/sources`}
            className="underline underline-offset-2 hover:text-foreground"
          >
            Voir toutes les sources
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
