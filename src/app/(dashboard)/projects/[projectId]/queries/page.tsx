"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { AlertCircle, Download, RefreshCw, Search } from "lucide-react";
import type { SamplingMode, TaskStatus } from "@prisma/client";
import type {
  ApiErrorResponse,
  QueriesResponse,
  QueryCell,
  QueryRow,
} from "@/types/api";
import { MODE_HINT, MODE_LABEL } from "@/components/dashboard/axis-card";
import { ScoreBar } from "@/components/dashboard/score-bar";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: QueriesResponse };

type PresenceFilter = "all" | "strong" | "partial" | "absent";

const STRONG_PRESENCE = 0.6;

const FILTER_LABEL: Record<PresenceFilter, string> = {
  all: "Toutes",
  strong: "Bien présente",
  partial: "Présence partielle",
  absent: "Absente",
};

const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  PENDING: "En attente",
  RUNNING: "En cours",
  COMPLETED: "Terminée",
  PARTIAL: "Partielle",
  FAILED: "Échec",
  CANCELLED: "Annulée",
};

const MODE_ORDER: SamplingMode[] = ["GROUNDED", "PARAMETRIC"];

interface ColumnKey {
  providerCode: string;
  providerLabel: string;
  mode: SamplingMode;
}

function matchesFilter(row: QueryRow, filter: PresenceFilter): boolean {
  switch (filter) {
    case "strong":
      return row.brandPresenceRate >= STRONG_PRESENCE;
    case "partial":
      return row.brandPresenceRate > 0 && row.brandPresenceRate < STRONG_PRESENCE;
    case "absent":
      return row.brandPresenceRate <= 0;
    default:
      return true;
  }
}

function buildColumns(rows: QueryRow[]): ColumnKey[] {
  const seen: Record<string, true> = {};
  const columns: ColumnKey[] = [];
  for (const row of rows) {
    for (const cell of row.cells) {
      const key = `${cell.providerCode}:${cell.mode}`;
      if (!seen[key]) {
        seen[key] = true;
        columns.push({
          providerCode: cell.providerCode,
          providerLabel: cell.providerLabel,
          mode: cell.mode,
        });
      }
    }
  }
  return columns.sort(
    (a, b) =>
      a.providerLabel.localeCompare(b.providerLabel) ||
      MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode)
  );
}

