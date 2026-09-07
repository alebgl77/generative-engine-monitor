import Link from "next/link";
import { getEnv } from "@/lib/env";
import SignupForm from "./signup-form";

// The server setting is read at runtime, never baked into a client bundle.
export const dynamic = "force-dynamic";

export default function SignupPage() {
  if (getEnv().REGISTRATION_ENABLED) return <SignupForm />;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">
            Generative Engine Monitor
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Observatoire de visibilité générative
          </p>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <h2 className="text-lg font-medium mb-4">Inscriptions fermées</h2>
          <p className="text-sm text-muted-foreground">
            La création de nouveaux comptes est désactivée sur cette instance.
          </p>
        </div>

        <p className="text-center text-sm text-muted-foreground mt-4">
          Déjà un compte ?{" "}
          <Link href="/login" className="text-primary hover:underline">
            Se connecter
          </Link>
        </p>
      </div>
    </div>
  );
}
