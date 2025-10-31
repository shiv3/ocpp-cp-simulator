import type { HistoryOptions, StateHistoryEntry } from "../../cp/application/services/types/StateSnapshot";

export interface StateHistoryProvider {
  getHistory(
    chargePointId: string,
    options?: HistoryOptions,
  ): Promise<StateHistoryEntry[]>;
  subscribe(
    chargePointId: string,
    handler: (entries: StateHistoryEntry[]) => void,
    options?: HistoryOptions,
  ): () => void;
}
