"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import type { Brand, Competitor, Query, SamplingMode } from "@prisma/client";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Key,
  Plus,
  RefreshCw,
  Repeat,
  Save,
  Search,
  Tag,
  Trash2,
  Users,
} from "lucide-react";
import type {
  ApiErrorResponse,
  CredentialSummary,
  ProjectSummary,
  ProviderSummary,
} from "@/types/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectOption } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";

type ProjectBrand = Pick<Brand, "id" | "name" | "domain">;
type ProjectCompetitor = Pick<Competitor, "id" | "name" | "domain">;
type ProjectQuery = Pick<Query, "id" | "text" | "isActive">;

const ALL_MODES: SamplingMode[] = ["PARAMETRIC", "GROUNDED"];

const MODE_LABEL: Record<SamplingMode, string> = {
  PARAMETRIC: "Paramétrique",
  GROUNDED: "Groundé",
};

const MODE_HINT: Record<SamplingMode, string> = {
  PARAMETRIC: "Sans recherche web : ce que le modèle a retenu de son entraînement.",
  GROUNDED: "Avec la recherche web native du moteur : ce qu’il récupère maintenant.",
};

const MIN_REPETITIONS = 1;
const MAX_REPETITIONS = 10;

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

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function formatDate(value: string | null): string {
  if (!value) return "jamais";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "jamais" : date.toLocaleString("fr-FR");
}

function clampRepetitions(value: number): number {
  if (!Number.isFinite(value)) return 3;
  return Math.min(MAX_REPETITIONS, Math.max(MIN_REPETITIONS, Math.round(value)));
}

function supportsMode(provider: ProviderSummary, mode: SamplingMode): boolean {
  return mode === "PARAMETRIC" ? provider.supportsParametric : provider.supportsGrounded;
}

