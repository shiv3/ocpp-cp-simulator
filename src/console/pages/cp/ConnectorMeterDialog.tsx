import React, { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { EVSettings } from "@/cp/domain/connector/EVSettings";
import { useSocMeterSync } from "@/data/hooks/useSocMeterSync";
import { useDataContext } from "@/data/providers/DataProvider";
import { formatEnergyKwh, formatSoc } from "@/lib/connectorFormat";

export interface ConnectorMeterDialogProps {
  cpId: string;
  connectorId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Live readings, in Wh and %. */
  meterValue: number;
  soc: number | null;
  evSettings: EVSettings;
}

type BodyProps = Omit<ConnectorMeterDialogProps, "open" | "onOpenChange">;

function toWh(text: string): number | null {
  const value = Number(text);
  return text.trim() !== "" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function toSoc(text: string): number | null {
  const value = Number(text);
  return text.trim() !== "" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : null;
}

/**
 * Mounted only while the dialog is open, so the SoC ↔ meter sync preference
 * is read and pushed to the connector when the operator opens it, as the
 * classic side panel did when it mounted.
 */
const MeterDialogBody: React.FC<BodyProps> = ({
  cpId,
  connectorId,
  meterValue,
  soc,
  evSettings,
}) => {
  const { chargePointService } = useDataContext();
  const {
    autoSyncSocMeter,
    isKnown: isSyncKnown,
    error: syncError,
    setAutoSyncSocMeter,
    meterFromSoc,
  } = useSocMeterSync({ chargePointService, cpId, connectorId, evSettings });
  const [meterText, setMeterText] = useState(String(Math.round(meterValue)));
  const [socText, setSocText] = useState(soc == null ? "" : String(soc));
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const canSync = evSettings.batteryCapacityKwh > 0;
  // An unread preference is not "on": Set SoC would overwrite the meter.
  const syncOn = isSyncKnown && autoSyncSocMeter && canSync;
  const isSyncLoading = !isSyncKnown && syncError === null;
  const meterWh = toWh(meterText);
  const socPercent = toSoc(socText);

  const run = async (action: () => Promise<void>) => {
    setIsPending(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      console.error(`Meter action failed on ${cpId}/${connectorId}`, err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsPending(false);
    }
  };

  // With sync on, the connector derives the SoC from a new meter value
  // itself (`Connector.meterValue`); the other way round is done here.
  const setMeter = (send: boolean) =>
    run(async () => {
      if (meterWh === null) return;
      await chargePointService.setMeterValue(cpId, connectorId, meterWh);
      if (send) await chargePointService.sendMeterValue(cpId, connectorId);
    });

  const setSoc = (next: number | null) =>
    run(async () => {
      await chargePointService.setConnectorSoc(cpId, connectorId, next);
      if (next !== null && syncOn) {
        const derived = meterFromSoc(next);
        setMeterText(String(derived));
        await chargePointService.setMeterValue(cpId, connectorId, derived);
      }
      if (next === null) setSocText("");
    });

  return (
    <div className="space-y-4 text-sm">
      <div className="text-xs text-cx-fg2">
        Now: {formatEnergyKwh(meterValue)} ·{" "}
        {soc != null ? formatSoc(soc) : "SoC not reported"}
      </div>

      <section className="space-y-2">
        <label className="block text-xs font-medium text-cx-fg2">
          Meter (energy register, Wh)
          <Input
            type="number"
            min={0}
            aria-label="Meter value (Wh)"
            value={meterText}
            onChange={(e) => setMeterText(e.target.value)}
            className="mt-1 font-mono"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isPending || meterWh === null}
            onClick={() => void setMeter(false)}
          >
            Set
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={isPending || meterWh === null}
            onClick={() => void setMeter(true)}
          >
            Set and send
          </Button>
        </div>
      </section>

      <section className="space-y-2">
        <label className="block text-xs font-medium text-cx-fg2">
          State of charge (%)
          <Input
            type="number"
            min={0}
            max={100}
            aria-label="SoC (%)"
            value={socText}
            placeholder="not reported"
            onChange={(e) => setSocText(e.target.value)}
            className="mt-1 font-mono"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isPending || socPercent === null}
            onClick={() => void setSoc(socPercent)}
          >
            Set SoC
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isPending}
            onClick={() => void setSoc(null)}
            title="The next MeterValues carries no SoC sample"
          >
            Clear SoC
          </Button>
        </div>
        <label
          className="flex items-center gap-2 text-xs text-cx-fg2"
          title={
            canSync
              ? "Derive the SoC from the meter (and back) with the EV's battery capacity"
              : "Needs an EV battery capacity above 0 kWh"
          }
        >
          <input
            type="checkbox"
            aria-label="Sync SoC and meter"
            checked={syncOn}
            disabled={!canSync || isSyncLoading}
            onChange={(e) => setAutoSyncSocMeter(e.target.checked)}
          />
          Sync SoC and meter
          <span className="text-cx-muted">
            ({evSettings.batteryCapacityKwh} kWh, from {evSettings.initialSoc}{" "}
            %)
          </span>
        </label>
        {syncError && (
          <p role="alert" className="text-xs text-cx-rose">
            {syncError}
          </p>
        )}
      </section>

      <div className="flex items-center justify-between gap-2 border-t border-cx-border pt-3">
        <span className="text-xs text-cx-muted">
          Sends the current reading.
        </span>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={isPending}
          onClick={() =>
            void run(() => chargePointService.sendMeterValue(cpId, connectorId))
          }
        >
          Send MeterValues
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-xs text-cx-rose">
          {error}
        </p>
      )}
    </div>
  );
};

/**
 * Sets a connector's meter value and SoC by hand and sends a MeterValues on
 * demand — the Battery card of the classic side panel.
 */
const ConnectorMeterDialog: React.FC<ConnectorMeterDialogProps> = ({
  open,
  onOpenChange,
  ...body
}) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Connector {body.connectorId}: meter and SoC</DialogTitle>
        <DialogDescription>
          Values the next MeterValues reports.
        </DialogDescription>
      </DialogHeader>
      {open && <MeterDialogBody {...body} />}
    </DialogContent>
  </Dialog>
);

export default ConnectorMeterDialog;
