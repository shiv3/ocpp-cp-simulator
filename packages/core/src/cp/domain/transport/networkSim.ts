/**
 * Network simulation types the charge point carries. The validators, limits
 * and the pipeline that applies them live in infrastructure/transport/network-sim.
 */

/** Why a socket closed, as the network-sim pipeline records it. */
export type CloseCause = "network" | "simulated" | "manual" | "internal";

export interface GenerationToken {
  readonly gen: number;
  readonly closeCause: CloseCause | null;
}

export interface LatencyRule {
  type: "latency";
  direction?: "upstream" | "downstream" | "both";
  match?: { actions: string[] };
  delayMs: number;
  jitterMs?: number;
}

export interface ManualDisconnectRule {
  type: "manual-disconnect";
  reconnectDelayMs: number;
}

export interface PeriodicDisconnectRule {
  type: "periodic-disconnect";
  intervalMs: number;
  intervalJitterMs?: number;
  reconnectDelayMs: number;
}

export type NetworkSimRule =
  LatencyRule | ManualDisconnectRule | PeriodicDisconnectRule;

export interface ResolvedNetworkSimConfig {
  enabled: boolean;
  seed: number;
  rules: Record<string, NetworkSimRule>;
}
