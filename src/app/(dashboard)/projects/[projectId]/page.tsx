"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  Globe,
  Info,
  Minus,
  Play,
  RefreshCw,
  Radar,
  Users,
} from "lucide-react";
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

const FALLBACK_PALETTE = {
  grounded: "hsl(220 70% 50%)",
  parametric: "hsl(220 9% 46%)",
  grid: "hsl(220 13% 91%)",
  axis: "hsl(220 9% 46%)",
  errorBar: "hsl(224 71% 4%)",
};

type ChartPalette = typeof FALLBACK_PALETTE;

function useChartPalette(): ChartPalette {
  const [palette, setPalette] = React.useState<ChartPalette>(FALLBACK_PALETTE);

  React.useEffect(() => {
    const styles = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) => {
      const raw = styles.getPropertyValue(name).trim();
      return raw ? `hsl(${raw})` : fallback;
    };
    setPalette({
      grounded: read("--primary", FALLBACK_PALETTE.grounded),
      parametric: read("--muted-foreground", FALLBACK_PALETTE.parametric),
      grid: read("--border", FALLBACK_PALETTE.grid),
      axis: read("--muted-foreground", FALLBACK_PALETTE.axis),
      errorBar: read("--foreground", FALLBACK_PALETTE.errorBar),
    });
  }, []);

  return palette;
}

