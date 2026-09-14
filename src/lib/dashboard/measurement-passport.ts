import packageMetadata from "../../../package.json";
import type { SignalFinding, SignalFindingKind } from "./signal-insights";

export const MEASUREMENT_PASSPORT_SCHEMA = "gem.measurement-passport/v1";
export const MEASUREMENT_PASSPORT_NOTICE =
  "Comparaison descriptive et non causale de réponses API observées sur le panel et dans les paramètres du run.";

export interface PassportRunContext {
  status: string;
  completedAt: string | null;
  progress: {
    totalTasks: number;
    totalSamples: number;
    doneSamples: number;
    failedSamples: number;
    nPlanned?: number;
    nSuccessful?: number;
    nScored?: number;
    missingAnalysis?: number;
  };
}

export interface MeasurementAxisPayload {
  mode: "GROUNDED" | "PARAMETRIC";
  median: number;
  interval: { low: number | null; high: number | null };
  stability: number | null;
  n: number;
  rawN: number | null;
  cellN: number | null;
  nUnit: "queries" | "samples" | null;
  lowN: boolean;
  method: string | null;
  brandPresenceRate: number;
}

export interface MeasurementPassportPayload {
  schemaVersion: typeof MEASUREMENT_PASSPORT_SCHEMA;
  app: { name: "Generative Engine Monitor"; version: string };
  exportedAt: string;
  project: { name: string };
  brands: { names: string[] };
  measurement: {
    classification: SignalFindingKind;
    query: string;
    provider: { code: string; label: string };
    gapPoints: number;
    axes: [MeasurementAxisPayload, MeasurementAxisPayload];
    notice: typeof MEASUREMENT_PASSPORT_NOTICE;
  };
  method: { scoringVersion: string };
  run: PassportRunContext;
}

export interface BuildMeasurementPassportInput {
  finding: SignalFinding;
  projectName: string;
  brandNames: string[];
  scoringVersion: string;
  run: PassportRunContext;
  exportedAt: Date | string;
  appVersion?: string;
}

function axisPayload(
  finding: SignalFinding,
  mode: "GROUNDED" | "PARAMETRIC"
): MeasurementAxisPayload {
  const cell = mode === "GROUNDED" ? finding.grounded : finding.parametric;
  return {
    mode,
    median: cell.median,
    interval: { low: cell.ciLow, high: cell.ciHigh },
    stability: cell.stability,
    n: cell.n,
    rawN: cell.rawN ?? null,
    cellN: cell.cellN ?? null,
    nUnit: cell.nUnit ?? null,
    lowN: cell.lowN,
    method: cell.ciMethod ?? null,
    brandPresenceRate: cell.brandPresenceRate,
  };
}

export function buildMeasurementPassport({
  finding,
  projectName,
  brandNames,
  scoringVersion,
  run,
  exportedAt,
  appVersion = packageMetadata.version,
}: BuildMeasurementPassportInput): MeasurementPassportPayload {
  const timestamp =
    exportedAt instanceof Date
      ? exportedAt.toISOString()
      : new Date(exportedAt).toISOString();
  const names = brandNames.slice().sort((left, right) => {
    if (left === right) return 0;
    return left < right ? -1 : 1;
  });

  const progress: PassportRunContext["progress"] = {
    totalTasks: run.progress.totalTasks,
    totalSamples: run.progress.totalSamples,
    doneSamples: run.progress.doneSamples,
    failedSamples: run.progress.failedSamples,
    ...(run.progress.nPlanned === undefined
      ? {}
      : { nPlanned: run.progress.nPlanned }),
    ...(run.progress.nSuccessful === undefined
      ? {}
      : { nSuccessful: run.progress.nSuccessful }),
    ...(run.progress.nScored === undefined
      ? {}
      : { nScored: run.progress.nScored }),
    ...(run.progress.missingAnalysis === undefined
      ? {}
      : { missingAnalysis: run.progress.missingAnalysis }),
  };

  return {
    schemaVersion: MEASUREMENT_PASSPORT_SCHEMA,
    app: { name: "Generative Engine Monitor", version: appVersion },
    exportedAt: timestamp,
    project: { name: projectName },
    brands: { names },
    measurement: {
      classification: finding.kind,
      query: finding.queryText,
      provider: {
        code: finding.providerCode,
        label: finding.providerLabel,
      },
      gapPoints: finding.gap,
      axes: [
        axisPayload(finding, "GROUNDED"),
        axisPayload(finding, "PARAMETRIC"),
      ],
      notice: MEASUREMENT_PASSPORT_NOTICE,
    },
    method: { scoringVersion },
    run: {
      status: run.status,
      completedAt: run.completedAt,
      progress,
    },
  };
}

