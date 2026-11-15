import type { EventEmitter } from "../../shared/EventEmitter";
import type { Transaction } from "./Transaction";
import type { EVSettings } from "./EVSettings";
import type { MeterRealism } from "./MeterRealism";
import type { OperatingPoint } from "./OperatingPoint";
import { resolveSessionIntent, type SessionIntent } from "./SessionIntent";
import type { ConnectorEvents } from "./ConnectorEvents";

/** What the energy and SoC bookkeeping needs from the connector that owns it. */
export interface ConnectorEnergyHost {
  now(): number;
  meterValueWh(): number;
  setMeterValueWh(value: number): void;
  socPercent(): number | null;
  setSocPercent(value: number | null): void;
  socAwaitsNextTransaction(): boolean;
  setSocAwaitsNextTransaction(value: boolean): void;
  patchTransaction(fields: Partial<Record<keyof Transaction, unknown>>): void;
  exportWh(): number;
  exportRegisterWh(): number;
  setExportWh(value: number): void;
  exportTickedAt(): number | null;
  setExportTickedAt(value: number | null): void;
  socMeterSyncEnabled(): boolean;
  meterRealism(): MeterRealism | undefined;
  evSettings(): EVSettings;
  transaction(): Transaction | null;
  sessionIntent(): SessionIntent;
  operatingPoint(): OperatingPoint;
  isMeterSchedulerActive(): boolean;
  stopMeterScheduler(): void;
  emit: EventEmitter<ConnectorEvents>["emit"];
}

/**
 * Register energy, export integration, SoC derivation and the auto-stop at the
 * target SoC. Moved verbatim out of `Connector` (#877); the fields stay on the
 * connector and are reached through the host.
 */
export class ConnectorEnergy {
  /** Register values the last Interval sample of each stream was measured
   *  from (#615): one baseline per stream (sampled, aligned, transaction-end
   *  history), so two readers never share one. */
  private intervalBaselines = new Map<
    string,
    { key: string; importWh: number; exportWh: number }
  >();

  constructor(private readonly host: ConnectorEnergyHost) {}

  /** Integrate the export power since the previous tick. Called at the start
   *  of every register tick; a no-op without a discharge term. */
  integrateExport(): void {
    if (!this.host.meterRealism()?.export) return;
    const now = this.host.now();
    const point = this.host.operatingPoint();
    if (this.host.exportTickedAt() !== null && point.exportW > 0) {
      this.host.setExportWh(
        this.host.exportWh() +
          (point.exportW * (now - this.host.exportTickedAt()!)) / 3_600_000,
      );
    }
    this.host.setExportTickedAt(now);
  }

  /**
   * The energy moved since the previous Interval sample (#615,
   * `Energy.Active.{Import,Export}.Interval`), then start a new interval. The
   * first Interval sample of a transaction starts at its `meterStart` (import)
   * or at the export register as it reads then. Called by the
   * sample builder only when an Interval measurand is asked for.
   */
  takeIntervalEnergyWh(stream = "sampled"): {
    importWh: number;
    exportWh: number;
  } {
    const key = String(this.host.transaction()?.startTime?.getTime() ?? "none");
    const importNow = this.host.meterValueWh();
    const exportNow = this.host.exportRegisterWh();
    const previous = this.intervalBaselines.get(stream);
    const start =
      previous?.key === key
        ? previous
        : {
            key,
            importWh: this.host.transaction()?.meterStart ?? importNow,
            exportWh: exportNow,
          };
    this.intervalBaselines.set(stream, {
      key,
      importWh: importNow,
      exportWh: exportNow,
    });
    return {
      importWh: Math.max(0, importNow - start.importWh),
      exportWh: Math.max(0, exportNow - start.exportWh),
    };
  }

  socFromMeterValue(meterValueWh: number): number | null {
    const transactionCapacity = this.host.transaction()?.batteryCapacityKwh;
    const capacity =
      transactionCapacity && transactionCapacity > 0
        ? transactionCapacity
        : this.host.evSettings().batteryCapacityKwh;
    if (capacity <= 0) return null;

    const initial = this.host.sessionIntent().initialSoc ?? 0;
    const meterStart = this.host.transaction()?.meterStart ?? 0;
    const deliveredKWh = Math.max(0, meterValueWh - meterStart) / 1000;
    const derived = initial + (deliveredKWh / capacity) * 100;
    return Math.min(100, Math.max(0, derived));
  }

