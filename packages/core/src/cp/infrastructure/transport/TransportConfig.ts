import type { ReconnectPolicy } from "./ReconnectPolicy";
import type { WsClientOptions } from "./WsClientOptions";

/**
 * Per-charge-point transport settings, kept in one object so the control
 * plane (`cp.create` `transport`), the CLI flags, the daemon's registry row
 * (`charge_points.transport_options`, a JSON document) and the charge point
 * agree on one shape. A missing field keeps the built-in behaviour.
 */
export interface TransportConfig {
  /** #609: reconnect policy and BootNotification retry limit. */
  readonly reconnect?: Partial<ReconnectPolicy>;
  /** #611: WebSocket client options. A runtime that cannot honour one
   *  refuses the charge point (`UnsupportedWsOptionError`). */
  readonly ws?: WsClientOptions;
}
