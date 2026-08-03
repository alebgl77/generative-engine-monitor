"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { BarChart3, Search, Globe, Play, Settings } from "lucide-react";

interface ProjectNavProps {
  projectId: string;
  projectName: string;
}

const navItems = [
  { label: "Overview", href: "", icon: BarChart3 },
  { label: "Requêtes", href: "/queries", icon: Search },
  { label: "Sources", href: "/sources", icon: Globe },
  { label: "Runs", href: "/runs", icon: Play },
  { label: "Configuration", href: "/settings", icon: Settings },
];

export function ProjectNav({ projectId, projectName }: ProjectNavProps) {
  const pathname = usePathname();
  const basePath = `/projects/${projectId}`;

  return (
    <div className="border-b bg-background">
      <div className="px-8 pt-6 pb-0">
        <h1 className="text-xl font-semibold tracking-tight mb-4">
          {projectName}
        </h1>
        <nav className="flex gap-1 -mb-px">
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
                className={cn(
                  "inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors",
                  isActive
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
