import type { FullConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

export default async function globalSetup(_config: FullConfig) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const server = await createServer({
    configFile: path.join(here, "vite.config.ts"),
    configLoader: "runner",
  });
  await server.listen();

  return async () => {
    await server.close();
  };
}