function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)} %`;
}

function intervalsOverlap(a: AxisSummary, b: AxisSummary): boolean {
  return a.ciLow <= b.ciHigh && b.ciLow <= a.ciHigh;
}

export default function ProjectOverviewPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const router = useRouter();
  const { toast } = useToast();

  const [state, setState] = React.useState<LoadState>({ status: "loading" });
  const [launching, setLaunching] = React.useState(false);
  const [skipped, setSkipped] = React.useState<RunCreatedResponse["skipped"]>([]);
  const requestRef = React.useRef(0);

  const load = React.useCallback(async () => {
    const requestId = ++requestRef.current;
    setState({ status: "loading" });
    try {
      const res = await fetch(
        `/api/projects/${projectId}/dashboard/overview`,
        { cache: "no-store" }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as ApiErrorResponse | null;
        throw new Error(body?.error ?? `Erreur ${res.status}`);
      }
      const data = (await res.json()) as OverviewResponse;
      if (requestId !== requestRef.current) return;
      setState({ status: "ready", data });
    } catch (error) {
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
    void load();
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
      <Card className="border-destructive/40">
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-destructive" aria-hidden />
            <CardTitle className="text-base">
              Les résultats n&apos;ont pas pu être chargés
            </CardTitle>
          </div>
          <CardDescription>{state.message}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
            Réessayer
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { data } = state;

  if (!data.latestRun) {
    return (
      <Card>
        <CardHeader>
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
            <Play className="mr-2 h-4 w-4" aria-hidden />
            {launching ? "Lancement…" : "Lancer une analyse"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { latestRun } = data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="secondary">
            {RUN_STATUS_LABEL[latestRun.status]}
          </Badge>
          <span className="tabular-nums">
            {latestRun.progress.doneSamples}/{latestRun.progress.totalSamples}{" "}
            appels
          </span>
          {latestRun.progress.failedSamples > 0 && (
            <span className="tabular-nums text-destructive">
              {latestRun.progress.failedSamples} en échec
            </span>
          )}
          <span>·</span>
          <span>{data.totalQueries} requêtes</span>
          <span>·</span>
          <Tooltip content="Version de l'algorithme de score utilisée pour ces résultats. Les runs scorés avec des versions différentes ne se comparent pas directement.">
            <span className="underline decoration-dotted underline-offset-2">
              scoring {data.scoringVersion}
            </span>
          </Tooltip>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
            Actualiser
          </Button>
          <Button onClick={() => void launchRun()} disabled={launching}>
            <Play className="mr-2 h-4 w-4" aria-hidden />
            {launching ? "Lancement…" : "Nouvelle analyse"}
          </Button>
        </div>
      </div>

      {skipped.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
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

      <div className="grid gap-4 md:grid-cols-2">
        <AxisCard
          title="Visibilité groundée"
          explanation="Ce que les moteurs vont chercher en direct, recherche web activée."
          summary={data.grounded}
          icon={Radar}
          hint={MODE_HINT.GROUNDED}
          emptyMessage="Aucune cellule groundée sur le dernier run : aucun moteur configuré ne sert ce mode."
        />
        <AxisCard
          title="Visibilité paramétrique"
          explanation="Ce que les modèles ont retenu de leur entraînement, sans recherche web."
          summary={data.parametric}
          icon={Users}
          hint={MODE_HINT.PARAMETRIC}
          emptyMessage="Aucune cellule paramétrique sur le dernier run."
        />
      </div>

      <RetrievalGapCard
        gap={data.retrievalGap}
        grounded={data.grounded}
        parametric={data.parametric}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <ShareOfVoiceCard entities={data.shareOfVoice} />
        <ProviderModeCard scores={data.scoreByProviderMode} />
      </div>

      <TopSourcesCard sources={data.topSources} projectId={projectId} />
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-72" />
        <Skeleton className="h-10 w-40" />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-52 w-full" />
        <Skeleton className="h-52 w-full" />
      </div>
      <Skeleton className="h-40 w-full" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
      <Skeleton className="h-56 w-full" />
    </div>
  );
}

interface GapReading {
  headline: string;
  sentence: string;
  icon: typeof ArrowUpRight;
  text: string;
  border: string;
}

function readGap(gap: number): GapReading {
  if (gap > GAP_NEUTRAL_BAND) {
    return {
      headline: "La récupération vous porte",
      sentence:
        "Les moteurs vous trouvent mieux lorsqu'ils cherchent que lorsqu'ils s'en remettent à leur mémoire : l'investissement contenu paie, continuez à alimenter les pages qu'ils lisent.",
      icon: ArrowUpRight,
      text: "text-emerald-600",
      border: "border-emerald-500/40",
    };
  }
  if (gap < -GAP_NEUTRAL_BAND) {
    return {
      headline: "Les modèles vous connaissent, mais ne vous citent plus",
      sentence:
        "Votre notoriété est acquise dans les modèles, mais dès qu'ils cherchent en direct vous perdez du terrain : le levier n'est pas la notoriété, ce sont les sources qu'ils lisent.",
      icon: ArrowDownRight,
      text: "text-red-600",
      border: "border-red-500/40",
    };
  }
  return {
    headline: "Les deux canaux s'accordent",
    sentence:
      "Mémoire d'entraînement et recherche en direct donnent le même verdict : aucun écart à exploiter, c'est le niveau absolu de visibilité qu'il faut faire monter.",
    icon: Minus,
    text: "text-muted-foreground",
    border: "border-border",
  };
}

function RetrievalGapCard({
  gap,
  grounded,
  parametric,
}: {
  gap: number | null;
  grounded: AxisSummary | null;
  parametric: AxisSummary | null;
}) {
  if (gap === null || !grounded || !parametric) {
    return (
      <Card>
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
  const overlapping = intervalsOverlap(grounded, parametric);
  const uncertain = grounded.lowN || parametric.lowN;

  return (
    <Card className={cn("border-2", reading.border)}>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">Écart de récupération</CardTitle>
          <InfoTooltip label="Médiane groundée moins médiane paramétrique, en points de score. C'est la métrique qui dit où agir : sur le contenu que les moteurs vont chercher, ou sur les sources qui font autorité pour eux." />
        </div>
        <CardDescription>
          Visibilité groundée − visibilité paramétrique
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-baseline gap-2">
            <Icon className={cn("h-7 w-7", reading.text)} aria-hidden />
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
          {reading.headline}
        </p>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          {reading.sentence}
        </p>

        {overlapping && (
          <p className="flex items-start gap-1.5 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs leading-snug text-muted-foreground">
            <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
            Les intervalles des deux axes se recouvrent : l&apos;écart n&apos;est
            pas départageable en l&apos;état, augmentez le nombre de répétitions
            avant d&apos;en tirer une décision.
          </p>
        )}
        {uncertain && (
          <p className="text-xs italic text-amber-600">{LOW_N_CAVEAT}</p>
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
    <Card>
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
                        <Badge variant="default" className="shrink-0">
                          Votre marque
                        </Badge>
                      )}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {formatPercent(entity.mentionShare)}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full",
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

function deviations(score: ProviderModeScore): [number, number] {
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
      row.GROUNDED = score.median;
      row.GROUNDED_error = deviations(score);
      row.GROUNDED_meta = score;
    } else {
      row.PARAMETRIC = score.median;
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
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
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
  const palette = useChartPalette();
  const rows = React.useMemo(() => buildChartRows(scores), [scores]);
  const hasLowN = scores.some((score) => score.lowN);

  return (
    <Card>
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
            {hasLowN && (
              <p className="mt-2 text-[11px] italic text-amber-600">
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
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-muted-foreground" aria-hidden />
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
                  "flex items-center gap-3 rounded-md border px-3 py-2",
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
                    <Badge variant="default" className="shrink-0">
                      Votre domaine
                    </Badge>
                  )}
                </span>
                <span className="hidden h-2 w-32 overflow-hidden rounded-full bg-muted sm:block">
                  <span
                    className={cn(
                      "block h-full rounded-full",
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
