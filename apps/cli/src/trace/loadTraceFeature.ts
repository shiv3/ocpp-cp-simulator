/**
 * Load a module that depends on the Open OCPP Trace SDK (`@open-ocpp-trace/*`).
 * That SDK is published on GitHub Packages only and is an optional dependency,
 * so the CLI imports it lazily: only `--trace-output` and `analyze` need it.
 * A missing package is reported with an actionable message instead of a stack
 * trace at startup.
 */
export async function loadTraceFeature<T>(
  feature: string,
  load: () => Promise<T>,
): Promise<T> {
  try {
    return await load();
  } catch (err) {
    if (isMissingTraceSdk(err)) {
      throw new Error(
        `${feature} needs the Open OCPP Trace SDK (@open-ocpp-trace/core and @open-ocpp-trace/jsonl), which is not installed. ` +
          "It is published on GitHub Packages only; install it with a token that has read:packages " +
          "(GITHUB_TOKEN=$(gh auth token) bun install). See CONTRIBUTING.md.",
        { cause: err },
      );
    }
    throw err;
  }
}

export function isMissingTraceSdk(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code;
  return (
    (code === "ERR_MODULE_NOT_FOUND" ||
      code === "MODULE_NOT_FOUND" ||
      /cannot find (module|package)|module not found/i.test(message)) &&
    message.includes("@open-ocpp-trace/")
  );
}
