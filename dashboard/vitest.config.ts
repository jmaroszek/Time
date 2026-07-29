import { configDefaults, defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // Playwright and WebdriverIO own these suites. Letting Vitest discover
      // them calls their incompatible global test APIs during unit collection.
      exclude: [...configDefaults.exclude, "device-test/**"],
    },
  }),
);
