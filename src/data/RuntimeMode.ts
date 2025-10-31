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
  if (typeof import.meta !== "undefined" && (import.meta as any).env) {
    return parseRuntimeMode((import.meta as any).env.VITE_RUNTIME_MODE);
  }

  return DEFAULT_RUNTIME_MODE;
}
