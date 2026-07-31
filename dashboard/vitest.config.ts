import { configDefaults, defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // Playwright owns this suite. Letting Vitest discover it calls an
      // incompatible global test API during unit collection.
      exclude: [...configDefaults.exclude, "device-test/**"],
      coverage: {
        provider: "v8",
        include: ["src/lib/**/*.{ts,tsx}", "src/state/banner.tsx"],
        reporter: ["text", "json-summary", "lcov"],
        reportsDirectory: "coverage/vitest",
        // Integer floors from the last reviewed green report (2026-07-31).
        // Raise freely; lowering requires an explicit reviewed justification.
        thresholds: {
          statements: 89,
          branches: 83,
          functions: 82,
          lines: 91,
        },
      },
    },
  }),
);
