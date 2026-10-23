import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

/**
 * Flat config, required since Next.js 16: `next lint` was removed and ESLint 9
 * no longer reads `.eslintrc.json`. The two shareable configs are the same pair
 * the old `extends` named, so the rules they carry are unchanged.
 */
const config = [
  {
    ignores: [".next/**", "node_modules/**", "coverage/**", "next-env.d.ts"],
  },
  ...coreWebVitals,
  ...typescript,
];

export default config;