  applyMeterValue(value: number): void {
    // OCPP 1.6 register meter values — StartTransaction.meterStart,
    // StopTransaction.meterStop and MeterValues sampled values for
    // Energy.Active.Import.Register — are integer watt-hours. The auto-meter
    // curve interpolates in kWh and can yield a fractional Wh, so round to an
    // integer here. A fractional meterStop is rejected by a strict CSMS with a
    // FormationViolation ("cannot unmarshal number … into … of type int"),
    // which silently strands the transaction in "Charging".
    const meterValueWh = Math.round(value);
    this.host.setMeterValueWh(meterValueWh);
    this.host.emit("meterValueChange", { meterValue: meterValueWh });
    // Mirror the new meter value into SoC when the UI has flipped Sync on.
    // We do it here (not just in UI handlers) so the scenario's auto-meter
    // scheduler and any other domain caller also drive SoC. capacity=0 means
    // we have no way to convert — leave SoC untouched in that case.
    if (this.host.socMeterSyncEnabled()) {
      const derived = this.socFromMeterValue(meterValueWh);
      if (derived !== null && this.host.socPercent() !== derived) {
        this.host.setSocPercent(derived);
        this.host.setSocAwaitsNextTransaction(false);
        this.host.emit("socChange", { soc: derived });
      }
    }
    this.checkAutoStop();
  }

  /**
   * Effective SoC used for the auto-stop check. Prefers the explicit
   * `socPercent` (manual override, or values reported via MeterValue
   * SoC samples) and falls back to the value implied by the meter
   * (initialSoc + deliveredKWh / capacityKWh × 100).
   */
  effectiveSocPercent(): number | null {
    if (this.host.socPercent() !== null) return this.host.socPercent();
    return this.socFromMeterValue(this.host.meterValueWh());
  }

  /**
   * If `stopAtTargetSoc` is enabled and the connector has hit its target,
   * stop the in-flight meter scheduler and fire `autoStopRequested` so
   * the ChargePoint can end the transaction.
   */
  checkAutoStop(): void {
    if (!this.host.transaction()) return;
    if (!this.host.sessionIntent().stopAtTarget) return;
    if (!this.host.isMeterSchedulerActive()) return;
    const current = this.effectiveSocPercent();
    if (current === null) return;
    const targetSoc = this.host.sessionIntent().targetSoc;
    if (targetSoc === undefined || current < targetSoc) return;

    // We've reached or exceeded the target SoC. A coarse curve / increment tick
    // can land WELL past the target in a single step (e.g. 95% when the target
    // is 80%), and we only stop *after* the value was applied — so clamp the
    // meter back to the energy for exactly the target SoC and re-sync before
    // stopping. Otherwise the session ends at the overshot value (#105).
    const targetMeterWh = this.meterWhForSoc(targetSoc);
    if (targetMeterWh !== null && this.host.meterValueWh() > targetMeterWh) {
      this.host.setMeterValueWh(targetMeterWh);
      this.host.emit("meterValueChange", {
        meterValue: targetMeterWh,
      });
      if (this.host.socMeterSyncEnabled()) {
        const derived = this.socFromMeterValue(targetMeterWh);
        if (derived !== null && this.host.socPercent() !== derived) {
          this.host.setSocPercent(derived);
          this.host.emit("socChange", { soc: derived });
        }
      }
    }

    this.host.stopMeterScheduler();
    this.host.setExportTickedAt(null);
    this.host.emit("autoStopRequested", {
      reason: "targetSocReached",
    });
  }

  /**
   * Inverse of {@link socFromMeterValue}: the integer meter Wh corresponding to
   * exactly `soc` percent, using the same capacity / initialSoc / meterStart
   * inputs so the round-trip is consistent. Returns null when capacity is
   * unknown.
   */
  meterWhForSoc(soc: number): number | null {
    const transactionCapacity = this.host.transaction()?.batteryCapacityKwh;
    const capacity =
      transactionCapacity && transactionCapacity > 0
        ? transactionCapacity
        : this.host.evSettings().batteryCapacityKwh;
    if (capacity <= 0) return null;
    const initial = this.host.sessionIntent().initialSoc ?? 0;
    const meterStart = this.host.transaction()?.meterStart ?? 0;
    const deliveredKWh = ((soc - initial) / 100) * capacity;
    if (deliveredKWh <= 0) return meterStart;
    return Math.round(meterStart + deliveredKWh * 1000);
  }