export default function SettingsPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const { toast } = useToast();

  const [brands, setBrands] = useState<ProjectBrand[]>([]);
  const [competitors, setCompetitors] = useState<ProjectCompetitor[]>([]);
  const [queries, setQueries] = useState<ProjectQuery[]>([]);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const [newBrand, setNewBrand] = useState({ name: "", domain: "" });
  const [newCompetitor, setNewCompetitor] = useState({ name: "", domain: "" });
  const [newQueries, setNewQueries] = useState("");
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const [repetitions, setRepetitions] = useState(3);
  const [modes, setModes] = useState<SamplingMode[]>(ALL_MODES);
  const [samplingDirty, setSamplingDirty] = useState(false);
  // A background refresh must never overwrite sampling settings the user is editing.
  const samplingDirtyRef = useRef(false);
  samplingDirtyRef.current = samplingDirty;

  const loadAll = useCallback(async () => {
    const [projectRes, brandsRes, competitorsRes, queriesRes, providersRes, credsRes] =
      await Promise.allSettled([
        requestJson<ProjectSummary>(`/api/projects/${projectId}`),
        requestJson<ProjectBrand[]>(`/api/projects/${projectId}/brands`),
        requestJson<ProjectCompetitor[]>(`/api/projects/${projectId}/competitors`),
        requestJson<ProjectQuery[]>(`/api/projects/${projectId}/queries`),
        requestJson<ProviderSummary[]>("/api/providers"),
        requestJson<CredentialSummary[]>("/api/providers/credentials"),
      ]);

    const failures: string[] = [];

    if (projectRes.status === "fulfilled") {
      if (!samplingDirtyRef.current) {
        setRepetitions(clampRepetitions(projectRes.value.repetitions));
        setModes(
          Array.isArray(projectRes.value.samplingModes) &&
            projectRes.value.samplingModes.length > 0
            ? projectRes.value.samplingModes
            : ALL_MODES
        );
      }
    } else {
      failures.push(`projet : ${messageOf(projectRes.reason)}`);
    }

    if (brandsRes.status === "fulfilled") setBrands(brandsRes.value);
    else failures.push(`marque : ${messageOf(brandsRes.reason)}`);

    if (competitorsRes.status === "fulfilled") setCompetitors(competitorsRes.value);
    else failures.push(`concurrents : ${messageOf(competitorsRes.reason)}`);

    if (queriesRes.status === "fulfilled") setQueries(queriesRes.value);
    else failures.push(`requêtes : ${messageOf(queriesRes.reason)}`);

    if (providersRes.status === "fulfilled") setProviders(providersRes.value);
    else failures.push(`moteurs : ${messageOf(providersRes.reason)}`);

    if (credsRes.status === "fulfilled") setCredentials(credsRes.value);
    else failures.push(`clés API : ${messageOf(credsRes.reason)}`);

    setLoading(false);

    if (failures.length > 0) {
      toast({
        title: "Chargement incomplet",
        description: failures.join(" · "),
        variant: "destructive",
      });
    }
  }, [projectId, toast]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  /** Runs a mutation, reloads on success and leaves the current state untouched on failure. */
  const submit = useCallback(
    async (key: string, failureTitle: string, action: () => Promise<void>, success?: string) => {
      setBusy(key);
      try {
        await action();
        await loadAll();
        if (success) toast({ title: success });
      } catch (error) {
        toast({
          title: failureTitle,
          description: messageOf(error),
          variant: "destructive",
        });
      } finally {
        setBusy(null);
      }
    },
    [loadAll, toast]
  );

  const activeQueryCount = queries.filter((q) => q.isActive).length;

  const availableProviders = useMemo(
    () => providers.filter((p) => p.hasCredential || p.code === "mock"),
    [providers]
  );

  const plannedCells = useMemo(
    () =>
      availableProviders.reduce(
        (total, provider) =>
          total + modes.filter((mode) => supportsMode(provider, mode)).length,
        0
      ),
    [availableProviders, modes]
  );

  const skippedCells = useMemo(
    () =>
      availableProviders.flatMap((provider) =>
        modes
          .filter((mode) => !supportsMode(provider, mode))
          .map((mode) => `${provider.label} · ${MODE_LABEL[mode]}`)
      ),
    [availableProviders, modes]
  );

  const plannedCalls = activeQueryCount * plannedCells * repetitions;

  function toggleMode(mode: SamplingMode) {
    setSamplingDirty(true);
    setModes((current) =>
      current.indexOf(mode) >= 0
        ? current.filter((m) => m !== mode)
        : ALL_MODES.filter((m) => m === mode || current.indexOf(m) >= 0)
    );
  }

  async function saveSampling() {
    await submit(
      "sampling",
      "Enregistrement impossible",
      async () => {
        await requestJson<unknown>(
          `/api/projects/${projectId}`,
          jsonInit("PUT", { repetitions, samplingModes: modes })
        );
        setSamplingDirty(false);
      },
      "Échantillonnage enregistré"
    );
  }

  async function addBrand(event: React.FormEvent) {
    event.preventDefault();
    if (!newBrand.name.trim()) return;
    await submit(
      "brand",
      "Ajout de la marque impossible",
      async () => {
        await requestJson<unknown>(
          `/api/projects/${projectId}/brands`,
          jsonInit("POST", {
            name: newBrand.name.trim(),
            domain: newBrand.domain.trim() || null,
          })
        );
        setNewBrand({ name: "", domain: "" });
      },
      "Marque ajoutée"
    );
  }

  async function addCompetitor(event: React.FormEvent) {
    event.preventDefault();
    if (!newCompetitor.name.trim()) return;
    await submit(
      "competitor",
      "Ajout du concurrent impossible",
      async () => {
        await requestJson<unknown>(
          `/api/projects/${projectId}/competitors`,
          jsonInit("POST", {
            name: newCompetitor.name.trim(),
            domain: newCompetitor.domain.trim() || null,
          })
        );
        setNewCompetitor({ name: "", domain: "" });
      },
      "Concurrent ajouté"
    );
  }

  async function addQueries(event: React.FormEvent) {
    event.preventDefault();
    const lines = newQueries
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) return;
    await submit(
      "queries",
      "Ajout des requêtes impossible",
      async () => {
        await requestJson<unknown>(
          `/api/projects/${projectId}/queries`,
          jsonInit("POST", { queries: lines })
        );
        setNewQueries("");
      },
      `${lines.length} requête(s) ajoutée(s)`
    );
  }

  async function saveApiKey(provider: ProviderSummary) {
    const apiKey = (apiKeys[provider.id] ?? "").trim();
    if (!apiKey) return;
    await submit(
      `key-${provider.id}`,
      `Clé ${provider.label} refusée`,
      async () => {
        await requestJson<unknown>(
          "/api/providers/credentials",
          jsonInit("POST", { providerId: provider.id, apiKey })
        );
        setApiKeys((current) => ({ ...current, [provider.id]: "" }));
      },
      `Clé ${provider.label} enregistrée`
    );
  }

  async function retestCredential(credential: CredentialSummary) {
    setBusy(`test-${credential.id}`);
    try {
      const result = await requestJson<CredentialSummary>(
        `/api/providers/credentials/${credential.id}`,
        jsonInit("POST", {})
      );
      await loadAll();
      toast({
        title: result.isValid
          ? `Clé ${credential.providerLabel} valide`
          : `Clé ${credential.providerLabel} invalide`,
        description: result.validationError ?? undefined,
        variant: result.isValid ? "default" : "destructive",
      });
    } catch (error) {
      toast({
        title: `Test de la clé ${credential.providerLabel} impossible`,
        description: messageOf(error),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="max-w-3xl space-y-6">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-48 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-8">
      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <Tag className="h-4 w-4 text-primary" aria-hidden="true" />
          <h2 className="text-base font-medium">Marque surveillée</h2>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          La marque dont vous mesurez la visibilité dans les réponses des moteurs IA.
        </p>

        {brands.map((brand) => (
          <div
            key={brand.id}
            className="mb-2 flex items-center justify-between rounded-md bg-muted/50 px-3 py-2"
          >
            <div>
              <span className="text-sm font-medium">{brand.name}</span>
              {brand.domain ? (
                <span className="ml-2 text-xs text-muted-foreground">{brand.domain}</span>
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              aria-label={`Supprimer ${brand.name}`}
              onClick={() =>
                void submit(
                  `brand-${brand.id}`,
                  "Suppression impossible",
                  async () => {
                    await requestJson<unknown>(
                      `/api/projects/${projectId}/brands/${brand.id}`,
                      { method: "DELETE" }
                    );
                  }
                )
              }
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </div>
        ))}

        <form onSubmit={addBrand} className="mt-3 flex gap-2">
          <Input
            value={newBrand.name}
            onChange={(e) => setNewBrand({ ...newBrand, name: e.target.value })}
            placeholder="Nom de la marque"
            className="h-9"
            aria-label="Nom de la marque"
          />
          <Input
            value={newBrand.domain}
            onChange={(e) => setNewBrand({ ...newBrand, domain: e.target.value })}
            placeholder="domaine.com"
            className="h-9 w-40"
            aria-label="Domaine de la marque"
          />
          <Button type="submit" size="sm" disabled={busy === "brand"}>
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            Ajouter
          </Button>
        </form>
      </section>

      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <Users className="h-4 w-4 text-amber-500" aria-hidden="true" />
          <h2 className="text-base font-medium">Concurrents</h2>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Les marques concurrentes à détecter dans les réponses, pour mesurer votre part
          de voix.
        </p>

        {competitors.map((competitor) => (
          <div
            key={competitor.id}
            className="mb-2 flex items-center justify-between rounded-md bg-muted/50 px-3 py-2"
          >
            <div>
              <span className="text-sm font-medium">{competitor.name}</span>
              {competitor.domain ? (
                <span className="ml-2 text-xs text-muted-foreground">
                  {competitor.domain}
                </span>
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              aria-label={`Supprimer ${competitor.name}`}
              onClick={() =>
                void submit(
                  `competitor-${competitor.id}`,
                  "Suppression impossible",
                  async () => {
                    await requestJson<unknown>(
                      `/api/projects/${projectId}/competitors/${competitor.id}`,
                      { method: "DELETE" }
                    );
                  }
                )
              }
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </div>
        ))}

        <form onSubmit={addCompetitor} className="mt-3 flex gap-2">
          <Input
            value={newCompetitor.name}
            onChange={(e) => setNewCompetitor({ ...newCompetitor, name: e.target.value })}
            placeholder="Nom du concurrent"
            className="h-9"
            aria-label="Nom du concurrent"
          />
          <Input
            value={newCompetitor.domain}
            onChange={(e) =>
              setNewCompetitor({ ...newCompetitor, domain: e.target.value })
            }
            placeholder="concurrent.com"
            className="h-9 w-40"
            aria-label="Domaine du concurrent"
          />
          <Button type="submit" size="sm" disabled={busy === "competitor"}>
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            Ajouter
          </Button>
        </form>
      </section>

      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <Search className="h-4 w-4 text-primary" aria-hidden="true" />
          <h2 className="text-base font-medium">Requêtes</h2>
          <span className="text-xs text-muted-foreground">
            {activeQueryCount} active(s) sur {queries.length}
          </span>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Les questions posées aux moteurs IA. Une par ligne pour un ajout en lot.
        </p>

        <div className="mb-4 max-h-64 space-y-1 overflow-y-auto">
          {queries.map((query) => (
            <div
              key={query.id}
              className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-1.5"
            >
              <div className="flex min-w-0 items-center gap-2">
                <input
                  type="checkbox"
                  checked={query.isActive}
                  aria-label={`Activer la requête « ${query.text} »`}
                  onChange={() =>
                    void submit(
                      `query-${query.id}`,
                      "Mise à jour impossible",
                      async () => {
                        await requestJson<unknown>(
                          `/api/projects/${projectId}/queries/${query.id}`,
                          jsonInit("PUT", { isActive: !query.isActive })
                        );
                      }
                    )
                  }
                  className="h-4 w-4 rounded border-input accent-primary"
                />
                <span
                  className={cn(
                    "truncate text-sm",
                    !query.isActive && "text-muted-foreground line-through"
                  )}
                >
                  {query.text}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                aria-label={`Supprimer la requête « ${query.text} »`}
                onClick={() =>
                  void submit(
                    `query-del-${query.id}`,
                    "Suppression impossible",
                    async () => {
                      await requestJson<unknown>(
                        `/api/projects/${projectId}/queries/${query.id}`,
                        { method: "DELETE" }
                      );
                    }
                  )
                }
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          ))}
        </div>

        <form onSubmit={addQueries}>
          <Textarea
            value={newQueries}
            onChange={(e) => setNewQueries(e.target.value)}
            placeholder={"meilleur CRM pour PME\nalternative à Salesforce"}
            rows={3}
            className="mb-2"
            aria-label="Nouvelles requêtes"
          />
          <Button type="submit" size="sm" disabled={busy === "queries"}>
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            Ajouter les requêtes
          </Button>
        </form>
      </section>

      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <Repeat className="h-4 w-4 text-primary" aria-hidden="true" />
          <h2 className="text-base font-medium">Échantillonnage</h2>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Deux appels identiques ne donnent pas deux réponses identiques : sans
          répétitions, une analyse mesure autant le bruit du modèle que votre visibilité
          réelle.
        </p>

        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="repetitions">Répétitions par cellule</Label>
            <Select
              id="repetitions"
              value={String(repetitions)}
              onChange={(e) => {
                setSamplingDirty(true);
                setRepetitions(clampRepetitions(Number(e.target.value)));
              }}
              className="h-9 w-24"
            >
              {Array.from({ length: MAX_REPETITIONS }, (_, i) => i + MIN_REPETITIONS).map(
                (value) => (
                  <SelectOption key={value} value={String(value)}>
                    {value}
                  </SelectOption>
                )
              )}
            </Select>
            <p className="text-xs text-muted-foreground">
              De 1 à {MAX_REPETITIONS}. En dessous de 5, l’intervalle de confiance reste
              indicatif.
            </p>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Modes d’échantillonnage</legend>
            {ALL_MODES.map((mode) => (
              <label key={mode} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={modes.indexOf(mode) >= 0}
                  onChange={() => toggleMode(mode)}
                  className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
                />
                <span>
                  <span className="font-medium">{MODE_LABEL[mode]}</span>
                  <span className="block text-xs text-muted-foreground">
                    {MODE_HINT[mode]}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        </div>

        <div className="mt-5 rounded-md bg-muted/50 p-4">
          <p className="text-sm">
            <span className="text-2xl font-semibold tabular-nums">
              {plannedCalls.toLocaleString("fr-FR")}
            </span>{" "}
            appels API par analyse
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {activeQueryCount} requête(s) active(s) × {plannedCells} cellule(s)
            moteur×mode × {repetitions} répétition(s)
          </p>
          {skippedCells.length > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Combinaisons impossibles, non facturées : {skippedCells.join(", ")}.
            </p>
          ) : null}
        </div>

        {modes.length === 0 ? (
          <Alert variant="warning" icon={<AlertTriangle />} className="mt-4">
            <AlertDescription>
              Sélectionnez au moins un mode : sans mode, aucune analyse ne peut être
              planifiée.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="mt-4 flex items-center gap-3">
          <Button
            size="sm"
            onClick={() => void saveSampling()}
            disabled={modes.length === 0 || busy === "sampling"}
          >
            <Save className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Enregistrer
          </Button>
          {samplingDirty ? (
            <span className="text-xs text-amber-700">Modifications non enregistrées</span>
          ) : null}
        </div>
      </section>

      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <Key className="h-4 w-4 text-primary" aria-hidden="true" />
          <h2 className="text-base font-medium">Clés API des moteurs</h2>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Les clés sont chiffrées avant stockage et ne sont jamais réaffichées en clair.
          Le moteur Mock fonctionne sans clé, avec des réponses simulées.
        </p>

        <div className="space-y-4">
          {providers.map((provider) => {
            const credential =
              credentials.find((c) => c.providerId === provider.id) ??
              credentials.find((c) => c.providerCode === provider.code) ??
              null;
            const keyless = provider.code === "mock";
            return (
              <div key={provider.id} className="rounded-md border p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{provider.label}</span>
                  <Badge variant="outline" className="font-normal">
                    {provider.defaultModel || provider.code}
                  </Badge>
                  <Badge
                    variant={provider.supportsParametric ? "secondary" : "outline"}
                    className={cn(
                      "font-normal",
                      !provider.supportsParametric && "text-muted-foreground line-through"
                    )}
                  >
                    Paramétrique
                  </Badge>
                  <Badge
                    variant={provider.supportsGrounded ? "secondary" : "outline"}
                    className={cn(
                      "font-normal",
                      !provider.supportsGrounded && "text-muted-foreground line-through"
                    )}
                  >
                    Groundé
                  </Badge>
                  {credential && credential.isValid ? (
                    <span className="flex items-center gap-1 text-xs text-emerald-600">
                      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                      {credential.maskedKey}
                    </span>
                  ) : null}
                </div>

                {!provider.supportsParametric || !provider.supportsGrounded ? (
                  <p className="mb-2 text-xs text-muted-foreground">
                    {provider.supportsGrounded
                      ? `${provider.label} interroge toujours le web : il n’a pas de mode paramétrique.`
                      : `${provider.label} n’expose pas de recherche web native : il n’a pas de mode groundé.`}
                  </p>
                ) : null}

                {credential && !credential.isValid ? (
                  <Alert variant="destructive" icon={<AlertTriangle />} className="mb-3">
                    <AlertTitle>Clé invalide — ce moteur ne sera pas interrogé</AlertTitle>
                    <AlertDescription>
                      {credential.validationError ??
                        "Le fournisseur a refusé cette clé lors du dernier test."}
                    </AlertDescription>
                  </Alert>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    type="password"
                    autoComplete="off"
                    value={apiKeys[provider.id] ?? ""}
                    onChange={(e) =>
                      setApiKeys((current) => ({
                        ...current,
                        [provider.id]: e.target.value,
                      }))
                    }
                    placeholder={keyless ? "Aucune clé requise" : "sk-…"}
                    disabled={keyless}
                    aria-label={`Clé API ${provider.label}`}
                    className="h-9 flex-1"
                  />
                  {!keyless ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void saveApiKey(provider)}
                        disabled={
                          !(apiKeys[provider.id] ?? "").trim() ||
                          busy === `key-${provider.id}`
                        }
                      >
                        <Save className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                        Enregistrer
                      </Button>
                      {credential ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void retestCredential(credential)}
                          disabled={busy === `test-${credential.id}`}
                        >
                          <RefreshCw
                            className={cn(
                              "mr-1.5 h-3.5 w-3.5",
                              busy === `test-${credential.id}` && "animate-spin"
                            )}
                            aria-hidden="true"
                          />
                          Retester
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                </div>

                {credential ? (
                  <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                    {credential.isValid ? (
                      <Check className="h-3 w-3 text-emerald-600" aria-hidden="true" />
                    ) : null}
                    Clé {credential.maskedKey} · version {credential.keyVersion} · dernier
                    test : {formatDate(credential.lastValidatedAt)}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
