import type { AppDiagnostics, RuntimeState, WidgetPreferences } from "../types";

export type StartupFailure = "preferences" | "runtimeState" | "diagnostics" | "autostart";

export interface StartupLoadResult {
  preferences: WidgetPreferences | null;
  runtimeState: RuntimeState | null;
  diagnostics: AppDiagnostics | null;
  autostartEnabled: boolean | null;
  failures: StartupFailure[];
}
interface StartupDependencies {
  getPreferences: () => Promise<WidgetPreferences>;
  getRuntimeState: () => Promise<RuntimeState>;
  getDiagnostics: () => Promise<AppDiagnostics>;
  getAutostartEnabled: () => Promise<boolean>;
}

export async function loadStartupState(dependencies: StartupDependencies): Promise<StartupLoadResult> {
  const settled = await Promise.allSettled([
    dependencies.getPreferences(),
    dependencies.getRuntimeState(),
    dependencies.getDiagnostics(),
    dependencies.getAutostartEnabled(),
  ] as const);
  const failures: StartupFailure[] = [];
  const value = <T,>(result: PromiseSettledResult<T>, name: StartupFailure): T | null => {
    if (result.status === "fulfilled") return result.value;
    failures.push(name);
    return null;
  };
  return {
    preferences: value(settled[0], "preferences"),
    runtimeState: value(settled[1], "runtimeState"),
    diagnostics: value(settled[2], "diagnostics"),
    autostartEnabled: value(settled[3], "autostart"),
    failures,
  };
}
