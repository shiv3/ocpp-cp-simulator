// How the engine's transport calls a WebSocket constructor, mapped to k6's.

export interface BunStyleOptions {
  protocols?: string | string[];
  headers?: Record<string, string>;
}

/** The mapping of the constructor arguments, apart so it can be tested. */
export function k6ConstructorArgs(arg?: string | string[] | BunStyleOptions): {
  protocols: string[];
  params: { headers: Record<string, string> } | undefined;
} {
  if (typeof arg === "string") return { protocols: [arg], params: undefined };
  if (Array.isArray(arg)) return { protocols: arg, params: undefined };
  if (!arg) return { protocols: [], params: undefined };
  const p = arg.protocols;
  return {
    protocols: typeof p === "string" ? [p] : (p ?? []),
    params: arg.headers ? { headers: arg.headers } : undefined,
  };
}
