"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import type { RunStatus, SamplingMode, TaskStatus } from "@prisma/client";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  Play,
  RefreshCw,
  XCircle,
} from "lucide-react";
import type {
  ApiErrorResponse,
  AxisSummary,
  RunCreatedResponse,
  RunDetailResponse,
  RunSummary,
  RunTaskSummary,
  RunsResponse,
} from "@/types/api";
import { ScoreBreakdown } from "@/components/dashboard/score-breakdown";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 5000;

const NON_TERMINAL_RUN_STATUSES: RunStatus[] = ["PENDING", "RUNNING", "CANCELLING"];

interface StatusDisplay {
  label: string;
  className: string;
}

const RUN_STATUS: Record<RunStatus, StatusDisplay> = {
  PENDING: { label: "En attente", className: "bg-muted text-muted-foreground" },
  RUNNING: { label: "En cours", className: "bg-primary text-primary-foreground" },
  COMPLETED: { label: "Terminé", className: "bg-emerald-100 text-emerald-800" },
  PARTIAL: {
    label: "Partiel — certains échantillons ont échoué",
    className: "bg-amber-100 text-amber-900",
  },
  FAILED: { label: "Échoué", className: "bg-destructive text-destructive-foreground" },
  CANCELLING: { label: "Annulation en cours", className: "bg-amber-100 text-amber-900" },
  CANCELLED: { label: "Annulé", className: "bg-muted text-muted-foreground" },
};

const TASK_STATUS: Record<TaskStatus, StatusDisplay> = {
  PENDING: { label: "En attente", className: "bg-muted text-muted-foreground" },
  RUNNING: { label: "En cours", className: "bg-primary text-primary-foreground" },
  COMPLETED: { label: "Terminée", className: "bg-emerald-100 text-emerald-800" },
  PARTIAL: { label: "Partielle", className: "bg-amber-100 text-amber-900" },
  FAILED: { label: "Échouée", className: "bg-destructive text-destructive-foreground" },
  CANCELLED: { label: "Annulée", className: "bg-muted text-muted-foreground" },
};

const MODE_LABEL: Record<SamplingMode, string> = {
  PARAMETRIC: "Paramétrique",
  GROUNDED: "Groundé",
};

function isNonTerminal(status: RunStatus): boolean {
  return NON_TERMINAL_RUN_STATUSES.indexOf(status) >= 0;
}

function runStatusIcon(status: RunStatus) {
  switch (status) {
    case "COMPLETED":
      return <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />;
    case "PARTIAL":
      return <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />;
    case "FAILED":
      return <XCircle className="h-4 w-4 text-destructive" aria-hidden="true" />;
    case "CANCELLED":
      return <Ban className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
    case "RUNNING":
    case "CANCELLING":
      return <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />;
    default:
      return <Clock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Erreur inattendue";
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (payload as ApiErrorResponse | null)?.error;
    throw new Error(typeof error === "string" ? error : `Erreur ${response.status}`);
  }
  if (payload === null) throw new Error("Réponse illisible du serveur");
  return payload as T;
}

function formatNumber(value: number, digits = 0): string {
  return value.toLocaleString("fr-FR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("fr-FR");
}

function ScoreCell({ score }: { score: AxisSummary | null }) {
  if (!score) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex flex-col leading-tight">
      <span className="font-semibold tabular-nums">{formatNumber(score.median, 1)}</span>
      <span className="text-xs text-muted-foreground tabular-nums">
        IC {formatNumber(score.ciLow, 1)} – {formatNumber(score.ciHigh, 1)}
        {score.lowN ? " · indicatif" : ""}
      </span>
    </span>
  );
}

