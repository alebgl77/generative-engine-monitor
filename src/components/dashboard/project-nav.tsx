"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  ChartLineUp,
  Gear,
  Globe,
  MagnifyingGlass,
  Play,
} from "@phosphor-icons/react";

interface ProjectNavProps {
  projectId: string;
  projectName: string;
}

const navItems = [
  { label: "Vue d’ensemble", href: "", icon: ChartLineUp },
  { label: "Requêtes", href: "/queries", icon: MagnifyingGlass },
  { label: "Sources", href: "/sources", icon: Globe },
  { label: "Runs", href: "/runs", icon: Play },
  { label: "Configuration", href: "/settings", icon: Gear },
];

export function ProjectNav({ projectId, projectName }: ProjectNavProps) {
  const pathname = usePathname();
  const basePath = `/projects/${projectId}`;

  return (
    <header className="border-b border-foreground/20 bg-card/60">
      <div className="mx-auto max-w-[94rem] px-4 pt-5 sm:px-6 lg:px-8">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Dossier actif
        </p>
        <h1 className="mt-1 max-w-3xl truncate text-2xl font-semibold tracking-[-0.035em]">
          {projectName}
        </h1>
        <nav
          aria-label={`Navigation du projet ${projectName}`}
          className="-mx-4 mt-4 flex gap-1 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
        >
          {navItems.map((item) => {
            const href = `${basePath}${item.href}`;
            const isActive =
              item.href === ""
                ? pathname === basePath
                : pathname.startsWith(href);
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                href={href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-3 text-sm font-medium transition-[border-color,color,transform] active:translate-y-px",
                  isActive
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                )}
              >
                <Icon size={17} weight="regular" aria-hidden />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
