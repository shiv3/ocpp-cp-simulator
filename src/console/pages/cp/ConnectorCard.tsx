import React, { useEffect, useId, useState } from "react";
import { ChevronDown, ChevronUp, Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import { defaultAutoMeterValueConfig } from "@/cp/domain/connector/MeterValueCurve";
import { useConnectorView } from "@/data/hooks/useConnectorView";
import { useGlobalTagIds } from "@/data/hooks/useGlobalTagIds";
import { useDataContext } from "@/data/providers/DataProvider";
import { cn } from "@/lib/utils";

import StatusPill from "../../components/StatusPill";
import Switch from "../../components/Switch";
import ChargingProfilesList from "./ChargingProfilesList";
import ConnectorConfigDialog, { type ConfigTab } from "./ConnectorConfigDialog";
import ConnectorControls from "./ConnectorControls";
import {
  describeError,
  plugIn,
  setSocWithSync,
  unplug,
} from "./connectorActions";
import { batteryTone, evDisplayName } from "./connectorCardModel";
import EvBattery from "./EvBattery";
import PowerSparkline from "./PowerSparkline";
import { curvePointsToPower, describePowerCurve } from "./powerCurve";
import SessionFlow from "./SessionFlow";
import { useConnectorPower } from "./useConnectorPower";

export interface ConnectorCardProps {
  cpId: string;
  connectorId: number;
  /** On the full page, where every connector shows: whether this card is the
   *  selected connector (`?connector=`), marked with an accent ring. */
  selected?: boolean;
  /** Clicking the header (not its controls) selects the connector. */
  onSelect?: () => void;
}

/** "12 m 40 s" under an hour, "2 h 41 m" above. */
function formatSession(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h} h ${m} m` : `${m} m ${String(s).padStart(2, "0")} s`;
}

const formatKw = (kw: number) => String(Number(kw.toFixed(1)));

/** One figure of the card: a small uppercase label over a 16px value, the
 *  mock's `.kv`, with an optional 3px bar. */
const Figure: React.FC<{
  label: string;
  value: React.ReactNode;
  note?: React.ReactNode;
  bar?: { pct: number; className: string };
}> = ({ label, value, note, bar }) => (
  <div>
    <dt className="mb-[3px] text-[11px] uppercase tracking-[0.06em] text-cx-faint">
      {label}
    </dt>
    <dd className="text-base font-medium tracking-[-0.01em] tabular-nums text-cx-fg">
      {value}
      {note && (
        <small className="ml-1 whitespace-nowrap text-xs font-normal text-cx-muted @max-[560px]:ml-0 @max-[560px]:block">
          {note}
        </small>
      )}
      {bar && (
        <div className="mt-1.5 h-[3px] overflow-hidden rounded-sm bg-cx-sub">
          <div
            className={cn("h-full rounded-sm", bar.className)}
            style={{ width: `${Math.min(100, Math.max(0, bar.pct))}%` }}
          />
        </div>
      )}
    </dd>
  </div>
);

const BAR_CLASS = {
  charging: "bg-cx-accent",
  idle: "bg-cx-fg2",
  full: "bg-cx-emerald",
  faulted: "bg-cx-rose",
} as const;

/**
 * A connector as a charging session: the header (status, availability,
 * Config, Controls), the session stepper, the EV as a battery with the
 * session figures, the power line with the auto meter row, the simulator
 * controls (folded), and the charging profiles.
 */
const ConnectorCard: React.FC<ConnectorCardProps> = ({
  cpId,
  connectorId,
  selected,
  onSelect,
}) => {
  const { chargePointService } = useDataContext();
  const { tagIds } = useGlobalTagIds();
  const view = useConnectorView(cpId, connectorId);
  const power = useConnectorPower(cpId, connectorId);
  const controlsId = useId();
  const [controlsOpen, setControlsOpen] = useState(false);
  const [configTab, setConfigTab] = useState<ConfigTab | null>(null);
  const [pending, setPending] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);
  const [autoError, setAutoError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const hasTx = view.transactionId != null;
  // The session clock ticks only while a transaction runs.
  useEffect(() => {
    if (!hasTx) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasTx]);

  const ev = view.evSettings;
  const capacity = ev.batteryCapacityKwh;
  const maxKw = ev.maxChargingPowerKw;
  const powerKw = hasTx ? power.powerKw : 0;
  const tone = batteryTone(view.status, view.soc, ev.targetSoc);
  const addedKwh =
    hasTx && power.startWh != null
      ? Math.max(0, view.meterValue - power.startWh) / 1000
      : 0;
  const startedAt =
    view.transactionStartTime?.getTime() ?? power.samples[0]?.t ?? null;
  const autoConfig = view.autoMeterValueConfig;
  const autoPoints = curvePointsToPower(
    (autoConfig ?? defaultAutoMeterValueConfig).curvePoints,
  );

  const step = async (label: string, action: () => Promise<void>) => {
    setPending(true);
    setStepError(null);
    try {
      await action();
    } catch (err) {
      console.error(`${label} failed on ${cpId}/${connectorId}`, err);
      setStepError(`${label} failed: ${describeError(err)}`);
    } finally {
      setPending(false);
    }
  };

  // Toggling with no live configuration starts from the one saved for the
  // connector, else the default, as the dialog does.
  const toggleAuto = async (enabled: boolean) => {
    setAutoError(null);
    try {
      const base =
        autoConfig ??
        (await chargePointService.getAutoMeterConfig(cpId, connectorId)) ??
        defaultAutoMeterValueConfig;
      await chargePointService.setAutoMeterValueConfig(cpId, connectorId, {
        ...base,
        enabled,
      });
    } catch (err) {
      console.error(
        `Failed to switch auto meter values on ${cpId}/${connectorId}`,
        err,
      );
      setAutoError(`Auto meter values not switched: ${describeError(err)}`);
    }
  };

  const onHeaderClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onSelect) return;
    // The header's own controls act; the rest of it selects the card.
    if ((event.target as Element).closest("button, a, input, select, label")) {
      return;
    }
    onSelect();
  };

  return (
    <section
      data-connector-id={connectorId}
      data-selected={selected === undefined ? undefined : String(selected)}
      aria-label={`Connector ${connectorId}`}
      className={cn(
        "@container rounded-[10px] border border-cx-border bg-cx-card px-[18px] py-4 shadow-[0_1px_2px_rgba(20,20,30,0.05)] dark:shadow-none",
        selected && "border-cx-accent ring-1 ring-cx-accent",
      )}
    >
      <div
        data-card-header
        onClick={onHeaderClick}
        title={onSelect && !selected ? "Select this connector" : undefined}
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-2",
          onSelect && "cursor-pointer",
        )}
      >
        <b className="text-[15px] font-semibold text-cx-fg">
          Connector {connectorId}
        </b>
        <StatusPill status={view.status} />
        <span
          className="text-[12.5px] text-cx-muted"
          title="Set by the CSMS with ChangeAvailability"
          data-testid="availability"
        >
          {view.availability}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setConfigTab("ev")}
          >
            <Settings className="h-3.5 w-3.5" />
            Config
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={controlsOpen}
            aria-controls={controlsId}
            onClick={() => setControlsOpen((open) => !open)}
            className={cn(controlsOpen && "bg-cx-sub text-cx-fg")}
          >
            Controls
            {controlsOpen ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </Button>
        </span>
      </div>

      <SessionFlow
        status={view.status}
        transactionId={view.transactionId}
        transactionTagId={view.transactionTagId}
        tagIds={tagIds}
        pending={pending}
        onPlugIn={() =>
          void step("Plug in", () =>
            plugIn(chargePointService, cpId, connectorId),
          )
        }
        onStart={(tagId) =>
          void step("Start charging", () =>
            chargePointService.startTransaction(cpId, connectorId, tagId),
          )
        }
        onStop={() =>
          void step("Stop charging", () =>
            chargePointService.stopTransaction(cpId, connectorId),
          )
        }
        onUnplug={() =>
          void step("Unplug", () =>
            unplug(chargePointService, cpId, connectorId),
          )
        }
      />
      {stepError && (
        <p role="alert" className="mt-1.5 text-xs text-cx-rose">
          {stepError}
        </p>
      )}

      <div className="mt-3.5 grid grid-cols-1 items-start gap-y-4 @min-[400px]:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] @min-[400px]:gap-x-4 @min-[560px]:grid-cols-[minmax(240px,1.1fr)_minmax(220px,1fr)] @min-[560px]:gap-x-6">
        <EvBattery
          soc={view.soc}
          targetSoc={ev.targetSoc}
          capacityKwh={capacity}
          powerKw={powerKw}
          evName={evDisplayName(ev)}
          tone={tone}
          onSocCommit={(soc) =>
            void step("Set SoC", () =>
              setSocWithSync(chargePointService, cpId, connectorId, soc, ev),
            )
          }
        />
        <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-3">
          <Figure
            label="Energy added"
            value={`${addedKwh.toFixed(2)} kWh`}
            note={`of ${capacity} kWh`}
            bar={{
              pct: capacity > 0 ? (addedKwh / capacity) * 100 : 0,
              className: BAR_CLASS[tone],
            }}
          />
          <Figure
            label="Power"
            value={`${powerKw.toFixed(1)} kW`}
            note={`max ${formatKw(maxKw)}`}
            bar={{
              pct: maxKw > 0 ? (powerKw / maxKw) * 100 : 0,
              className: BAR_CLASS[tone],
            }}
          />
          <Figure
            label="Session"
            value={
              hasTx && startedAt != null ? formatSession(now - startedAt) : "—"
            }
            note={
              hasTx ? (
                <span className="font-mono">Tx #{view.transactionId}</span>
              ) : undefined
            }
          />
          <Figure
            label="Meter"
            value={`${(view.meterValue / 1000).toFixed(2)} kWh`}
            note="register"
          />
        </dl>
        <PowerSparkline
          samples={hasTx ? power.samples : []}
          startedAt={startedAt}
          now={now}
          maxKw={maxKw}
          powerKw={powerKw}
          ghost={autoPoints}
        />
        <div className="col-span-full flex flex-wrap items-center gap-x-3 gap-y-2 text-[12.5px] text-cx-muted">
          <Switch
            label="Auto meter values"
            checked={autoConfig?.enabled ?? false}
            onChange={(enabled) => void toggleAuto(enabled)}
          >
            Auto meter values
          </Switch>
          <span>
            every {(autoConfig ?? defaultAutoMeterValueConfig).intervalSeconds}{" "}
            s ·{" "}
            {describePowerCurve(
              autoPoints,
              autoConfig?.stopAtTargetSoc ?? false,
            )}
          </span>
          <button
            type="button"
            onClick={() => setConfigTab("auto")}
            className="ml-auto text-[12.5px] text-cx-accent hover:underline"
          >
            Edit curve…
          </button>
          {autoError && (
            <p role="alert" className="basis-full text-xs text-cx-rose">
              {autoError}
            </p>
          )}
        </div>
      </div>

      <ConnectorControls
        id={controlsId}
        hidden={!controlsOpen}
        cpId={cpId}
        connectorId={connectorId}
        status={view.status}
        availability={view.availability}
        meterValue={view.meterValue}
        soc={view.soc}
        evSettings={ev}
      />

      <div
        data-testid="card-footer"
        className="mt-3.5 flex flex-col gap-2 border-t border-cx-border pt-3"
      >
        {hasTx && view.transactionTagId && (
          <span className="font-mono text-xs text-cx-muted">
            Tag {view.transactionTagId}
          </span>
        )}
        <ChargingProfilesList
          profiles={view.chargingProfiles}
          current={view.chargingProfile}
        />
      </div>

      <ConnectorConfigDialog
        cpId={cpId}
        connectorId={connectorId}
        open={configTab !== null}
        onOpenChange={(open) => {
          if (!open) setConfigTab(null);
        }}
        initialTab={configTab ?? "ev"}
        status={view.status}
        evSettings={ev}
        liveAutoMeter={autoConfig}
      />
    </section>
  );
};

export default ConnectorCard;
