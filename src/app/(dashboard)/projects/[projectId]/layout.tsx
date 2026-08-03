import { getServerAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import { ProjectNav } from "@/components/dashboard/project-nav";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { projectId: string };
}) {
  const session = await getServerAuth();
  if (!session) return notFound();

  const project = await prisma.project.findFirst({
    where: { id: params.projectId, userId: session.user.id },
    select: { id: true, name: true },
  });

  if (!project) return notFound();

  return (
    <div>
      <ProjectNav projectId={project.id} projectName={project.name} />
      <div className="p-8 max-w-7xl mx-auto">{children}</div>
    </div>
  );
}
