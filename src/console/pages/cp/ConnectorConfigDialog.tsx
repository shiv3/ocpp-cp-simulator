import React, { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { EV_PRESETS, type EVSettings } from "@/cp/domain/connector/EVSettings";
import {
  defaultAutoMeterValueConfig,
  type AutoMeterValueConfig,
} from "@/cp/domain/connector/MeterValueCurve";
import type { OCPPStatus } from "@/cp/domain/types/OcppTypes";
import { useSocMeterSync } from "@/data/hooks/useSocMeterSync";
import { useDataContext } from "@/data/providers/DataProvider";
import { cn } from "@/lib/utils";

import {
  FILTER_INPUT_CLASS,
  FILTER_SELECT_CLASS,
} from "../../components/filterStyles";
import StatusPill from "../../components/StatusPill";
import Switch from "../../components/Switch";
import { describeError } from "./connectorActions";
import CurveEditor from "./CurveEditor";
import {
  curvePointsToPower,
  powerCurvePresets,
  powerToCurvePoints,
  type PowerPoint,
} from "./powerCurve";

export type ConfigTab = "ev" | "auto";

export interface ConnectorConfigDialogProps {
  cpId: string;
  connectorId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The section the dialog opens on (Config → EV, Edit curve… → Auto meter). */
  initialTab: ConfigTab;
  status: OCPPStatus;
  evSettings: EVSettings;
  /** The connector's live auto meter configuration, when it reports one. */
  liveAutoMeter: AutoMeterValueConfig | null;
}

type BodyProps = Omit<ConnectorConfigDialogProps, "open">;

const TABS: ReadonlyArray<{ id: ConfigTab; label: string }> = [
  { id: "ev", label: "EV" },
  { id: "auto", label: "Auto meter" },
];

const CUSTOM = "Custom";

type AutoLoad =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; base: AutoMeterValueConfig };

const parse = (text: string): number | null => {
  const value = Number(text);
  return text.trim() !== "" && Number.isFinite(value) ? value : null;
};

/** A labelled field in the form grid: small uppercase label over the input,
 *  the unit beside it. */
const Field: React.FC<{
  label: string;
  unit?: string;
  wide?: boolean;
  children: React.ReactNode;
}> = ({ label, unit, wide, children }) => (
  <label
    className={cn(
      "flex flex-col gap-1 text-[11px] uppercase tracking-[0.06em] text-cx-faint",
      wide && "col-span-full",
    )}
  >
    {label}
    <span className="flex items-center gap-1.5 normal-case tracking-normal">
      {children}
      {unit && <span className="text-xs text-cx-muted">{unit}</span>}
    </span>
  </label>
);

const NUMBER_CLASS = cn(FILTER_INPUT_CLASS, "min-w-0 flex-1 font-mono");

/** Mounted only while the dialog is open: every opening starts from the
 *  connector's current settings and reads the sync preference afresh. */
