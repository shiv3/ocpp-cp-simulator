import type { CellularPolicySet } from "@ocpp-cp-simulator/core/cp/domain/modem/cellularLink";
import type { ModemCommand as ModemCommandInput } from "@ocpp-cp-simulator/contracts/modem";
import {
  PowerStateError,
  type PowerLossOptions,
  type PowerRestoreOptions,
} from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type {
  NetworkSimLayerConfig,
  ResolvedNetworkSimConfig,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/network-sim/config";
import type { CPRegistry } from "./CPRegistry";

export class RegistryNetworkOps {
  constructor(private readonly registry: CPRegistry) {}

  async getNetworkSimGlobal(): Promise<NetworkSimLayerConfig | null> {
    const manager = this.registry.getNetworkSimManager();
    return manager.getGlobal();
  }

  async saveNetworkSimGlobal(
    config: NetworkSimLayerConfig | null,
  ): Promise<void> {
    const manager = this.registry.getNetworkSimManager();
    manager.saveGlobal(config);
  }

  async getNetworkSimCp(cpId: string): Promise<{
    config: NetworkSimLayerConfig | null;
    resolved: ResolvedNetworkSimConfig;
  }> {
    const manager = this.registry.getNetworkSimManager();
    return {
      config: manager.getCp(cpId),
      resolved: manager.resolveFor(cpId),
    };
  }

  async saveNetworkSimCp(
    cpId: string,
    config: NetworkSimLayerConfig | null,
  ): Promise<void> {
    const manager = this.registry.getNetworkSimManager();
    manager.saveCp(cpId, config);
  }

  async triggerNetworkSimDisconnect(
    cpId: string,
    ruleId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    // Check if CP exists
    if (!this.registry.has(cpId)) {
      return { ok: false, error: "cp_not_found" };
    }

    // Check if CP is SOAP (unsupported)
    const service = this.registry.get(cpId);
    if (service?.isSoapChargePoint()) {
      return { ok: false, error: "soap_unsupported" };
    }

    // Trigger the disconnect
    const manager = this.registry.getNetworkSimManager();
    return manager.triggerDisconnect(cpId, ruleId);
  }

  /** #930: daemon-only SIM-scoped policies, persisted by the manager. */
  getCellularPolicies(): CellularPolicySet {
    return this.registry.getNetworkSimManager().getCellular();
  }

  async saveCellularPolicies(policies: CellularPolicySet | null) {
    this.registry.getNetworkSimManager().saveCellular(policies);
  }

  getCellularStatus() {
    return this.registry.getNetworkSimManager().cellularStatus();
  }

  async getModem(cpId: string) {
    const service = this.registry.get(cpId);
    if (!service) return { ok: false as const, error: "cp_not_found" };
    const modem = service.modemState();
    if (!modem) return { ok: false as const, error: "no_modem_model" };
    return { ok: true as const, modem };
  }

  async modemCommand(cpId: string, command: ModemCommandInput) {
    const service = this.registry.get(cpId);
    if (!service) return { ok: false as const, error: "cp_not_found" };
    return service.modemCommand(command);
  }

  async powerLoss(
    cpId: string,
    options?: PowerLossOptions,
  ): Promise<
    { ok: true; transactions: number } | { ok: false; error: string }
  > {
    const service = this.registry.get(cpId);
    if (!service) return { ok: false, error: "cp_not_found" };
    try {
      const record = service.powerLoss(options);
      return { ok: true, transactions: record.transactions.length };
    } catch (err) {
      if (err instanceof PowerStateError) return { ok: false, error: err.code };
      throw err;
    }
  }

  async powerRestore(cpId: string, options?: PowerRestoreOptions) {
    const service = this.registry.get(cpId);
    if (!service) return { ok: false as const, error: "cp_not_found" };
    try {
      return { ok: true as const, ...service.powerRestore(options) };
    } catch (err) {
      if (err instanceof PowerStateError) {
        return { ok: false as const, error: err.code };
      }
      throw err;
    }
  }
}
