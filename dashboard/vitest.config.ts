import { configDefaults, defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // Playwright and WebdriverIO own these suites. Letting Vitest discover
      // them calls their incompatible global test APIs during unit collection.
      exclude: [...configDefaults.exclude, "device-test/**"],
      coverage: {
        provider: "v8",
        include: ["src/lib/**/*.{ts,tsx}", "src/state/banner.tsx"],
        reporter: ["text", "json-summary", "lcov"],
        reportsDirectory: "coverage/vitest",
        // Integer floors from the first reviewed green report (2026-07-30).
        // Raise freely; lowering requires an explicit reviewed justification.
        thresholds: {
          statements: 82,
          branches: 79,
          functions: 74,
          lines: 83,
        },
      },
    },
  }),
);
