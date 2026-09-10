type PanelRuntime = Record<string, any>;

// The host and Vite's SSR bundle load this module as separate module instances.
const PANEL_RUNTIME_KEY = "__better_zcp_panel_runtime__";
type RuntimeGlobal = typeof globalThis & {
  [PANEL_RUNTIME_KEY]?: PanelRuntime;
};

const runtimeGlobal = globalThis as RuntimeGlobal;

export function setPanelRuntime(nextRuntime: PanelRuntime): void {
  runtimeGlobal[PANEL_RUNTIME_KEY] = nextRuntime;
}

export function getPanelRuntime(): PanelRuntime {
  const runtime = runtimeGlobal[PANEL_RUNTIME_KEY];
  if (!runtime) throw new Error("Panel runtime is not initialized");
  return runtime;
}
