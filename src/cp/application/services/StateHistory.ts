import type {
  StateHistoryEntry,
  HistoryOptions,
  StateStatistics,
} from "./types/StateSnapshot";

/**
 * State history management class
 * Records and queries state transition history in memory
 */
export class StateHistory {
  private entries: StateHistoryEntry[] = [];
  private readonly maxEntries: number;
  private firstEntryTime: Date | null = null;

  constructor(maxEntries: number = 1000) {
    this.maxEntries = maxEntries;
  }

  /**
   * Add history entry
   * @param entry History entry
   */
  recordTransition(entry: StateHistoryEntry): void {
    this.entries.push(entry);

    // Record timestamp of first entry
    if (this.firstEntryTime === null) {
      this.firstEntryTime = entry.timestamp;
    }

    // Delete old entries if max entries exceeded
    if (this.entries.length > this.maxEntries) {
      this.entries.shift(); // Delete oldest entry
    }
  }

  /**
   * Query history
   * @param options Query options
   * @returns Array of history entries
   */
  getHistory(options?: HistoryOptions): StateHistoryEntry[] {
    let filtered = [...this.entries];

    if (options) {
      // Filter by entity
      if (options.entity) {
        filtered = filtered.filter((e) => e.entity === options.entity);
      }

      // Filter by entity ID
      if (options.entityId !== undefined) {
        filtered = filtered.filter((e) => e.entityId === options.entityId);
      }

      // Filter by start time
      if (options.fromTimestamp) {
        filtered = filtered.filter(
          (e) => e.timestamp >= options.fromTimestamp!,
        );
      }

      // Filter by end time
      if (options.toTimestamp) {
        filtered = filtered.filter((e) => e.timestamp <= options.toTimestamp!);
      }

      // Filter by transition type
      if (options.transitionType) {
        filtered = filtered.filter(
          (e) => e.transitionType === options.transitionType,
        );
      }

      // Apply limit
      if (options.limit && options.limit > 0) {
        filtered = filtered.slice(-options.limit); // Get latest N entries
      }
    }

    return filtered;
  }

  /**
   * Get latest entry
   * @param entity Entity type
   * @param entityId Entity ID (for connector)
   * @returns Latest entry or null
   */
  getLatestEntry(
    entity: "chargePoint" | "connector",
    entityId?: number,
  ): StateHistoryEntry | null {
    const filtered = this.entries.filter((e) => {
      if (e.entity !== entity) return false;
      if (entity === "connector" && entityId !== undefined) {
        return e.entityId === entityId;
      }
      return true;
    });

    return filtered.length > 0 ? filtered[filtered.length - 1] : null;
  }

  /**
   * Get statistics
   * @returns Statistics
   */
  getStatistics(): StateStatistics {
    const totalTransitions = this.entries.length;

    // Aggregate by entity
    const transitionsByEntity: Record<string, number> = {};
    this.entries.forEach((e) => {
      const key = e.entityId ? `${e.entity}-${e.entityId}` : e.entity;
      transitionsByEntity[key] = (transitionsByEntity[key] || 0) + 1;
    });

    // Aggregate by type
    const transitionsByType: Record<string, number> = {};
    this.entries.forEach((e) => {
      transitionsByType[e.transitionType] =
        (transitionsByType[e.transitionType] || 0) + 1;
    });

    // Count errors and warnings
    let errorCount = 0;
    let warningCount = 0;
    this.entries.forEach((e) => {
      if (!e.success || e.validationResult.level === "ERROR") {
        errorCount++;
      } else if (e.validationResult.level === "WARNING") {
        warningCount++;
      }
    });

    // Calculate average transitions per minute
    let averageTransitionsPerMinute = 0;
    if (this.firstEntryTime && this.entries.length > 0) {
      const lastEntry = this.entries[this.entries.length - 1];
      const durationMs =
        lastEntry.timestamp.getTime() - this.firstEntryTime.getTime();
      const durationMinutes = durationMs / (1000 * 60);
      if (durationMinutes > 0) {
        averageTransitionsPerMinute = totalTransitions / durationMinutes;
      }
    }

    return {
      totalTransitions,
      transitionsByEntity,
      transitionsByType,
      errorCount,
      warningCount,
      averageTransitionsPerMinute,
    };
  }

  /**
   * Export feature (for future API)
   * @param format Export format
   * @returns Exported string
   */
  export(format: "json" | "csv"): string {
    if (format === "json") {
      return JSON.stringify(this.entries, null, 2);
    } else if (format === "csv") {
      // CSV header
      const headers = [
        "id",
        "timestamp",
        "entity",
        "entityId",
        "transitionType",
        "fromState",
        "toState",
        "source",
        "success",
        "validationLevel",
        "errorMessage",
      ].join(",");

      // CSV body
      const rows = this.entries.map((e) => {
        return [
          e.id,
          e.timestamp.toISOString(),
          e.entity,
          e.entityId || "",
          e.transitionType,
          e.fromState,
          e.toState,
          e.context.source,
          e.success,
          e.validationResult.level,
          e.errorMessage || "",
        ]
          .map((v) => `"${v}"`)
          .join(",");
      });

      return [headers, ...rows].join("\n");
    }

    throw new Error(`Unsupported export format: ${format}`);
  }

  /**
   * Cleanup (delete old entries)
   * @param olderThan Delete entries older than this time
   */
  cleanup(olderThan?: Date): void {
    if (olderThan) {
      this.entries = this.entries.filter((e) => e.timestamp >= olderThan);
    } else {
      // If olderThan not specified, reduce to max entries
      if (this.entries.length > this.maxEntries) {
        this.entries = this.entries.slice(-this.maxEntries);
      }
    }

    // Update firstEntryTime
    if (this.entries.length > 0) {
      this.firstEntryTime = this.entries[0].timestamp;
    } else {
      this.firstEntryTime = null;
    }
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.entries = [];
    this.firstEntryTime = null;
  }

  /**
   * Get current entry count
   */
  get count(): number {
    return this.entries.length;
  }
}