export default function RunsPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const { toast } = useToast();

  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [rescoring, setRescoring] = useState(false);
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null);

  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const inFlight = useRef(false);

  const loadRuns = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const data = await requestJson<RunsResponse>(`/api/projects/${projectId}/runs`);
      setRuns(data.runs);
      setLoadError(null);
    } catch (error) {
      setLoadError(messageOf(error));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const hasActiveRun = useMemo(() => runs.some((run) => isNonTerminal(run.status)), [runs]);

  // Polling exists only to watch a run finish; once everything is terminal the
  // endpoint has nothing new to say.
  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = setInterval(() => {
      void loadRuns();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasActiveRun, loadRuns]);

  const expandedRun = runs.find((run) => run.id === expandedRunId) ?? null;
  const detailStamp =
    expandedTaskId && expandedRun
      ? `${expandedRun.id}:${expandedRun.progress.doneSamples}:${expandedRun.progress.failedSamples}`
      : null;

  useEffect(() => {
    if (!detailStamp || !expandedRunId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let obsolete = false;
    setDetailLoading(true);
    requestJson<RunDetailResponse>(`/api/projects/${projectId}/runs/${expandedRunId}`)
      .then((data) => {
        if (obsolete) return;
        setDetail(data);
        setDetailError(null);
      })
      .catch((error: unknown) => {
        if (obsolete) return;
        setDetailError(messageOf(error));
      })
      .finally(() => {
        if (!obsolete) setDetailLoading(false);
      });
    return () => {
      obsolete = true;
    };
  }, [detailStamp, expandedRunId, projectId]);

  function toggleRun(runId: string) {
    setExpandedTaskId(null);
    setExpandedRunId((current) => (current === runId ? null : runId));
  }

  function toggleTask(taskId: string) {
    setExpandedTaskId((current) => (current === taskId ? null : taskId));
  }

  async function launchRun() {
    setLaunching(true);
    try {
      const created = await requestJson<RunCreatedResponse>(
        `/api/projects/${projectId}/runs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }
      );
      const skipped = created.skipped
        .map((cell) => `${cell.providerCode} · ${MODE_LABEL[cell.mode]}`)
        .join(", ");
      toast({
        title: "Analyse lancée",
        description: `${formatNumber(created.totalTasks)} tâches, ${formatNumber(
          created.totalSamples
        )} appels API.${skipped ? ` Combinaisons ignorées : ${skipped}.` : ""}`,
      });
      await loadRuns();
    } catch (error) {
      toast({
        title: "Lancement impossible",
        description: messageOf(error),
        variant: "destructive",
      });
    } finally {
      setLaunching(false);
    }
  }

  async function cancelRun(runId: string) {
    setCancellingRunId(runId);
    try {
      await requestJson<unknown>(`/api/projects/${projectId}/runs/${runId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      toast({
        title: "Annulation demandée",
        description:
          "Les appels en attente sont abandonnés ; ceux déjà partis se terminent puis s’arrêtent.",
      });
      await loadRuns();
    } catch (error) {
      toast({
        title: "Annulation impossible",
        description: messageOf(error),
        variant: "destructive",
      });
    } finally {
      setCancellingRunId(null);
    }
  }

  async function rescore() {
    setRescoring(true);
    try {
      await requestJson<unknown>(`/api/projects/${projectId}/rescore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      toast({
        title: "Recalcul des scores lancé",
        description:
          "Les réponses déjà stockées sont rejouées : aucune n’est redemandée à un moteur. L’analyse de sentiment peut en revanche consulter son juge, ce qui est facturé.",
      });
      await loadRuns();
    } catch (error) {
      toast({
        title: "Recalcul impossible",
        description: messageOf(error),
        variant: "destructive",
      });
    } finally {
      setRescoring(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Historique des analyses. Chaque analyse interroge vos requêtes sur chaque
          moteur, en mode paramétrique et groundé, plusieurs fois.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void loadRuns()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Actualiser
          </Button>
          <Button variant="outline" size="sm" onClick={() => void rescore()} disabled={rescoring}>
            <RefreshCw
              className={cn("mr-1.5 h-3.5 w-3.5", rescoring && "animate-spin")}
              aria-hidden="true"
            />
            Recalculer les scores
          </Button>
          <Button size="sm" onClick={() => void launchRun()} disabled={launching}>
            <Play className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {launching ? "Lancement…" : "Nouvelle analyse"}
          </Button>
        </div>
      </div>

      {loadError ? (
        <Alert variant="destructive" icon={<AlertTriangle />}>
          <AlertTitle>Impossible de charger les analyses</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : null}

      {runs.length === 0 ? (
        <div className="rounded-lg border border-dashed py-16 text-center">
          <Clock className="mx-auto mb-4 h-10 w-10 text-muted-foreground" aria-hidden="true" />
          <p className="text-muted-foreground">Aucune analyse pour ce projet</p>
        </div>
      ) : (
        <div className="space-y-3">
          {runs.map((run) => {
            const status = RUN_STATUS[run.status];
            const expanded = expandedRunId === run.id;
            const { totalSamples, doneSamples, failedSamples } = run.progress;
            const failedTasks = run.tasks.filter((task) => task.errorMessage);
            const distinctErrors = failedTasks
              .map((task) => `${task.provider.label} : ${task.errorMessage}`)
              .filter((message, index, all) => all.indexOf(message) === index);
            return (
              <div key={run.id} className="overflow-hidden rounded-lg border bg-card shadow-sm">
                <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <button
                    type="button"
                    onClick={() => toggleRun(run.id)}
                    aria-expanded={expanded}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {expanded ? (
                      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    )}
                    {runStatusIcon(run.status)}
                    <span className="min-w-0">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
                          status.className
                        )}
                      >
                        {status.label}
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {formatDate(run.createdAt)} · {run.repetitions} répétition
                        {run.repetitions > 1 ? "s" : ""} ·{" "}
                        {run.modes.map((mode) => MODE_LABEL[mode]).join(" + ")} · scoring{" "}
                        {run.scoringVersion}
                      </span>
                    </span>
                  </button>

                  <div className="flex items-center gap-3">
                    <div className="w-40">
                      <Progress
                        className="h-2"
                        value={doneSamples}
                        max={Math.max(totalSamples, 1)}
                      />
                      <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                        {formatNumber(doneSamples)}/{formatNumber(totalSamples)} échantillons
                        {failedSamples > 0 ? (
                          <span className="ml-1 font-medium text-destructive">
                            · {formatNumber(failedSamples)} en échec
                          </span>
                        ) : null}
                      </p>
                    </div>
                    {isNonTerminal(run.status) ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void cancelRun(run.id)}
                        disabled={cancellingRunId === run.id || run.status === "CANCELLING"}
                      >
                        <Ban className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                        Annuler
                      </Button>
                    ) : null}
                  </div>
                </div>

                {run.status === "PARTIAL" ? (
                  <div className="px-4 pb-3">
                    <Alert variant="warning" icon={<AlertTriangle />}>
                      <AlertTitle>Partiel — certains échantillons ont échoué</AlertTitle>
                      <AlertDescription>
                        {formatNumber(failedSamples)} appel(s) sur{" "}
                        {formatNumber(totalSamples)} n’ont pas abouti. Les scores
                        ci-dessous reposent donc sur moins de mesures que prévu.
                      </AlertDescription>
                    </Alert>
                  </div>
                ) : null}

                {run.status === "FAILED" ? (
                  <div className="px-4 pb-3">
                    <Alert variant="destructive" icon={<XCircle />}>
                      <AlertTitle>Analyse échouée</AlertTitle>
                      <AlertDescription>
                        Aucun échantillon exploitable. Le détail par tâche est ci-dessous.
                      </AlertDescription>
                    </Alert>
                  </div>
                ) : null}

                {!expanded && distinctErrors.length > 0 ? (
                  <div className="px-4 pb-3">
                    <Alert variant="destructive" icon={<AlertTriangle />}>
                      <AlertTitle>
                        {formatNumber(failedTasks.length)} tâche(s) en échec
                      </AlertTitle>
                      <AlertDescription>
                        <ul className="space-y-0.5">
                          {distinctErrors.slice(0, 2).map((message) => (
                            <li key={message}>{message}</li>
                          ))}
                        </ul>
                        {distinctErrors.length > 2 ? (
                          <p>
                            et {formatNumber(distinctErrors.length - 2)} autre(s) erreur(s)
                            — dépliez l’analyse pour tout voir.
                          </p>
                        ) : null}
                      </AlertDescription>
                    </Alert>
                  </div>
                ) : null}

                {expanded ? (
                  <div className="border-t bg-muted/10">
                    {run.tasks.length === 0 ? (
                      <p className="px-4 py-6 text-sm text-muted-foreground">
                        Aucune tâche planifiée pour cette analyse.
                      </p>
                    ) : (
                      <ul className="divide-y">
                        {run.tasks.map((task) => (
                          <TaskRow
                            key={task.id}
                            task={task}
                            expanded={expandedTaskId === task.id}
                            onToggle={() => toggleTask(task.id)}
                            detail={detail}
                            detailLoading={detailLoading}
                            detailError={detailError}
                          />
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TaskRow({
  task,
  expanded,
  onToggle,
  detail,
  detailLoading,
  detailError,
}: {
  task: RunTaskSummary;
  expanded: boolean;
  onToggle: () => void;
  detail: RunDetailResponse | null;
  detailLoading: boolean;
  detailError: string | null;
}) {
  const status = TASK_STATUS[task.status];
  const samples = detail?.tasksDetail.find((t) => t.id === task.id)?.samples ?? [];

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <span className="truncate text-sm">{task.query.text}</span>
        </button>
        <span className="text-sm text-muted-foreground">{task.provider.label}</span>
        <Badge variant={task.mode === "GROUNDED" ? "default" : "secondary"} className="font-normal">
          {MODE_LABEL[task.mode]}
        </Badge>
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
            status.className
          )}
        >
          {status.label}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatNumber(task.samples.done)}/{formatNumber(task.samples.total)}
          {task.samples.failed > 0 ? (
            <span className="ml-1 font-medium text-destructive">
              · {formatNumber(task.samples.failed)} en échec
            </span>
          ) : null}
        </span>
        <span className="w-28 text-right text-sm">
          <ScoreCell score={task.score} />
        </span>
      </div>

      {task.errorMessage ? (
        <Alert variant="destructive" icon={<AlertTriangle />} className="mt-2">
          <AlertTitle>Erreur du moteur {task.provider.label}</AlertTitle>
          <AlertDescription>{task.errorMessage}</AlertDescription>
        </Alert>
      ) : null}

      {expanded ? (
        <div className="mt-3 space-y-3">
          {detailError ? (
            <Alert variant="destructive" icon={<AlertTriangle />}>
              <AlertTitle>Impossible de charger le détail</AlertTitle>
              <AlertDescription>{detailError}</AlertDescription>
            </Alert>
          ) : detailLoading && samples.length === 0 ? (
            <Skeleton className="h-32 w-full" />
          ) : samples.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Aucun échantillon exploitable pour cette tâche.
            </p>
          ) : (
            samples.map((sample) => <ScoreBreakdown key={sample.id} sample={sample} />)
          )}
        </div>
      ) : null}
    </li>
  );
}
