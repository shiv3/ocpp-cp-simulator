import { CLIChargePointService } from "../service";
import type { ChargePointInitOptions } from "../types";
import type { EventBus } from "./eventBus";

export class CPRegistry {
  private readonly services = new Map<string, CLIChargePointService>();
  private readonly unsubscribes = new Map<string, () => void>();

  constructor(private readonly bus: EventBus) {}

  has(cpId: string): boolean {
    return this.services.has(cpId);
  }

  get(cpId: string): CLIChargePointService | undefined {
    return this.services.get(cpId);
  }

  list(): ReadonlyArray<string> {
    return [...this.services.keys()];
  }

  create(init: ChargePointInitOptions): CLIChargePointService {
    if (this.services.has(init.cpId)) {
      throw new Error(`cpId already exists: ${init.cpId}`);
    }
    const svc = new CLIChargePointService(init);
    const unsub = svc.onEvent((evt) => this.bus.publish(init.cpId, evt));
    this.services.set(init.cpId, svc);
    this.unsubscribes.set(init.cpId, unsub);
    return svc;
  }

  remove(cpId: string): boolean {
    const svc = this.services.get(cpId);
    if (!svc) return false;
    svc.cleanup();
    this.unsubscribes.get(cpId)?.();
    this.unsubscribes.delete(cpId);
    this.services.delete(cpId);
    return true;
  }

  shutdownAll(): void {
    for (const [cpId, svc] of this.services) {
      svc.cleanup();
      this.unsubscribes.get(cpId)?.();
    }
    this.services.clear();
    this.unsubscribes.clear();
  }
}