  /**
   * Replace a SoC left over from the previous session with this session's
   * opening value, before the meter scheduler's first interval runs.
   *
   * `stopTransaction` intentionally leaves `socPercent` alone, so a connector
   * that finished at 82% still reads 82% when the next car plugs in. Every
   * other part of the domain already treats
   * `transaction.initialSoc ?? evSettings.initialSoc` as the new session's
   * starting point — `socFromMeterValue` computes exactly that on the first
   * meter tick — so the curve was being evaluated against the wrong battery
   * for precisely one interval, the one that sets the opening power (#301).
   * This does the same reset one tick earlier, and does it whether or not
   * meter/SoC sync is on: with sync off nothing would ever have corrected it.
   *
   * A `"pending"` SoC is kept and claimed for this session: it was set while
   * the connector was idle, so it describes the car plugged in now — typed
   * into the side panel before pressing Start, or handed to
   * `startTransaction` as `initialSoc`, which the ChargePoint writes through
   * the `soc` setter just before this runs. Everything else belongs to a
   * session that has ended and is replaced. That is what closes the leak an
   * explicit `initialSoc` used to have: it arrives `"pending"`, becomes
   * `"session"` here, and the *next* `beginTransaction` therefore treats it as
   * the leftover it has become rather than as a fresh statement about a new
   * car.
   */
  openSessionSoc(transaction: Transaction): void {
    if (this.host.socAwaitsNextTransaction()) {
      this.host.setSocAwaitsNextTransaction(false);
      // Keeping the value is not enough: it also has to become what this
      // session computes from. `socFromMeterValue` derives SoC as
      // `transaction.initialSoc ?? evSettings.initialSoc` plus delivered
      // energy, so with meter/SoC sync on — the default — the very first meter
      // update recomputed from the EV default and overwrote the operator's
      // number. Owning the value and being the baseline are different
      // questions, and answering only the first left the curve and the
      // auto-stop running on a figure nobody entered (#301). Adopting it here
      // makes every derivation agree by construction, and it rides along in
      // the persisted transaction so a restart keeps the same answer.
      // Unconditionally, not only when the transaction named none: a claimed
      // pending value *is* this session's opening SoC, so the two must not be
      // able to disagree. On the real path they never do —
      // `ChargePoint.startTransaction` writes its `initialSoc` through the
      // `soc` setter moments before this runs, so the assignment is a no-op —
      // and where they could, the connector's own value is the later statement
      // and the one the operator can see.
      if (this.host.socPercent() !== null) {
        this.host.patchTransaction({ initialSoc: this.host.socPercent() });
      }
      return;
    }
    const opening = resolveSessionIntent(
      transaction,
      this.host.evSettings(),
    ).initialSoc;
    if (opening === undefined) {
      // No opening value anywhere, and the SoC on hand belongs to a session
      // that has ended — so there is nothing to replace it *with*, and keeping
      // it would open the transaction on the previous session's battery, which
      // is exactly what this method exists to prevent. Every other derivation
      // already treats the absent case as `0`: `socFromMeterValue` computes
      // `transaction.initialSoc ?? evSettings.initialSoc ?? 0`, and
      // `resolveSocForCurve` falls back the same way. Clearing to `null` makes
      // the curve and the auto-stop read that same fallback from the first
      // tick instead of the leftover — with meter/SoC sync on the leftover
      // survived exactly one interval, the one that sets the opening power,
      // and with sync off it survived the whole session (#301).
      //
      // `null`, not `0`: "not reported" is what we know, and every reader
      // already resolves it to `0`. This also makes the `undefined` case agree
      // with a JSON `null` `initialSoc`, which reaches the assignment below
      // and clears the value already.
      //
      // `EVSettings.initialSoc` is typed `number`, so TypeScript believes this
      // is unreachable. Until #333 it was not: `applyDefaultEvSettings`
      // replaced the settings wholesale, so an `ev_settings.apply_default`
      // that omitted `initialSoc` landed here. Both entry points now merge
      // (`applyEvSettingsOverride` onto the current settings,
      // `applyDefaultEvSettings` onto `defaultEVSettings`), so no known write
      // drops it. The branch stays as the guard for settings cast past the
      // type: the `evSettings` setter refuses a `null` required field, not an
      // absent one.
      if (this.host.socPercent() !== null) {
        this.host.setSocPercent(null);
        this.host.emit("socChange", { soc: null });
      }
      return;
    }
    if (this.host.socPercent() === opening) return;
    this.host.setSocPercent(opening);
    this.host.emit("socChange", { soc: opening });
  }
}
