import type { Connector } from "../connector/Connector";
import {
  applySampledValueOverrides,
  type ReadingContext,
  type SampledValue,
  type SampleBuildOptions,
} from "../connector/MeterValueBuilder";
import {
  secondBucket,
  seededUnit,
  type MainMeterConfig,
} from "../connector/MeterRealism";
import type { SimClock } from "../../shared/clock";

/** Measurands a grid-side meter reports. The rest (`Current.Offered`, `SoC`,
 *  ...) belong to a charging session and are not offered for EVSE 0 (2.0.1
 *  J01.FR.14 note). */
export const MAIN_METER_MEASURANDS: readonly string[] = [
  "Energy.Active.Import.Register",
  "Energy.Active.Export.Register",
  "Power.Active.Import",
  "Power.Active.Export",
  "Voltage",
  "Current.Import",
  "Power.Factor",
  "Frequency",
];

/**
 * The station's main meter on connector 0 / EVSE 0 (#617): the grid side of
 * the connectors. OCPP 1.6 §4.7 addresses it as connectorId 0; 2.0.1 J01.FR.03
 * / J01.FR.04 as evseId 0, whose energy samples come from the main energy
 * meter.
 *
 * Its registers are cumulative and aggregate the connectors exactly: each
 * read adds what every connector's registers moved since the previous read
 * (plus the base load over the elapsed time), so the main meter and the
 * connectors cannot disagree about energy. The net flow decides the register:
 * import when the station draws from the grid, export when V2X feeds it.
 * Runtime state only, like the connector registers it follows.
 *
 * The grid sees what the connectors deliver plus their conversion loss
 * (#608): a DC connector with a `dcEfficiency` draws `delivered / efficiency`
 * from the grid, in power (`OperatingPoint.inputW`) and in energy alike. This
 * is the only meter on the AC input side; a connector's own samples describe
 * the vehicle side.
 */
export class MainMeter {
  private importWh = 0;
  private exportWh = 0;
  private lastAt: number;
  private readonly seen = new Map<number, { imp: number; exp: number }>();

  constructor(
    readonly config: MainMeterConfig,
    private readonly connectors: () => ReadonlyMap<number, Connector>,
    private readonly clock: SimClock,
  ) {
    this.lastAt = clock.now();
    for (const [id, c] of connectors()) {
      this.seen.set(id, { imp: c.meterValue, exp: c.exportRegisterWh });
    }
  }

  /** Import register in whole Wh, after folding in what moved. */
  get importRegisterWh(): number {
    this.sync();
    return Math.round(this.importWh);
  }

  /** Export register in whole Wh, after folding in what moved. */
  get exportRegisterWh(): number {
    this.sync();
    return Math.round(this.exportWh);
  }

  private get baseLoadW(): number {
    return this.config.baseLoadW ?? 0;
  }

  private sync(): void {
    const now = this.clock.now();
    let moved = (this.baseLoadW * Math.max(0, now - this.lastAt)) / 3_600_000;
    this.lastAt = now;
    for (const [id, c] of this.connectors()) {
      const was = this.seen.get(id) ?? {
        imp: c.meterValue,
        exp: c.exportRegisterWh,
      };
      const imp = c.meterValue;
      const exp = c.exportRegisterWh;
      // A register set backwards by hand moves nothing.
      // The grid supplies more than the connector delivers by its conversion
      // loss (#608); a V2X export is not converted by this model.
      moved +=
        Math.max(0, imp - was.imp) / c.conversionEfficiency -
        Math.max(0, exp - was.exp);
      this.seen.set(id, { imp, exp });
    }
    const net = moved;
    if (net >= 0) this.importWh += net;
    else this.exportWh -= net;
  }

  /** Net power drawn from the grid in watts: positive imports. */
  private netPowerW(): number {
    let net = this.baseLoadW;
    for (const c of this.connectors().values()) {
      const point = c.operatingPoint();
      net += point.inputW - point.exportW;
    }
    return net;
  }

  /** The samples of one MeterValues for connector 0 / EVSE 0. */
  sampledValues(
    measurands: readonly string[],
    context: ReadingContext,
    options: SampleBuildOptions = {},
  ): SampledValue[] {
    this.sync();
    const net = this.netPowerW();
    const phases = this.config.phases ?? 3;
    const nominal = this.config.voltageV ?? 230;
    const swing = this.config.voltagePct
      ? 1 +
        (this.config.voltagePct / 100) *
          seededUnit(this.config.seed ?? 0, secondBucket(this.clock.now()), 1)
      : 1;
    const voltage = Math.round(nominal * swing * 10) / 10;
    const base = { context, location: "Inlet" } as const;
    const out: SampledValue[] = [];
    for (const measurand of measurands) {
      switch (measurand) {
        case "Energy.Active.Import.Register":
          out.push({
            ...base,
            measurand,
            value: String(Math.round(this.importWh)),
            unit: "Wh",
          });
          break;
        case "Energy.Active.Export.Register":
          out.push({
            ...base,
            measurand,
            value: String(Math.round(this.exportWh)),
            unit: "Wh",
          });
          break;
        case "Power.Active.Import":
          out.push({
            ...base,
            measurand,
            value: String(Math.round(Math.max(0, net))),
            unit: "W",
          });
          break;
        case "Power.Active.Export":
          out.push({
            ...base,
            measurand,
            value: String(Math.round(Math.max(0, -net))),
            unit: "W",
          });
          break;
        case "Voltage":
          out.push({ ...base, measurand, value: String(voltage), unit: "V" });
          break;
        case "Current.Import":
          out.push({
            ...base,
            measurand,
            value: (Math.max(0, net) / (voltage * phases)).toFixed(1),
            unit: "A",
          });
          break;
        case "Power.Factor":
          out.push({ ...base, measurand, value: "1.0" });
          break;
        case "Frequency":
          // Errata 3.86: no UnitOfMeasure for Hz in 1.6.
          out.push({ ...base, measurand, value: "50" });
          break;
        default:
          break;
      }
    }
    const rules = this.config.sampledValues;
    return rules && rules.length > 0
      ? applySampledValueOverrides(out, rules, options)
      : out;
  }
}
