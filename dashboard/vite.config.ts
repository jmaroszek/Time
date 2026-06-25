import process from "node:process";

import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  // Optional build-time override: shell env > dashboard/.env. When unset, the
  // path is resolved at runtime to %LOCALAPPDATA%\Time\time_log.db (see
  // src/lib/db.ts and the Rust `db_path` command).
  const env = loadEnv(mode, __dirname, "VITE_");
  const dbPath = (process.env.VITE_DB_PATH || env.VITE_DB_PATH || "").replace(/\\/g, "/");

  return {
    plugins: [react(), tailwindcss()],
    define: {
      "import.meta.env.VITE_DB_PATH": JSON.stringify(dbPath),
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
