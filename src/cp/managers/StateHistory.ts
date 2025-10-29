import type {
  StateHistoryEntry,
  HistoryOptions,
  StateStatistics,
} from "./types/StateSnapshot";

/**
 * 状態履歴管理クラス
 * メモリベースで状態遷移の履歴を記録・照会する
 */
export class StateHistory {
  private entries: StateHistoryEntry[] = [];
  private readonly maxEntries: number;
  private firstEntryTime: Date | null = null;

  constructor(maxEntries: number = 1000) {
    this.maxEntries = maxEntries;
  }

  /**
   * 履歴エントリを追加
   * @param entry 履歴エントリ
   */
  recordTransition(entry: StateHistoryEntry): void {
    this.entries.push(entry);

    // 最初のエントリのタイムスタンプを記録
    if (this.firstEntryTime === null) {
      this.firstEntryTime = entry.timestamp;
    }

    // 最大エントリ数を超えた場合、古いエントリを削除
    if (this.entries.length > this.maxEntries) {
      this.entries.shift(); // 最古のエントリを削除
    }
  }

  /**
   * 履歴を照会
   * @param options 照会オプション
   * @returns 履歴エントリの配列
   */
  getHistory(options?: HistoryOptions): StateHistoryEntry[] {
    let filtered = [...this.entries];

    if (options) {
      // エンティティでフィルタ
      if (options.entity) {
        filtered = filtered.filter((e) => e.entity === options.entity);
      }

      // エンティティIDでフィルタ
      if (options.entityId !== undefined) {
        filtered = filtered.filter((e) => e.entityId === options.entityId);
      }

      // 開始時刻でフィルタ
      if (options.fromTimestamp) {
        filtered = filtered.filter(
          (e) => e.timestamp >= options.fromTimestamp!
        );
      }

      // 終了時刻でフィルタ
      if (options.toTimestamp) {
        filtered = filtered.filter((e) => e.timestamp <= options.toTimestamp!);
      }

      // 遷移タイプでフィルタ
      if (options.transitionType) {
        filtered = filtered.filter(
          (e) => e.transitionType === options.transitionType
        );
      }

      // 制限数を適用
      if (options.limit && options.limit > 0) {
        filtered = filtered.slice(-options.limit); // 最新のN件を取得
      }
    }

    return filtered;
  }

  /**
   * 最新のエントリを取得
   * @param entity エンティティタイプ
   * @param entityId エンティティID（connectorの場合）
   * @returns 最新のエントリ、または null
   */
  getLatestEntry(
    entity: "chargePoint" | "connector",
    entityId?: number
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
   * 統計情報を取得
   * @returns 統計情報
   */
  getStatistics(): StateStatistics {
    const totalTransitions = this.entries.length;

    // エンティティ別の集計
    const transitionsByEntity: Record<string, number> = {};
    this.entries.forEach((e) => {
      const key = e.entityId
        ? `${e.entity}-${e.entityId}`
        : e.entity;
      transitionsByEntity[key] = (transitionsByEntity[key] || 0) + 1;
    });

    // タイプ別の集計
    const transitionsByType: Record<string, number> = {};
    this.entries.forEach((e) => {
      transitionsByType[e.transitionType] =
        (transitionsByType[e.transitionType] || 0) + 1;
    });

    // エラー・警告のカウント
    let errorCount = 0;
    let warningCount = 0;
    this.entries.forEach((e) => {
      if (!e.success || e.validationResult.level === "ERROR") {
        errorCount++;
      } else if (e.validationResult.level === "WARNING") {
        warningCount++;
      }
    });

    // 平均遷移回数/分を計算
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
   * エクスポート機能（将来のAPI用）
   * @param format エクスポート形式
   * @returns エクスポートされた文字列
   */
  export(format: "json" | "csv"): string {
    if (format === "json") {
      return JSON.stringify(this.entries, null, 2);
    } else if (format === "csv") {
      // CSVヘッダー
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

      // CSVボディ
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
   * クリーンアップ（古いエントリの削除）
   * @param olderThan この時刻より古いエントリを削除
   */
  cleanup(olderThan?: Date): void {
    if (olderThan) {
      this.entries = this.entries.filter((e) => e.timestamp >= olderThan);
    } else {
      // olderThan が指定されていない場合、最大エントリ数まで削減
      if (this.entries.length > this.maxEntries) {
        this.entries = this.entries.slice(-this.maxEntries);
      }
    }

    // firstEntryTime を更新
    if (this.entries.length > 0) {
      this.firstEntryTime = this.entries[0].timestamp;
    } else {
      this.firstEntryTime = null;
    }
  }

  /**
   * 全エントリをクリア
   */
  clear(): void {
    this.entries = [];
    this.firstEntryTime = null;
  }

  /**
   * 現在のエントリ数を取得
   */
  get count(): number {
    return this.entries.length;
  }
}
