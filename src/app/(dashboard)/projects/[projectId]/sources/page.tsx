"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { AlertCircle, ExternalLink, Globe, RefreshCw } from "lucide-react";
import type {
  ApiErrorResponse,
  SourceRow,
  SourcesResponse,
} from "@/types/api";
import { MODE_HINT, MODE_LABEL } from "@/components/dashboard/axis-card";
import { Badge, badgeVariants } from "@/components/ui/badge";
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
import { InfoTooltip, Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: SourcesResponse };

const MAX_VISIBLE_QUERIES = 3;

function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)} %`;
}

export default function SourcesPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [state, setState] = React.useState<LoadState>({ status: "loading" });
  const requestRef = React.useRef(0);

  const load = React.useCallback(async () => {
    const requestId = ++requestRef.current;
    setState({ status: "loading" });
    try {
      const res = await fetch(`/api/projects/${projectId}/dashboard/sources`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as ApiErrorResponse | null;
        throw new Error(body?.error ?? `Erreur ${res.status}`);
      }
      const data = (await res.json()) as SourcesResponse;
      if (requestId !== requestRef.current) return;
      setState({ status: "ready", data });
    } catch (error) {
      if (requestId !== requestRef.current) return;
      setState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Impossible de charger les sources.",
      });
    }
  }, [projectId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (state.status === "loading") {
    return (
      <div className="space-y-4">
        <Skeleton className="h-5 w-96" />
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
              Les sources n&apos;ont pas pu être chargées
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
            <Globe className="h-5 w-5 text-muted-foreground" aria-hidden />
            <CardTitle className="text-base">Aucune source extraite</CardTitle>
          </div>
          <CardDescription>
            Les sources proviennent des réponses groundées : lancez une analyse
            couvrant au moins un moteur capable de recherche web pour voir sur
            quels domaines les moteurs s&apos;appuient.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const maxShare = data.rows.reduce(
    (acc, row) => Math.max(acc, row.citationShare),
    0
  );

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Domaines cités par les moteurs pour répondre aux requêtes du projet.
        Plus un domaine pèse, plus il oriente les réponses : c&apos;est le levier
        direct de votre visibilité groundée.
      </p>

      <Card>
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead className="min-w-[240px]">Domaine</TableHead>
              <TableHead className="min-w-[200px]">
                <span className="flex items-center gap-1.5">
                  Part des citations
                  <InfoTooltip label="Part des citations du run pointant vers ce domaine, rapportée au nombre de réponses où il apparaît." />
                </span>
              </TableHead>
              <TableHead className="min-w-[120px]">Occurrences</TableHead>
              <TableHead className="min-w-[150px]">Modes</TableHead>
              <TableHead className="min-w-[160px]">Moteurs</TableHead>
              <TableHead className="min-w-[220px]">Requêtes associées</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((row) => (
              <SourceTableRow
                key={row.domain}
                row={row}
                maxShare={maxShare}
              />
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function SourceTableRow({
  row,
  maxShare,
}: {
  row: SourceRow;
  maxShare: number;
}) {
  const width = maxShare > 0 ? (row.citationShare / maxShare) * 100 : 0;

  return (
    <TableRow className={cn("align-top", row.isBrandDomain && "bg-primary/5")}>
      <TableCell>
        <span className="flex items-center gap-1.5">
          <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-mono text-sm">{row.domain}</span>
          <a
            href={`https://${row.domain}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground"
            aria-label={`Ouvrir ${row.domain}`}
          >
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        </span>
        {row.isBrandDomain && (
          <Badge variant="default" className="mt-1.5">
            Votre domaine
          </Badge>
        )}
      </TableCell>
      <TableCell>
        <div className="space-y-1">
          <span className="text-sm font-semibold tabular-nums">
            {formatPercent(row.citationShare)}
          </span>
          <div className="h-2 w-full max-w-[140px] overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full",
                row.isBrandDomain ? "bg-primary" : "bg-muted-foreground/50"
              )}
              style={{ width: `${width}%` }}
            />
          </div>
        </div>
      </TableCell>
      <TableCell className="text-sm tabular-nums">
        <p>{row.citationCount} citation(s)</p>
        <p className="text-[11px] text-muted-foreground">
          sur {row.sampleCount} réponse(s)
        </p>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {row.modes.map((mode) => (
            <Tooltip key={mode} content={MODE_HINT[mode]}>
              <span className={badgeVariants({ variant: "outline" })}>
                {MODE_LABEL[mode]}
              </span>
            </Tooltip>
          ))}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {row.providers.map((provider) => (
            <Badge key={provider} variant="secondary" className="font-normal">
              {provider}
            </Badge>
          ))}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex max-w-xs flex-wrap gap-1">
          {row.queries.slice(0, MAX_VISIBLE_QUERIES).map((query) => (
            <span
              key={query}
              title={query}
              className="max-w-[160px] truncate rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              {query}
            </span>
          ))}
          {row.queries.length > MAX_VISIBLE_QUERIES && (
            <span className="text-xs text-muted-foreground">
              +{row.queries.length - MAX_VISIBLE_QUERIES}
            </span>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
