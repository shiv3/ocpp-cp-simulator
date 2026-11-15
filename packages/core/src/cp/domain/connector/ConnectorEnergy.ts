import type { EventEmitter } from "../../shared/EventEmitter";
import type { Transaction } from "./Transaction";
import type { EVSettings } from "./EVSettings";
import type { MeterRealism } from "./MeterRealism";
import type { OperatingPoint } from "./OperatingPoint";
import type { SessionIntent } from "./SessionIntent";
import type { ConnectorEvents } from "./Connector";

/** What the energy and SoC bookkeeping needs from the connector that owns it. */
export interface ConnectorEnergyHost {
  now(): number;
  meterValueWh(): number;
  setMeterValueWh(value: number): void;
  socPercent(): number | null;
  setSocPercent(value: number | null): void;
  setSocAwaitsNextTransaction(value: boolean): void;
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
}
