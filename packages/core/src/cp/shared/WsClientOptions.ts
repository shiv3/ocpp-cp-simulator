/**
 * WebSocket client options of a charge point (#611) and which runtime can
 * honour which. Measured with a PoC on Bun 1.3.14 and Node 22 + `ws`
 * (recorded in docs/concepts/ocpp-versions-and-transports.md):
 *
 * | option                 | Bun native | Node `ws`   | browser |
 * | ---------------------- | ---------- | ----------- | ------- |
 * | `handshakeTimeoutMs`   | transport  | transport   | transport |
 * | `perMessageDeflate`    | yes        | yes         | no      |
 * | `maxPayloadBytes`      | ignored    | yes         | no      |
 * | `proxy`                | yes        | no (no agent bundled) | no |
 * | `localAddress`         | ignored    | yes         | no      |
 *
 * "transport" = enforced by `OCPPWebSocket` itself with a timer, so it holds
 * everywhere. An option the runtime would ignore is **refused** when the
 * charge point is created (never dropped silently).
 */

export interface WsClientOptions {
  /** Close an attempt that has not opened within this many ms (> 0). */
  readonly handshakeTimeoutMs?: number;
  /** `false` stops offering `permessage-deflate`; `true` offers it (the
   *  default of Bun and `ws`). */
  readonly perMessageDeflate?: boolean;
  /** Largest incoming message in bytes; a bigger one closes the socket. */
  readonly maxPayloadBytes?: number;
  /** `http://host:port` / `https://host:port` proxy the upgrade goes through
   *  with CONNECT. */
  readonly proxy?: string;
  /** Local IP address the outgoing connection binds to. */
  readonly localAddress?: string;
}

export type WsRuntime = "bun" | "node" | "browser";

export const WS_CLIENT_OPTION_NAMES = [
  "handshakeTimeoutMs",
  "perMessageDeflate",
  "maxPayloadBytes",
  "proxy",
  "localAddress",
] as const satisfies readonly (keyof WsClientOptions)[];

/** The runtimes that honour each option. */
const SUPPORT: Record<keyof WsClientOptions, readonly WsRuntime[]> = {
  handshakeTimeoutMs: ["bun", "node", "browser"],
  perMessageDeflate: ["bun", "node"],
  maxPayloadBytes: ["node"],
  proxy: ["bun"],
  localAddress: ["node"],
};

export class UnsupportedWsOptionError extends Error {
  constructor(
    readonly option: keyof WsClientOptions,
    readonly runtime: WsRuntime,
  ) {
    super(
      `WebSocket option "${option}" is not supported on ${runtime} (supported on: ${SUPPORT[option].join(", ")})`,
    );
    this.name = "UnsupportedWsOptionError";
  }
}

export function currentWsRuntime(): WsRuntime {
  const g = globalThis as {
    document?: unknown;
    Bun?: unknown;
    process?: { versions?: { node?: string } };
  };
  if (typeof g.document !== "undefined") return "browser";
  if (typeof g.Bun !== "undefined") return "bun";
  return "node";
}

/** `undefined` when valid, else the first problem. Shape only. */
export function validateWsClientOptions(
  options: WsClientOptions,
): string | undefined {
  const { handshakeTimeoutMs, maxPayloadBytes, proxy, localAddress } = options;
  if (
    handshakeTimeoutMs !== undefined &&
    !(Number.isFinite(handshakeTimeoutMs) && handshakeTimeoutMs > 0)
  ) {
    return "ws.handshakeTimeoutMs must be a number > 0";
  }
  if (
    maxPayloadBytes !== undefined &&
    !(Number.isInteger(maxPayloadBytes) && maxPayloadBytes > 0)
  ) {
    return "ws.maxPayloadBytes must be an integer > 0";
  }
  if (proxy !== undefined) {
    try {
      const url = new URL(proxy);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return "ws.proxy must be an http:// or https:// URL";
      }
    } catch {
      return "ws.proxy must be an http:// or https:// URL";
    }
  }
  if (localAddress !== undefined && localAddress.length === 0) {
    return "ws.localAddress must not be empty";
  }
  return undefined;
}

/** The options `runtime` cannot honour, in declaration order. */
export function unsupportedWsOptions(
  options: WsClientOptions,
  runtime: WsRuntime = currentWsRuntime(),
): Array<keyof WsClientOptions> {
  return WS_CLIENT_OPTION_NAMES.filter(
    (name) => options[name] !== undefined && !SUPPORT[name].includes(runtime),
  );
}

/** Validates the shape and throws on the first option the runtime would
 *  ignore. Returns the options unchanged. */
export function assertWsClientOptions(
  options: WsClientOptions | undefined,
  runtime: WsRuntime = currentWsRuntime(),
): WsClientOptions {
  if (!options) return {};
  const problem = validateWsClientOptions(options);
  if (problem) throw new RangeError(problem);
  const [first] = unsupportedWsOptions(options, runtime);
  if (first) throw new UnsupportedWsOptionError(first, runtime);
  return options;
}
