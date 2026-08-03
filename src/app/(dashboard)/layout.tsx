import { redirect } from "next/navigation";
import { getServerAuth } from "@/lib/auth";
import { DashboardShell } from "@/components/dashboard/shell";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerAuth();
  if (!session) {
    redirect("/login");
  }

  return (
    <DashboardShell
      user={{ name: session.user.name, email: session.user.email }}
    >
      {children}
    </DashboardShell>
  );
}
