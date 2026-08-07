import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@tauri-apps/api/core": fileURLToPath(new URL("./mocks/tauriCore.ts", import.meta.url)),
      "@tauri-apps/api/window": fileURLToPath(new URL("./mocks/tauriWindow.ts", import.meta.url)),
      "@tauri-apps/api/app": fileURLToPath(new URL("./mocks/tauriApp.ts", import.meta.url)),
      "@tauri-apps/api/event": fileURLToPath(new URL("./mocks/tauriEvent.ts", import.meta.url)),
      "@tauri-apps/plugin-opener": fileURLToPath(
        new URL("./mocks/tauriOpener.ts", import.meta.url),
      ),
    },
  },
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1422,
    strictPort: true,
  },
});
