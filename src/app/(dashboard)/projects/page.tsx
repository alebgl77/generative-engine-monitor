"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  BarChart3,
  Search,
  Globe,
  ArrowRight,
  Trash2,
} from "lucide-react";
import type { ProjectSummary } from "@/types/api";

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newProject, setNewProject] = useState({
    name: "",
    domain: "",
    targetCountry: "FR",
    targetLanguage: "fr",
  });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchProjects();
  }, []);

  async function fetchProjects() {
    const res = await fetch("/api/projects");
    if (res.ok) {
      const data = (await res.json()) as ProjectSummary[];
      setProjects(data);
    }
    setLoading(false);
  }

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newProject),
    });
    if (res.ok) {
      const project = (await res.json()) as ProjectSummary;
      router.push(`/projects/${project.id}/settings`);
    }
    setCreating(false);
  }

  async function deleteProject(id: string, name: string) {
    if (!confirm(`Supprimer le projet "${name}" ?`)) return;
    await fetch(`/api/projects/${id}`, { method: "DELETE" });
    fetchProjects();
  }

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 bg-muted rounded" />
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-40 bg-muted rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projets</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Gérez vos analyses de visibilité IA
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Nouveau projet
        </button>
      </div>

      {showCreate && (
        <div className="mb-8 rounded-lg border bg-card p-6 shadow-sm">
          <h2 className="text-lg font-medium mb-4">Nouveau projet</h2>
          <form onSubmit={createProject} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="block text-sm font-medium mb-1.5">
                  Nom du projet *
                </label>
                <input
                  type="text"
                  value={newProject.name}
                  onChange={(e) =>
                    setNewProject({ ...newProject, name: e.target.value })
                  }
                  required
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="Mon site e-commerce"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">
                  Domaine
                </label>
                <input
                  type="text"
                  value={newProject.domain}
                  onChange={(e) =>
                    setNewProject({ ...newProject, domain: e.target.value })
                  }
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="monsite.com"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">
                  Pays
                </label>
                <select
                  value={newProject.targetCountry}
                  onChange={(e) =>
                    setNewProject({
                      ...newProject,
                      targetCountry: e.target.value,
                    })
                  }
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="FR">France</option>
                  <option value="US">États-Unis</option>
                  <option value="UK">Royaume-Uni</option>
                  <option value="DE">Allemagne</option>
                  <option value="ES">Espagne</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">
                  Langue
                </label>
                <select
                  value={newProject.targetLanguage}
                  onChange={(e) =>
                    setNewProject({
                      ...newProject,
                      targetLanguage: e.target.value,
                    })
                  }
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="fr">Français</option>
                  <option value="en">Anglais</option>
                  <option value="de">Allemand</option>
                  <option value="es">Espagnol</option>
                </select>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={creating}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {creating ? "Création..." : "Créer le projet"}
              </button>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
              >
                Annuler
              </button>
            </div>
          </form>
        </div>
      )}

      {projects.length === 0 && !showCreate ? (
        <div className="text-center py-16 rounded-lg border border-dashed">
          <BarChart3 className="h-10 w-10 mx-auto text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium mb-1">Aucun projet</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Créez votre premier projet pour analyser votre visibilité IA
          </p>
          <button
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Créer un projet
          </button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <div
              key={project.id}
              className="group rounded-lg border bg-card p-5 shadow-sm hover:shadow-md transition-shadow cursor-pointer relative"
              onClick={() => router.push(`/projects/${project.id}`)}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteProject(project.id, project.name);
                }}
                className="absolute top-3 right-3 p-1.5 rounded-md opacity-0 group-hover:opacity-100 hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all"
              >
                <Trash2 className="h-4 w-4" />
              </button>
              <h3 className="font-medium mb-1 pr-8">{project.name}</h3>
              {project.domain && (
                <p className="text-sm text-muted-foreground flex items-center gap-1 mb-3">
                  <Globe className="h-3 w-3" />
                  {project.domain}
                </p>
              )}
              <div className="flex gap-4 text-xs text-muted-foreground mb-3">
                <span>{project.counts.brands} marque(s)</span>
                <span>{project.counts.competitors} concurrent(s)</span>
                <span>
                  <Search className="h-3 w-3 inline mr-0.5" />
                  {project.counts.queries} requête(s)
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  {project.lastRunAt
                    ? `Dernier run: ${new Date(project.lastRunAt).toLocaleDateString("fr-FR")}`
                    : "Aucun run"}
                </span>
                <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
