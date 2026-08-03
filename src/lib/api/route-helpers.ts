import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import type { Project } from "@prisma/client";
import { getServerAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { AppError, badRequest, notFound, unauthorized } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { clientIp } from "@/lib/net/client-ip";

/**
 * Route plumbing.
 *
 * The middleware guards pages only, so every API route is responsible for its
 * own authentication and ownership check. Repeating that by hand in seventeen
 * handlers works right up until the eighteenth forgets one, so it lives here:
 * `withProject` is the only supported way to reach a project-scoped resource.
 */

export interface AuthContext {
  userId: string;
  ip: string | null;
  userAgent: string | null;
}

export interface ProjectContext extends AuthContext {
  project: Project;
}


/**
 * Next.js signals control flow with thrown errors carrying a `digest`:
 * `redirect()`, `notFound()`, and the probe it uses to discover that a route
 * reads request state and must therefore be dynamic. Catching those and
 * answering 500 would both hide a redirect and mislead the build.
 */
function isFrameworkSignal(err: unknown): boolean {
  const digest = (err as { digest?: unknown })?.digest;
  return (
    typeof digest === "string" &&
    (digest.startsWith("NEXT_REDIRECT") ||
      digest === "NEXT_NOT_FOUND" ||
      digest === "DYNAMIC_SERVER_USAGE")
  );
}

function toResponse(err: unknown): NextResponse {
  if (isFrameworkSignal(err)) throw err;
  if (err instanceof AppError) {
    return NextResponse.json({ error: err.publicMessage }, { status: err.status });
  }
  if (err instanceof z.ZodError) {
    const detail = err.issues.map((i) => `${i.path.join(".") || "corps"}: ${i.message}`).join("; ");
    return NextResponse.json({ error: `Requête invalide — ${detail}` }, { status: 400 });
  }
  // An unexpected failure must not leak a stack trace or a query fragment to the
  // client; it goes to the logs instead.
  logger.error("unhandled route error", { error: err instanceof Error ? err.message : String(err) });
  return NextResponse.json({ error: "Erreur interne" }, { status: 500 });
}

export async function withAuth(
  request: NextRequest,
  handler: (ctx: AuthContext) => Promise<NextResponse>
): Promise<NextResponse> {
  try {
    const session = await getServerAuth();
    if (!session?.user?.id) throw unauthorized();
    return await handler({
      userId: session.user.id,
      ip: clientIp(request),
      userAgent: request.headers.get("user-agent"),
    });
  } catch (err) {
    return toResponse(err);
  }
}

export async function withProject(
  request: NextRequest,
  projectId: string,
  handler: (ctx: ProjectContext) => Promise<NextResponse>
): Promise<NextResponse> {
  return withAuth(request, async (auth) => {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    // A project that exists but belongs to someone else answers exactly like one
    // that does not exist. Distinguishing them would turn every project id into
    // an existence oracle.
    if (!project || project.userId !== auth.userId) throw notFound("Projet");
    return handler({ ...auth, project });
  });
}

/** Parses and validates a JSON body, turning malformed input into a 400. */
export async function parseBody<T extends z.ZodTypeAny>(
  request: NextRequest,
  schema: T
): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw badRequest("Corps de requête JSON invalide");
  }
  return schema.parse(raw);
}

export function parseQuery<T extends z.ZodTypeAny>(request: NextRequest, schema: T): z.infer<T> {
  return schema.parse(Object.fromEntries(request.nextUrl.searchParams.entries()));
}

export const json = <T>(data: T, status = 200) => NextResponse.json(data, { status });

/** Confirms a child row belongs to the project before it is read or mutated,
 * so a valid id from another project cannot be substituted. */
export function assertBelongs(row: { projectId: string } | null, projectId: string, what: string) {
  if (!row || row.projectId !== projectId) throw notFound(what);
  return row;
}