const ConfigBody: React.FC<BodyProps> = ({
  cpId,
  connectorId,
  onOpenChange,
  initialTab,
  evSettings,
  liveAutoMeter,
}) => {
  const { chargePointService } = useDataContext();
  const tabsId = useId();
  const tabRefs = useRef(new Map<ConfigTab, HTMLButtonElement>());
  const [tab, setTab] = useState<ConfigTab>(initialTab);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // EV, as typed; parsed and checked on Save.
  const [modelName, setModelName] = useState(evSettings.modelName);
  const [battery, setBattery] = useState(String(evSettings.batteryCapacityKwh));
  const [maxKw, setMaxKw] = useState(String(evSettings.maxChargingPowerKw));
  const [initialSoc, setInitialSoc] = useState(String(evSettings.initialSoc));
  const [targetSoc, setTargetSoc] = useState(String(evSettings.targetSoc));
  const [evDirty, setEvDirty] = useState(false);
  const editEv = (set: (v: string) => void) => (value: string) => {
    set(value);
    setEvDirty(true);
  };

  const draftEv: EVSettings = {
    ...evSettings,
    modelName,
    batteryCapacityKwh: parse(battery) ?? evSettings.batteryCapacityKwh,
    maxChargingPowerKw: parse(maxKw) ?? evSettings.maxChargingPowerKw,
    initialSoc: parse(initialSoc) ?? evSettings.initialSoc,
    targetSoc: parse(targetSoc) ?? evSettings.targetSoc,
  };
  const capKw = draftEv.maxChargingPowerKw > 0 ? draftEv.maxChargingPowerKw : 1;

  // The sync preference, read as the former Meter & SoC dialog did; a toggle
  // is staged until Save like the rest of the dialog.
  const sync = useSocMeterSync({
    chargePointService,
    cpId,
    connectorId,
    evSettings: draftEv,
  });
  const canSync = draftEv.batteryCapacityKwh > 0;
  const syncLive = sync.isKnown && sync.autoSyncSocMeter && canSync;
  const [syncDraft, setSyncDraft] = useState<boolean | null>(null);
  const syncShown = syncDraft ?? syncLive;

  // Auto meter: the live configuration, else the saved one, else the default.
  const [load, setLoad] = useState<AutoLoad>(() =>
    liveAutoMeter
      ? { state: "ready", base: liveAutoMeter }
      : { state: "loading" },
  );
  useEffect(() => {
    if (liveAutoMeter) return undefined;
    let cancelled = false;
    chargePointService
      .getAutoMeterConfig(cpId, connectorId)
      .then((saved) => {
        if (!cancelled) {
          setLoad({
            state: "ready",
            base: saved ?? defaultAutoMeterValueConfig,
          });
        }
      })
      .catch((err) => {
        // Not "nothing saved": starting on the default could overwrite a
        // configuration that only failed to load.
        console.error(
          `Failed to read the auto meter values saved for ${cpId}/${connectorId}`,
          err,
        );
        if (!cancelled) {
          setLoad({
            state: "error",
            message: `Saved auto meter values not read: ${describeError(err)}`,
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // The live config is read once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chargePointService, cpId, connectorId]);

  const base = load.state === "ready" ? load.base : null;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [intervalText, setIntervalText] = useState<string | null>(null);
  const [stopAtTarget, setStopAtTarget] = useState<boolean | null>(null);
  const [points, setPoints] = useState<PowerPoint[] | null>(null);
  const basePoints = (() => {
    if (!base) return [];
    const read = curvePointsToPower(base.curvePoints);
    return read.length >= 2 ? read : powerCurvePresets(capKw)[0].points;
  })();
  const shownPoints = points ?? basePoints;
  const shownEnabled = enabled ?? base?.enabled ?? false;
  const shownInterval = intervalText ?? String(base?.intervalSeconds ?? 10);
  const shownStop = stopAtTarget ?? base?.stopAtTargetSoc ?? false;
  const autoDirty =
    enabled !== null ||
    intervalText !== null ||
    stopAtTarget !== null ||
    points !== null;

  const selectTab = (next: ConfigTab) => {
    setTab(next);
    tabRefs.current.get(next)?.focus();
  };
  const onRailKey = (event: React.KeyboardEvent) => {
    const index = TABS.findIndex((t) => t.id === tab);
    const step =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    selectTab(TABS[(index + step + TABS.length) % TABS.length].id);
  };

  const handleSave = async () => {
    setError(null);
    let ev: EVSettings | null = null;
    if (evDirty) {
      const values = {
        battery: parse(battery),
        maxKw: parse(maxKw),
        initialSoc: parse(initialSoc),
        targetSoc: parse(targetSoc),
      };
      const problem =
        values.battery == null || values.battery <= 0
          ? "Battery must be above 0 kWh."
          : values.maxKw == null || values.maxKw <= 0
            ? "Max power must be above 0 kW."
            : values.initialSoc == null ||
                values.initialSoc < 0 ||
                values.initialSoc > 100
              ? "Initial SoC must be between 0 and 100 %."
              : values.targetSoc == null ||
                  values.targetSoc < 0 ||
                  values.targetSoc > 100
                ? "Target SoC must be between 0 and 100 %."
                : null;
      if (problem) {
        setTab("ev");
        setError(problem);
        return;
      }
      ev = draftEv;
    }
    let auto: AutoMeterValueConfig | null = null;
    if (autoDirty && base) {
      const interval = parse(shownInterval);
      if (interval == null || interval < 1 || !Number.isInteger(interval)) {
        setTab("auto");
        setError("The interval must be a whole number of seconds, 1 or more.");
        return;
      }
      auto = {
        ...base,
        enabled: shownEnabled,
        intervalSeconds: interval,
        stopAtTargetSoc: shownStop,
        // An untouched curve is kept as it was: reading it into power points
        // and back is an approximation.
        curvePoints: points ? powerToCurvePoints(points) : base.curvePoints,
      };
    }

    setSaving(true);
    try {
      if (ev) {
        try {
          await chargePointService.setEVSettings(cpId, connectorId, ev);
        } catch (err) {
          console.error(
            `Failed to set EV settings on ${cpId}/${connectorId}`,
            err,
          );
          setError(`EV settings not applied: ${describeError(err)}`);
          return;
        }
        setEvDirty(false);
      }
      if (syncDraft !== null && syncDraft !== syncLive) {
        sync.setAutoSyncSocMeter(syncDraft);
      }
      if (auto) {
        // Two steps, reported apart: a curve can be live on the connector and
        // yet not stored.
        try {
          await chargePointService.setAutoMeterValueConfig(
            cpId,
            connectorId,
            auto,
          );
        } catch (err) {
          console.error(
            `Failed to apply auto meter values on ${cpId}/${connectorId}`,
            err,
          );
          setError(`Auto meter values not applied: ${describeError(err)}`);
          return;
        }
        try {
          await chargePointService.saveAutoMeterConfig(cpId, connectorId, auto);
        } catch (err) {
          console.error(
            `Failed to save auto meter values for ${cpId}/${connectorId}`,
            err,
          );
          setError(
            `Auto meter values applied, but not saved: ${describeError(err)}`,
          );
          return;
        }
      }
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  const vehicle = Object.keys(EV_PRESETS).includes(modelName)
    ? modelName
    : CUSTOM;

  return (
    <>
      <div className="grid min-h-[380px] flex-1 grid-cols-1 overflow-auto sm:grid-cols-[170px_minmax(0,1fr)]">
        <div
          role="tablist"
          aria-label="Config sections"
          aria-orientation="vertical"
          onKeyDown={onRailKey}
          className="flex gap-0.5 overflow-x-auto border-b border-cx-border bg-cx-sub px-2 py-2.5 sm:flex-col sm:border-b-0 sm:border-r"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                if (el) tabRefs.current.set(t.id, el);
                else tabRefs.current.delete(t.id);
              }}
              type="button"
              role="tab"
              id={`${tabsId}-${t.id}-tab`}
              aria-selected={tab === t.id}
              aria-controls={`${tabsId}-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              className={cn(
                "whitespace-nowrap rounded-[7px] px-2.5 py-[7px] text-left text-[13px] font-medium text-cx-muted hover:text-cx-fg",
                tab === t.id &&
                  "bg-cx-card text-cx-fg shadow-[0_0_0_1px_var(--cx-border-strong)]",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "ev" && (
          <section
            role="tabpanel"
            id={`${tabsId}-ev`}
            aria-labelledby={`${tabsId}-ev-tab`}
            className="flex flex-col gap-3.5 px-[18px] pb-[18px] pt-4"
          >
            <div>
              <h3 className="text-[15px] font-semibold text-cx-fg">EV</h3>
              <p className="mt-0.5 text-[12.5px] text-cx-muted">
                The vehicle on this connector: its battery sets what the SoC
                means, its max power caps the curve.
              </p>
            </div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-3.5 gap-y-2.5">
              <Field label="Vehicle" wide>
                <select
                  aria-label="Vehicle"
                  value={vehicle}
                  onChange={(e) => {
                    const preset = e.target.value;
                    setEvDirty(true);
                    if (preset === CUSTOM) {
                      setModelName(CUSTOM);
                      return;
                    }
                    const values = EV_PRESETS[preset] ?? {};
                    setModelName(preset);
                    if (values.batteryCapacityKwh != null) {
                      setBattery(String(values.batteryCapacityKwh));
                    }
                    if (values.maxChargingPowerKw != null) {
                      setMaxKw(String(values.maxChargingPowerKw));
                    }
                  }}
                  className={cn(FILTER_SELECT_CLASS, "w-full")}
                >
                  {Object.entries(EV_PRESETS).map(([name, values]) => (
                    <option key={name} value={name}>
                      {name === CUSTOM
                        ? CUSTOM
                        : `${name} · ${values.batteryCapacityKwh} kWh · ${values.maxChargingPowerKw} kW`}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Battery" unit="kWh">
                <input
                  type="number"
                  min={1}
                  aria-label="Battery (kWh)"
                  value={battery}
                  onChange={(e) => editEv(setBattery)(e.target.value)}
                  className={NUMBER_CLASS}
                />
              </Field>
              <Field label="Max power" unit="kW">
                <input
                  type="number"
                  min={1}
                  aria-label="Max power (kW)"
                  value={maxKw}
                  onChange={(e) => editEv(setMaxKw)(e.target.value)}
                  className={NUMBER_CLASS}
                />
              </Field>
              <Field label="Initial SoC" unit="%">
                <input
                  type="number"
                  min={0}
                  max={100}
                  aria-label="Initial SoC (%)"
                  value={initialSoc}
                  onChange={(e) => editEv(setInitialSoc)(e.target.value)}
                  className={NUMBER_CLASS}
                />
              </Field>
              <Field label="Target SoC" unit="%">
                <input
                  type="number"
                  min={0}
                  max={100}
                  aria-label="Target SoC (%)"
                  value={targetSoc}
                  onChange={(e) => editEv(setTargetSoc)(e.target.value)}
                  className={NUMBER_CLASS}
                />
              </Field>
            </div>
            <Switch
              label="Sync SoC and meter"
              checked={syncShown}
              disabled={!canSync || (!sync.isKnown && sync.error === null)}
              onChange={setSyncDraft}
              title={
                canSync
                  ? "Derive the SoC from the meter (and back) with the battery capacity and initial SoC"
                  : "Needs a battery capacity above 0 kWh"
              }
              className="text-[13px]"
            >
              Sync SoC and meter through the battery capacity
            </Switch>
            {sync.error && (
              <p role="alert" className="text-xs text-cx-rose">
                {sync.error}
              </p>
            )}
          </section>
        )}

        {tab === "auto" && (
          <section
            role="tabpanel"
            id={`${tabsId}-auto`}
            aria-labelledby={`${tabsId}-auto-tab`}
            className="flex min-w-0 flex-col gap-3.5 px-[18px] pb-[18px] pt-4"
          >
            <div>
              <h3 className="text-[15px] font-semibold text-cx-fg">
                Auto meter values
              </h3>
              <p className="mt-0.5 text-[12.5px] text-cx-muted">
                MeterValues the connector sends on its own while a transaction
                runs. Drag the points to shape the power over the session.
              </p>
            </div>
            {load.state === "loading" && (
              <p className="text-[12.5px] text-cx-muted">
                Reading the saved auto meter values…
              </p>
            )}
            {load.state === "error" && (
              <p role="alert" className="text-xs text-cx-rose">
                {load.message}
              </p>
            )}
            {base && (
              <>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12.5px] text-cx-muted">
                  <Switch
                    label="Enabled"
                    checked={shownEnabled}
                    onChange={setEnabled}
                  >
                    Enabled
                  </Switch>
                  <span className="inline-flex items-center gap-1.5">
                    every
                    <input
                      type="number"
                      min={1}
                      aria-label="Interval (s)"
                      value={shownInterval}
                      onChange={(e) => setIntervalText(e.target.value)}
                      className={cn(FILTER_INPUT_CLASS, "w-16 py-1 font-mono")}
                    />
                    s
                  </span>
                  <Switch
                    label="Stop at target SoC"
                    checked={shownStop}
                    onChange={setStopAtTarget}
                    title="End the transaction once the SoC reaches the EV's target"
                  >
                    Stop at target SoC
                  </Switch>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-xs text-cx-muted">Presets</span>
                  {powerCurvePresets(capKw).map((preset) => (
                    <Button
                      key={preset.id}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setPoints(preset.points)}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
                <CurveEditor
                  points={shownPoints}
                  onChange={setPoints}
                  capKw={capKw}
                  intervalSeconds={parse(shownInterval) ?? 0}
                  capacityKwh={draftEv.batteryCapacityKwh}
                />
              </>
            )}
          </section>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-cx-border px-4 py-3">
        {error && (
          <p role="alert" className="mr-auto text-xs text-cx-rose">
            {error}
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button
          type="button"
          disabled={saving}
          onClick={() => void handleSave()}
        >
          Save
        </Button>
      </div>
    </>
  );
};

/**
 * The connector's settings in one dialog with a tab rail: **EV** (vehicle
 * preset, battery, max power, initial and target SoC, SoC ↔ meter sync) and
 * **Auto meter** (on / off, interval, stop at target SoC, presets and the curve
 * editor). Save applies what changed: `setEVSettings`, the sync preference,
 * then `setAutoMeterValueConfig` and `saveAutoMeterConfig`.
 */
const ConnectorConfigDialog: React.FC<ConnectorConfigDialogProps> = ({
  open,
  ...body
}) => (
  <Dialog open={open} onOpenChange={body.onOpenChange}>
    <DialogContent className="flex max-h-[calc(100vh-32px)] w-[min(880px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden border-cx-border-strong bg-cx-card p-0 text-cx-fg sm:rounded-xl">
      <div className="flex items-center gap-2.5 border-b border-cx-border py-3 pl-4 pr-12">
        <DialogTitle className="text-[15px] font-semibold tracking-normal">
          Connector {body.connectorId} · Config
        </DialogTitle>
        <StatusPill status={body.status} />
        <DialogDescription className="sr-only">
          The EV on this connector and its auto meter values.
        </DialogDescription>
      </div>
      {open && <ConfigBody {...body} />}
    </DialogContent>
  </Dialog>
);

export default ConnectorConfigDialog;
