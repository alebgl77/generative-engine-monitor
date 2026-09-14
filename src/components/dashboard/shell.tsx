"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { ChartLineUp, FolderOpen, SignOut } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

interface DashboardShellProps {
  user: { name?: string | null; email: string };
  children: React.ReactNode;
}

export function DashboardShell({ user, children }: DashboardShellProps) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen overflow-x-clip bg-background">
      <a href="#main-content" className="skip-link">
        Aller au contenu principal
      </a>
      <header className="sticky top-0 z-40 border-b border-foreground/20 bg-background">
        <div className="mx-auto flex h-16 max-w-[94rem] items-center px-4 sm:px-6 lg:px-8">
          <Link
            href="/projects"
            className="group mr-5 flex items-center gap-3 rounded-sm sm:mr-10"
          >
            <span className="grid h-8 w-8 place-items-center border border-foreground bg-foreground text-background transition-transform duration-200 group-hover:-translate-y-0.5">
              <ChartLineUp size={18} weight="regular" aria-hidden />
            </span>
            <span className="leading-none">
              <span className="block text-sm font-semibold tracking-[-0.02em]">GEM</span>
              <span className="mt-1 hidden font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground sm:block">
                Generative Engine Monitor
              </span>
            </span>
          </Link>

          <nav aria-label="Navigation principale" className="flex items-center text-sm">
            <Link
              href="/projects"
              aria-current={pathname === "/projects" ? "page" : undefined}
              className={cn(
                "inline-flex items-center gap-2 border-b-2 px-3 py-5 transition-colors",
                pathname === "/projects"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:border-foreground/30 hover:text-foreground"
              )}
            >
              <FolderOpen size={17} weight="regular" aria-hidden />
              Projets
            </Link>
          </nav>

          <div className="ml-auto flex min-w-0 items-center gap-3 sm:gap-5">
            <span className="hidden max-w-52 truncate font-mono text-[11px] text-muted-foreground md:block">
              {user.name || user.email}
            </span>
            <button
              type="button"
              onClick={() => signOut({ callbackUrl: "/login" })}
              aria-label="Se déconnecter"
              className="inline-flex h-9 w-9 items-center justify-center rounded-sm border border-transparent text-muted-foreground transition-[border-color,color,transform] hover:border-foreground/30 hover:text-foreground active:translate-y-px"
            >
              <SignOut size={18} weight="regular" aria-hidden />
            </button>
          </div>
        </div>
      </header>

      <main id="main-content" tabIndex={-1}>{children}</main>
    </div>
  );
}
