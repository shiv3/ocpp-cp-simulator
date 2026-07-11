import { Logger, LogType } from "../../shared/Logger";

/**
 * idTagInfo subset stored in the local authorization list. Matches
 * ts-ocpp's inline `idTagInfo` shape on SendLocalListRequest entries.
 * `expiryDate`/`parentIdTag` are intentionally not modeled — ts-ocpp's
 * generated type allows `[k: string]: unknown` for extras, but for our
 * authorization-decision path only `status` is consulted.
 */
export interface LocalAuthorizationEntry {
  status: "Accepted" | "Blocked" | "Expired" | "Invalid" | "ConcurrentTx";
}

export type SendLocalListItem = {
  idTag: string;
  idTagInfo?: { status: LocalAuthorizationEntry["status"] };
};

export type SendLocalListStatus =
  "Accepted" | "Failed" | "NotSupported" | "VersionMismatch";

export interface LocalAuthListLimits {
  /** Max total entries kept in the list. Mirrors LocalAuthListMaxLength. */
  localAuthListMaxLength: number;
  /** Max entries accepted in a single SendLocalList.req payload.
   *  Mirrors SendLocalListMaxLength. */
  sendLocalListMaxLength: number;
}

/**
 * OCPP 1.6 §9 / §6.18 / §6.10:
 *
 * Owns the Charge Point's local authorization list (idTag → idTagInfo) and
 * a monotonically increasing `version`. CSMS keeps the list in sync via
 * `SendLocalList.req` (Full replacement or Differential update) and
 * inspects `GetLocalListVersion.req` to decide whether a re-sync is needed.
 *
 * Storage is in-memory — same lifecycle decision as {@link
 * ReservationManager} (lives only while the CP process is up). The
 * persistence layer is intentionally NOT touched here so the LocalAuthList
 * doesn't drift from upstream state across daemon restarts.
 *
 * Note on the `version` field: §6.10 / §9.4 specify -1 as the value the CP
 * reports when LocalAuthListManagement is disabled. The manager itself
 * does not know whether the feature is enabled — the handler consults
 * Configuration (`LocalAuthListEnabled`) and short-circuits to -1 before
 * calling `getVersion()`.
 */
export class LocalAuthListManager {
  private list: Map<string, LocalAuthorizationEntry> = new Map();
  private version = 0;
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  getVersion(): number {
    return this.version;
  }

  size(): number {
    return this.list.size;
  }

  getEntry(idTag: string): LocalAuthorizationEntry | undefined {
    return this.list.get(idTag);
  }

  /**
   * §9.2 Full update: the new list completely replaces the existing one.
   * The supplied `listVersion` is accepted as-is (the spec lets it move
   * either way for Full).
   */
  applyFull(
    listVersion: number,
    items: SendLocalListItem[] | undefined,
    limits: LocalAuthListLimits,
  ): SendLocalListStatus {
    const next = items ?? [];
    if (next.length > limits.sendLocalListMaxLength) {
      this.logger.warn(
        `SendLocalList Full rejected: ${next.length} entries > SendLocalListMaxLength ${limits.sendLocalListMaxLength}`,
        LogType.OCPP,
      );
      return "Failed";
    }
    if (next.length > limits.localAuthListMaxLength) {
      this.logger.warn(
        `SendLocalList Full rejected: ${next.length} entries > LocalAuthListMaxLength ${limits.localAuthListMaxLength}`,
        LogType.OCPP,
      );
      return "Failed";
    }
    const fresh = new Map<string, LocalAuthorizationEntry>();
    for (const item of next) {
      if (item.idTagInfo) {
        fresh.set(item.idTag, { status: item.idTagInfo.status });
      }
      // §9.2: in a Full update, entries without idTagInfo are simply not
      // included in the resulting list — same semantics as omitting them.
    }
    this.list = fresh;
    this.version = listVersion;
    this.logger.info(
      `Local auth list replaced (version=${listVersion}, entries=${this.list.size})`,
      LogType.OCPP,
    );
    return "Accepted";
  }

  /**
   * §9.3 Differential update: each entry is inserted/updated or, when
   * `idTagInfo` is omitted, removed. `listVersion` MUST be strictly
   * greater than the current version, otherwise the CP returns
   * `VersionMismatch` and the list is left untouched.
   */
  applyDifferential(
    listVersion: number,
    items: SendLocalListItem[] | undefined,
    limits: LocalAuthListLimits,
  ): SendLocalListStatus {
    if (listVersion <= this.version) {
      this.logger.warn(
        `SendLocalList Differential rejected: version ${listVersion} <= current ${this.version}`,
        LogType.OCPP,
      );
      return "VersionMismatch";
    }
    const updates = items ?? [];
    if (updates.length > limits.sendLocalListMaxLength) {
      this.logger.warn(
        `SendLocalList Differential rejected: ${updates.length} entries > SendLocalListMaxLength ${limits.sendLocalListMaxLength}`,
        LogType.OCPP,
      );
      return "Failed";
    }
    // Apply to a working copy so we can roll back on overflow.
    const draft = new Map(this.list);
    for (const item of updates) {
      if (item.idTagInfo) {
        draft.set(item.idTag, { status: item.idTagInfo.status });
      } else {
        draft.delete(item.idTag);
      }
    }
    if (draft.size > limits.localAuthListMaxLength) {
      this.logger.warn(
        `SendLocalList Differential rejected: post-merge size ${draft.size} > LocalAuthListMaxLength ${limits.localAuthListMaxLength}`,
        LogType.OCPP,
      );
      return "Failed";
    }
    this.list = draft;
    this.version = listVersion;
    this.logger.info(
      `Local auth list diff applied (version=${listVersion}, entries=${this.list.size})`,
      LogType.OCPP,
    );
    return "Accepted";
  }

  dispose(): void {
    this.list.clear();
    this.version = 0;
  }
}
