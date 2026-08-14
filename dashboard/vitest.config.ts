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
        // Coverage is diagnostic evidence, not a behavior contract. A global
        // percentage made harmless branches fail CI while permitting gaps in
        // critical code hidden behind well-covered modules.
      },
    },
  }),
);
