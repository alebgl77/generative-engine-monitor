import { defineConfig } from "vitest/config";
import path from "node:path";

// `.mts`, so Vite's native config loader reads it as the ESM it is instead of
// warning that it parsed ESM syntax as CommonJS. `__dirname` does not exist
// under that loader; `import.meta.dirname` is its equivalent (Node >= 20.11,
// which is the floor this package already declares).
const rootDir = import.meta.dirname;

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Integration tests need a real PostgreSQL and are opt-in via DATABASE_URL.
    exclude: ["node_modules/**", ".next/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/lib/**/*.ts"],
      exclude: ["src/lib/**/types.ts", "src/lib/prisma.ts"],
    },
  },
  resolve: {
    alias: { "@": path.resolve(rootDir, "./src") },
  },
});
