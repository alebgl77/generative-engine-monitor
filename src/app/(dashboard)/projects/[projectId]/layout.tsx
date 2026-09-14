import { getServerAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import { ProjectNav } from "@/components/dashboard/project-nav";
import { ProjectIdentityProvider } from "@/components/dashboard/project-identity";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const session = await getServerAuth();
  if (!session) return notFound();

  const project = await prisma.project.findFirst({
    where: { id: projectId, userId: session.user.id },
    select: { id: true, name: true },
  });

  if (!project) return notFound();

  return (
    <ProjectIdentityProvider projectName={project.name}>
      <ProjectNav projectId={project.id} projectName={project.name} />
      <div className="mx-auto max-w-[94rem] px-4 pb-20 pt-8 sm:px-6 sm:pt-10 lg:px-8">
        {children}
      </div>
    </ProjectIdentityProvider>
  );
}
