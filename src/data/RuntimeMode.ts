export type RuntimeMode = "local" | "remote";

export const DEFAULT_RUNTIME_MODE: RuntimeMode = "local";

export function parseRuntimeMode(value: string | undefined | null): RuntimeMode {
  if (!value) return DEFAULT_RUNTIME_MODE;
  const normalized = value.trim().toLowerCase();
  return normalized === "remote" ? "remote" : DEFAULT_RUNTIME_MODE;
}

export function resolveRuntimeMode(envValue?: string | null): RuntimeMode {
  if (typeof envValue === "string") {
    return parseRuntimeMode(envValue);
  }

  // Attempt to read from Vite env if available at runtime
  if (typeof import.meta !== "undefined") {
    const meta = import.meta as unknown;
    if (typeof meta === "object" && meta !== null && "env" in meta) {
      const envRecord = (meta as { env?: Record<string, unknown> }).env;
      const runtimeMode = typeof envRecord?.VITE_RUNTIME_MODE === "string"
        ? (envRecord.VITE_RUNTIME_MODE as string)
        : undefined;
      if (runtimeMode) {
        return parseRuntimeMode(runtimeMode);
      }
    }
  }

  return DEFAULT_RUNTIME_MODE;
}
