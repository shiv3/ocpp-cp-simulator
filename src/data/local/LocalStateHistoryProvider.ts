import type { HistoryOptions, StateHistoryEntry } from "../../cp/application/services/types/StateSnapshot";
import type { StateHistoryProvider } from "../interfaces/StateHistoryProvider";
import { LocalChargePointService } from "./LocalChargePointService";

const DEFAULT_POLL_INTERVAL_MS = 1000;

export class LocalStateHistoryProvider implements StateHistoryProvider {
  constructor(private readonly chargePointService: LocalChargePointService) {}

  async getHistory(chargePointId: string, options?: HistoryOptions): Promise<StateHistoryEntry[]> {
    const chargePoint = this.chargePointService.getChargePointHandle(chargePointId);
    if (!chargePoint) {
      return [];
    }

    return chargePoint.stateManager.history.getHistory(options);
  }

  subscribe(
    chargePointId: string,
    handler: (entries: StateHistoryEntry[]) => void,
    options?: HistoryOptions,
  ): () => void {
    let cancelled = false;

    const emit = async () => {
      const history = await this.getHistory(chargePointId, options);
      if (!cancelled) {
        handler(history);
      }
    };

    void emit();
    const interval = setInterval(emit, DEFAULT_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }
}
