type PanelRuntime = Record<string, any>;

let runtime: PanelRuntime | null = null;

export function setPanelRuntime(nextRuntime: PanelRuntime): void {
  runtime = nextRuntime;
}

export function getPanelRuntime(): PanelRuntime {
  if (!runtime) throw new Error("Panel runtime is not initialized");
  return runtime;
}