function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)} %`;
}

export default function QueriesPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const { toast } = useToast();

  const [state, setState] = React.useState<LoadState>({ status: "loading" });
  const [filter, setFilter] = React.useState<PresenceFilter>("all");
  const [exporting, setExporting] = React.useState<"csv" | "json" | null>(null);
  const requestRef = React.useRef(0);

  const load = React.useCallback(async () => {
    const requestId = ++requestRef.current;
    setState({ status: "loading" });
    try {
      const res = await fetch(`/api/projects/${projectId}/dashboard/queries`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as ApiErrorResponse | null;
        throw new Error(body?.error ?? `Erreur ${res.status}`);
      }
      const data = (await res.json()) as QueriesResponse;
      if (requestId !== requestRef.current) return;
      setState({ status: "ready", data });
    } catch (error) {
      if (requestId !== requestRef.current) return;
      setState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Impossible de charger les requêtes.",
      });
    }
  }, [projectId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function exportData(format: "csv" | "json") {
    setExporting(format);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/export?format=${format}`
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as ApiErrorResponse | null;
        throw new Error(body?.error ?? `Erreur ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `aio-queries-${projectId}.${format}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Export impossible",
        description:
          error instanceof Error ? error.message : "L'export a échoué.",
      });
    } finally {
      setExporting(null);
    }
  }

  if (state.status === "loading") {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-10 w-96" />
          <Skeleton className="h-9 w-48" />
        </div>
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <Card className="border-destructive/40">
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-destructive" aria-hidden />
            <CardTitle className="text-base">
              Les requêtes n&apos;ont pas pu être chargées
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

  if (!data.runId || data.rows.length === 0) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Search className="h-5 w-5 text-muted-foreground" aria-hidden />
            <CardTitle className="text-base">Aucun résultat par requête</CardTitle>
          </div>
          <CardDescription>
            Lancez une analyse depuis l&apos;overview : chaque requête sera
            posée à chaque moteur, en mode groundé et paramétrique, puis répétée
            pour produire un intervalle de confiance.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const columns = buildColumns(data.rows);
  const filtered = data.rows.filter((row) => matchesFilter(row, filter));
  const counts: Record<PresenceFilter, number> = {
    all: data.rows.length,
    strong: data.rows.filter((row) => matchesFilter(row, "strong")).length,
    partial: data.rows.filter((row) => matchesFilter(row, "partial")).length,
    absent: data.rows.filter((row) => matchesFilter(row, "absent")).length,
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={filter}
          onValueChange={(value) => setFilter(value as PresenceFilter)}
        >
          <TabsList>
            {(Object.keys(FILTER_LABEL) as PresenceFilter[]).map((key) => (
              <TabsTrigger key={key} value={key}>
                {FILTER_LABEL[key]} ({counts[key]})
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            scoring {data.scoringVersion}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={exporting !== null}
            onClick={() => void exportData("csv")}
          >
            <Download className="mr-2 h-3.5 w-3.5" aria-hidden />
            CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={exporting !== null}
            onClick={() => void exportData("json")}
          >
            <Download className="mr-2 h-3.5 w-3.5" aria-hidden />
            JSON
          </Button>
        </div>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead className="min-w-[260px]">Requête</TableHead>
              <TableHead className="min-w-[150px]">Présence marque</TableHead>
              {columns.map((column) => (
                <TableHead
                  key={`${column.providerCode}:${column.mode}`}
                  className="min-w-[190px]"
                >
                  <Tooltip content={MODE_HINT[column.mode]}>
                    <span className="flex flex-col items-start leading-tight">
                      <span className="text-foreground">
                        {column.providerLabel}
                      </span>
                      <span className="text-[11px] font-normal">
                        {MODE_LABEL[column.mode]}
                      </span>
                    </span>
                  </Tooltip>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length + 2}
                  className="py-10 text-center text-sm text-muted-foreground"
                >
                  Aucune requête ne correspond à ce filtre.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((row) => (
                <TableRow key={row.queryId} className="align-top">
                  <TableCell className="max-w-md">
                    <p className="text-sm font-medium">{row.text}</p>
                    <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
                      {row.avgCitations.toFixed(1)} citation(s) en moyenne
                    </p>
                    {row.competitors.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {row.competitors.map((competitor) => (
                          <Badge
                            key={competitor.name}
                            variant="secondary"
                            className="font-normal"
                          >
                            {competitor.name}{" "}
                            {formatPercent(competitor.mentionShare)}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <PresenceCell rate={row.brandPresenceRate} />
                  </TableCell>
                  {columns.map((column) => {
                    const cell = row.cells.find(
                      (candidate) =>
                        candidate.providerCode === column.providerCode &&
                        candidate.mode === column.mode
                    );
                    return (
                      <TableCell key={`${row.queryId}-${column.providerCode}-${column.mode}`}>
                        <QueryScoreCell cell={cell} />
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function PresenceCell({ rate }: { rate: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, rate)) * 100);
  return (
    <div className="space-y-1">
      <span
        className={cn(
          "text-sm font-semibold tabular-nums",
          rate >= STRONG_PRESENCE
            ? "text-emerald-600"
            : rate > 0
              ? "text-amber-600"
              : "text-red-600"
        )}
      >
        {pct} %
      </span>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full",
            rate >= STRONG_PRESENCE
              ? "bg-emerald-500"
              : rate > 0
                ? "bg-amber-500"
                : "bg-red-500"
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[10px] text-muted-foreground">
        des réponses citent la marque
      </p>
    </div>
  );
}

function QueryScoreCell({ cell }: { cell: QueryCell | undefined }) {
  if (!cell) {
    return <span className="text-xs text-muted-foreground">non mesuré</span>;
  }
  if (cell.status === "FAILED" || cell.status === "CANCELLED") {
    return (
      <Badge variant="outline" className="font-normal text-muted-foreground">
        {TASK_STATUS_LABEL[cell.status]}
      </Badge>
    );
  }
  if (cell.n === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {TASK_STATUS_LABEL[cell.status]} — aucun échantillon exploitable
      </span>
    );
  }
  return (
    <div className="space-y-1">
      <ScoreBar value={cell} size="sm" />
      {cell.status !== "COMPLETED" && (
        <p className="text-[10px] text-muted-foreground">
          {TASK_STATUS_LABEL[cell.status]}
        </p>
      )}
    </div>
  );
}
