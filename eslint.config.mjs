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
  {
    /**
     * eslint-plugin-react-hooks 7 folds in the React Compiler rules, which flag
     * the load-on-mount effects and the render-time ref write the dashboard
     * pages have always used. They are reported rather than enforced: rewriting
     * six pages' data loading is a change to how the app fetches, not part of
     * moving the framework forward, and it deserves its own commit.
     */
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
    },
  },
];

export default config;
