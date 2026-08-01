// The opener plugin is a Tauri surface like every other one this harness
// mocks, and it has to be aliased for a second reason beyond convenience.
//
// Left unaliased, Vite pre-bundles the real plugin out of node_modules and
// resolves its own `@tauri-apps/api/core` import to a *second* instance of
// tauriCore.ts. The app then records invocations into one module's arrays
// while the specs read the other's, so every invocation assertion sees an
// empty list and every fixture setting reads as its untouched default — with
// no error anywhere to explain it.
//
// Routing through the mocked invoke keeps one instance and records an opened
// link alongside every other command, so a test can assert on it.

import { invoke } from "./tauriCore";

export async function openUrl(url: string): Promise<void> {
  await invoke("plugin:opener|open_url", { url });
}
