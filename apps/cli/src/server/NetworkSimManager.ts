import type { Database } from "@ocpp-cp-simulator/core/cp/domain/persistence/Database";
import type {
  NetworkSimLayerConfig,
  ResolvedNetworkSimConfig,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/network-sim/config";
import {
  validateLayerConfig,
  resolveNetworkSimConfig,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/network-sim/config";

import {
  cellularPoliciesProblem,
  type CellularLinkWire,
  type CellularPolicySet,
} from "@ocpp-cp-simulator/core/cp/domain/modem/cellularLink";

const CELLULAR_KEY = "networkSim:cellular";

export interface NetworkSimManagerDeps {
  /** #930: every registered charge point (SOAP included: it reports the link). */
  listCpIds?(): string[];
  /** #930: push the SIM-scoped policy set to a charge point. */
  applyCellularPolicies?(cpId: string, policies: CellularPolicySet): void;
  /** #930: the resolved cellular link of a charge point, or `null`. */
  getCellularLink?(cpId: string): CellularLinkWire | null;
  listLiveWsCpIds(): string[];
  applyToCp(cpId: string, resolved: ResolvedNetworkSimConfig): void;
  triggerCpDisconnect(
    cpId: string,
    ruleId: string,
  ): { ok: true } | { ok: false; error: string };
}

/**
 * Manages network simulation configuration: global layer + per-CP overrides.
 * Persist to kv table, apply to live WS charge points, and coordinate lifecycle.
 */
export class NetworkSimManager {
  private globalLayer: NetworkSimLayerConfig | null = null;
  private perCp: Map<string, NetworkSimLayerConfig> = new Map();
  /** #930: SIM-scoped policies (persisted as one document). */
  private cellular: CellularPolicySet = {};

  constructor(
    private readonly database: Database | null,
    private readonly deps: NetworkSimManagerDeps,
  ) {
    if (database) {
      this.loadFromDatabase();
    }
  }

  private loadFromDatabase(): void {
    if (!this.database) return;

    // Load global config
    try {
      const globalRow = this.database.get<{ value: string }>(
        "SELECT value FROM kv WHERE key = ?",
        ["networkSim:global"],
      );
      if (globalRow) {
        const parsed = JSON.parse(globalRow.value) as unknown;
        const result = validateLayerConfig(parsed);
        if (result.ok) {
          this.globalLayer = result.config;
        } else {
          console.error(
            "[NetworkSimManager] Failed to load global config:",
            result.errors.join("; "),
          );
        }
      }
    } catch (err) {
      console.error(
        "[NetworkSimManager] Error loading global config:",
        err instanceof Error ? err.message : err,
      );
    }

    // #930: SIM-scoped policies
    try {
      const row = this.database.get<{ value: string }>(
        "SELECT value FROM kv WHERE key = ?",
        [CELLULAR_KEY],
      );
      if (row) {
        const parsed = JSON.parse(row.value) as unknown;
        const problem = cellularPoliciesProblem(parsed);
        if (problem === null) this.cellular = parsed as CellularPolicySet;
        else {
          console.error(
            "[NetworkSimManager] Failed to load cellular policies:",
            problem,
          );
        }
      }
    } catch (err) {
      console.error(
        "[NetworkSimManager] Error loading cellular policies:",
        err instanceof Error ? err.message : err,
      );
    }

    // Load all per-CP configs
    try {
      const rows = this.database.all<{ key: string; value: string }>(
        "SELECT key, value FROM kv WHERE key LIKE ?",
        ["networkSim:cp:%"],
      );
      for (const row of rows) {
        const cpId = row.key.replace("networkSim:cp:", "");
        try {
          const parsed = JSON.parse(row.value) as unknown;
          const result = validateLayerConfig(parsed);
          if (result.ok) {
            this.perCp.set(cpId, result.config);
          } else {
            console.error(
              `[NetworkSimManager] Failed to load config for CP "${cpId}":`,
              result.errors.join("; "),
            );
          }
        } catch (err) {
          console.error(
            `[NetworkSimManager] Error parsing config for CP "${cpId}":`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    } catch (err) {
      console.error(
        "[NetworkSimManager] Error loading per-CP configs:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  getCellular(): CellularPolicySet {
    return this.cellular;
  }

  /**
   * #930: replace the SIM-scoped policy set (`null` clears it), persist it and
   * push it to every charge point. A policy selects by SIM identity, ICCID or
   * operator, so it also governs stations that acquire a matching SIM later
   * and charge points created after this call. Independent of the global and
   * per-CP layers: those can never reactivate a blocked SIM.
   */
  saveCellular(policies: CellularPolicySet | null): void {
    const next = policies ?? {};
    const problem = cellularPoliciesProblem(next);
    if (problem !== null) {
      throw new Error(`Invalid cellular policies: ${problem}`);
    }
    if (this.database) {
      if (policies === null || Object.keys(next).length === 0) {
        this.database.run("DELETE FROM kv WHERE key = ?", [CELLULAR_KEY]);
      } else {
        this.database.run(
          "INSERT INTO kv (key, value) VALUES (?, ?) " +
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          [CELLULAR_KEY, JSON.stringify(next)],
        );
      }
    }
    this.cellular = next;
    for (const cpId of this.deps.listCpIds?.() ?? []) {
      try {
        this.deps.applyCellularPolicies?.(cpId, next);
      } catch (err) {
        console.error(
          `[NetworkSimManager] Failed to apply cellular policies to CP "${cpId}":`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  /**
   * #930: what an operator needs to see — the policies, how many stations
   * are out of service or throttled, and each affected station's link.
   * Stations without a modem model are not governed and not listed.
   */
  cellularStatus(): {
    policies: CellularPolicySet;
    total: number;
    unavailable: number;
    throttled: number;
    cps: Array<{ cpId: string; link: CellularLinkWire }>;
  } {
    const cps: Array<{ cpId: string; link: CellularLinkWire }> = [];
    for (const cpId of this.deps.listCpIds?.() ?? []) {
      const link = this.deps.getCellularLink?.(cpId);
      if (link) cps.push({ cpId, link });
    }
    return {
      policies: this.cellular,
      total: cps.length,
      unavailable: cps.filter((c) => !c.link.available).length,
      throttled: cps.filter(
        (c) =>
          c.link.upstreamBytesPerSecond !== null ||
          c.link.downstreamBytesPerSecond !== null,
      ).length,
      cps,
    };
  }

  getGlobal(): NetworkSimLayerConfig | null {
    return this.globalLayer;
  }

  saveGlobal(config: NetworkSimLayerConfig | null): void {
    if (config !== null) {
      const result = validateLayerConfig(config);
      if (!result.ok) {
        throw new Error(
          `Invalid global network simulation config: ${result.errors.join("; ")}`,
        );
      }
    }

    // Persist to kv
    if (this.database) {
      if (config === null) {
        this.database.run("DELETE FROM kv WHERE key = ?", [
          "networkSim:global",
        ]);
      } else {
        this.database.run(
          "INSERT INTO kv (key, value) VALUES (?, ?) " +
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          ["networkSim:global", JSON.stringify(config)],
        );
      }
    }

    // Update in-memory state
    this.globalLayer = config;

    // Fan-out to all live WS CPs
    const cpIds = this.deps.listLiveWsCpIds();
    for (const cpId of cpIds) {
      try {
        const resolved = this.resolveFor(cpId);
        this.deps.applyToCp(cpId, resolved);
      } catch (err) {
        console.error(
          `[NetworkSimManager] Failed to apply global config to CP "${cpId}":`,
          err instanceof Error ? err.message : err,
        );
        // Continue to next CP — do not roll back or stop loop
      }
    }
  }

  getCp(cpId: string): NetworkSimLayerConfig | null {
    return this.perCp.get(cpId) ?? null;
  }

  saveCp(cpId: string, config: NetworkSimLayerConfig | null): void {
    if (config !== null) {
      const result = validateLayerConfig(config);
      if (!result.ok) {
        throw new Error(
          `Invalid network simulation config for CP "${cpId}": ${result.errors.join("; ")}`,
        );
      }
    }

    // Persist to kv
    if (this.database) {
      if (config === null) {
        this.database.run("DELETE FROM kv WHERE key = ?", [
          `networkSim:cp:${cpId}`,
        ]);
      } else {
        this.database.run(
          "INSERT INTO kv (key, value) VALUES (?, ?) " +
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          [`networkSim:cp:${cpId}`, JSON.stringify(config)],
        );
      }
    }

    // Update in-memory state
    if (config === null) {
      this.perCp.delete(cpId);
    } else {
      this.perCp.set(cpId, config);
    }

    // Apply to CP if currently live (guard: only apply if listed)
    const cpIds = this.deps.listLiveWsCpIds();
    if (cpIds.includes(cpId)) {
      try {
        const resolved = this.resolveFor(cpId);
        this.deps.applyToCp(cpId, resolved);
      } catch (err) {
        console.error(
          `[NetworkSimManager] Failed to apply config to CP "${cpId}":`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  resolveFor(cpId: string): ResolvedNetworkSimConfig {
    return resolveNetworkSimConfig(
      this.globalLayer,
      this.perCp.get(cpId) ?? null,
      cpId,
    );
  }

  triggerDisconnect(
    cpId: string,
    ruleId: string,
  ): { ok: true } | { ok: false; error: string } {
    return this.deps.triggerCpDisconnect(cpId, ruleId);
  }

  onCpCreated(cpId: string): void {
    try {
      // #930: before the charge point connects, like the network layers.
      this.deps.applyCellularPolicies?.(cpId, this.cellular);
    } catch (err) {
      console.error(
        `[NetworkSimManager] Failed to attach cellular policies to new CP "${cpId}":`,
        err instanceof Error ? err.message : err,
      );
    }
    try {
      const resolved = this.resolveFor(cpId);
      this.deps.applyToCp(cpId, resolved);
    } catch (err) {
      console.error(
        `[NetworkSimManager] Failed to attach config to new CP "${cpId}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  onCpDeleted(cpId: string): void {
    this.perCp.delete(cpId);
    if (this.database) {
      this.database.run("DELETE FROM kv WHERE key = ?", [
        `networkSim:cp:${cpId}`,
      ]);
    }
  }
}
