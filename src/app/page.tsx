import { redirect } from "next/navigation";
import { getServerAuth } from "@/lib/auth";

export default async function Home() {
  const session = await getServerAuth();
  if (session) {
    redirect("/projects");
  }
  redirect("/login");
}
