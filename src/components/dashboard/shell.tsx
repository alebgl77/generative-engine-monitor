"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { BarChart3, LogOut, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";

interface DashboardShellProps {
  user: { name?: string | null; email: string };
  children: React.ReactNode;
}

export function DashboardShell({ user, children }: DashboardShellProps) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-background">
      {/* Top nav */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex h-14 items-center px-6">
          <Link
            href="/projects"
            className="flex items-center gap-2 font-semibold mr-8"
          >
            <BarChart3 className="h-5 w-5 text-primary" />
            <span>AiO</span>
          </Link>

          <nav className="flex items-center gap-1 text-sm">
            <Link
              href="/projects"
              className={cn(
                "px-3 py-1.5 rounded-md transition-colors",
                pathname === "/projects"
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              )}
            >
              <FolderOpen className="h-4 w-4 inline mr-1.5" />
              Projets
            </Link>
          </nav>

          <div className="ml-auto flex items-center gap-4">
            <span className="text-sm text-muted-foreground">
              {user.name || user.email}
            </span>
            <button
              onClick={() => signOut({ callbackUrl: "/login" })}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main>{children}</main>
    </div>
  );
}