export function serializeMeasurementPassport(
  payload: MeasurementPassportPayload
): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function markdownMachineText(value: string | null): string {
  if (value === null || value.trim() === "") return "indisponible";
  return value.replace(/\r?\n/g, " ");
}

function markdownUserText(value: string | null): string {
  const text = markdownMachineText(value);
  if (text === "indisponible") return text;
  return text
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]{}()<>#+.!|~-])/g, "\\$1");
}

function markdownNumber(
  value: number | null,
  options: Intl.NumberFormatOptions = { maximumFractionDigits: 2 }
): string {
  if (value === null || !Number.isFinite(value)) return "indisponible";
  return value.toLocaleString("fr-FR", options);
}

function markdownInterval(axis: MeasurementAxisPayload): string {
  if (axis.interval.low === null || axis.interval.high === null) {
    return "indisponible";
  }
  return `${markdownNumber(axis.interval.low)}–${markdownNumber(axis.interval.high)}`;
}

function markdownOptionalCount(value: number | undefined): string {
  return value === undefined ? "indisponible" : markdownNumber(value);
}

export function renderMeasurementPassportMarkdown(
  payload: MeasurementPassportPayload
): string {
  const axes = payload.measurement.axes
    .map(
      (axis) =>
        `| ${axis.mode === "GROUNDED" ? "GROUNDÉ" : "PARAMÉTRIQUE"} | ${markdownNumber(axis.median)} | ${markdownInterval(axis)} | ${markdownNumber(axis.stability, { style: "percent", maximumFractionDigits: 0 })} | ${markdownNumber(axis.n)} ${markdownMachineText(axis.nUnit)} | ${markdownNumber(axis.rawN)} | ${markdownNumber(axis.cellN)} | ${axis.lowN ? "oui" : "non"} | ${markdownMachineText(axis.method)} | ${markdownNumber(axis.brandPresenceRate, { style: "percent", maximumFractionDigits: 0 })} |`
    )
    .join("\n");

  return [
    `# Passeport de mesure — ${markdownUserText(payload.measurement.query)}`,
    "",
    `- Schéma : \`${markdownMachineText(payload.schemaVersion)}\``,
    `- Application : ${markdownMachineText(payload.app.name)} ${markdownMachineText(payload.app.version)}`,
    `- Projet : ${markdownUserText(payload.project.name)}`,
    `- Marques : ${payload.brands.names.length > 0 ? payload.brands.names.map(markdownUserText).join(", ") : "indisponible"}`,
    `- Fournisseur : ${markdownUserText(payload.measurement.provider.label)} (\`${markdownMachineText(payload.measurement.provider.code)}\`)`,
    `- Requête : ${markdownUserText(payload.measurement.query)}`,
    `- Écart observé groundé − paramétrique : ${markdownNumber(payload.measurement.gapPoints)} points`,
    `- Version du score : \`${markdownMachineText(payload.method.scoringVersion)}\``,
    `- Export : ${markdownMachineText(payload.exportedAt)}`,
    "",
    "| Mode | Médiane | Intervalle | Stabilité | n | Réponses brutes | Cellules | Faible n | Méthode | Présence marque |",
    "|---|---:|---:|---:|---:|---:|---:|:---:|---|---:|",
    axes,
    "",
    `Run : ${markdownMachineText(payload.run.status)} · terminé ${markdownMachineText(payload.run.completedAt)} · ${markdownNumber(payload.run.progress.doneSamples)}/${markdownNumber(payload.run.progress.totalSamples)} appels traités · ${markdownNumber(payload.run.progress.failedSamples)} en échec.`,
    `Couverture d’analyse : planifié ${markdownOptionalCount(payload.run.progress.nPlanned)}, réussi ${markdownOptionalCount(payload.run.progress.nSuccessful)}, scoré ${markdownOptionalCount(payload.run.progress.nScored)}, analyse manquante ${markdownOptionalCount(payload.run.progress.missingAnalysis)}.`,
    "",
    `> ${payload.measurement.notice}`,
    "",
  ].join("\n");
}

export function sanitizeFilenamePart(value: string, maxLength = 42): string {
  const safe = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return safe || "mesure";
}

export function measurementPassportFilename(
  payload: MeasurementPassportPayload
): string {
  const query = sanitizeFilenamePart(payload.measurement.query, 42);
  const provider = sanitizeFilenamePart(payload.measurement.provider.code, 20);
  const date = payload.exportedAt.slice(0, 10);
  return `gem-passport-${query}-${provider}-${date}.json`;
}
