import React, { useState } from "react";

import { Button } from "@/components/ui/button";
import type { EVSettings } from "@/cp/domain/connector/EVSettings";
import {
  ALL_CHARGE_POINT_ERROR_CODES,
  OCPPStatus,
  type OCPPAvailability,
} from "@/cp/domain/types/OcppTypes";
import { useDataContext } from "@/data/providers/DataProvider";
import { cn } from "@/lib/utils";

import {
  FILTER_INPUT_CLASS,
  FILTER_SELECT_CLASS,
} from "../../components/filterStyles";
import {
  describeError,
  plugIn,
  setSocWithSync,
  unplug,
} from "./connectorActions";
import { Group, Hint, Row } from "./controlPrimitives";

export interface ConnectorControlsProps {
  /** For the card's Controls toggle (`aria-controls`). */
  id: string;
  hidden?: boolean;
  cpId: string;
  connectorId: number;
  status: OCPPStatus;
  availability: OCPPAvailability;
  /** Live readings, in Wh and %. */
  meterValue: number;
  soc: number | null;
  evSettings: EVSettings;
}

// Literal list (not `Object.values(OCPPStatus)`) so the order is the
// enum's declaration order.
const STATUS_OPTIONS: OCPPStatus[] = [
  OCPPStatus.Available,
  OCPPStatus.Preparing,
  OCPPStatus.Charging,
  OCPPStatus.SuspendedEV,
  OCPPStatus.SuspendedEVSE,
  OCPPStatus.Finishing,
  OCPPStatus.Reserved,
  OCPPStatus.Unavailable,
  OCPPStatus.Faulted,
];

// A fault has an error to report (§7.6), as in the classic side panel (#434).
const FAULT_ERROR_CODES = ALL_CHARGE_POINT_ERROR_CODES.filter(
  (code) => code !== "NoError",
);

type GroupId = "readings" | "status" | "connector";

const INPUT = cn(FILTER_INPUT_CLASS, "h-8 min-w-0 flex-1 py-1 font-mono");
const SELECT = cn(FILTER_SELECT_CLASS, "min-w-0 flex-1");

/**
 * The simulator controls of a connector card, folded away by default: the
 * readings (SoC, meter, a MeterValues now), status and faults (any
 * StatusNotification, Faulted with an error code), and the connector itself
 * (plug in / unplug, remove). Each group reports its own failure and waits
 * for its own call.
 */
const ConnectorControls: React.FC<ConnectorControlsProps> = ({
  id,
  hidden,
  cpId,
  connectorId,
  status,
  availability,
  meterValue,
  soc,
  evSettings,
}) => {
  const { chargePointService: service } = useDataContext();
  const [pending, setPending] = useState<GroupId | null>(null);
  const [errors, setErrors] = useState<Record<GroupId, string | null>>({
    readings: null,
    status: null,
    connector: null,
  });
  // Typed values; until edited they follow the live readings.
  const [socText, setSocText] = useState<string | null>(null);
  const [meterText, setMeterText] = useState<string | null>(null);
  const [statusPick, setStatusPick] = useState<OCPPStatus>(status);
  const [errorCode, setErrorCode] = useState("InternalError");

  const socShown =
    socText ?? (soc == null ? "" : String(Number(soc.toFixed(1))));
  const meterShown = meterText ?? (meterValue / 1000).toFixed(2);
  const socValue = Number(socShown);
  const socValid =
    socShown.trim() !== "" &&
    Number.isFinite(socValue) &&
    socValue >= 0 &&
    socValue <= 100;
  const meterKwh = Number(meterShown);
  const meterValid =
    meterShown.trim() !== "" && Number.isFinite(meterKwh) && meterKwh >= 0;

  const run = async (group: GroupId, action: () => Promise<void>) => {
    setPending(group);
    setErrors((prev) => ({ ...prev, [group]: null }));
    try {
      await action();
    } catch (err) {
      console.error(`Connector control failed on ${cpId}/${connectorId}`, err);
      setErrors((prev) => ({ ...prev, [group]: describeError(err) }));
    } finally {
      setPending(null);
    }
  };

  const sendStatus = (next: OCPPStatus) =>
    run("status", () =>
      next === OCPPStatus.Faulted
        ? service.sendStatusNotification(cpId, connectorId, next, {
            errorCode,
          })
        : service.sendStatusNotification(cpId, connectorId, next),
    );

  // Runtime only, as in the classic UI: the card goes away on the service's
  // `connector-removed` event, and the connector comes back when the charge
  // point is created again (reload, daemon restart).
  const handleRemove = async () => {
    if (
      !window.confirm(
        `Remove connector ${connectorId} from ${cpId}? The removal is not saved: the connector comes back when the charge point is created again.`,
      )
    ) {
      return;
    }
    setErrors((prev) => ({ ...prev, connector: null }));
    try {
      await service.removeConnector(cpId, connectorId);
    } catch (err) {
      console.error(`Failed to remove ${cpId}/${connectorId}`, err);
      setErrors((prev) => ({
        ...prev,
        connector: `Connector not removed: ${describeError(err)}`,
      }));
    }
  };

  return (
    <div
      id={id}
      hidden={hidden}
      className="mt-3.5 rounded-[9px] border border-cx-border bg-[color-mix(in_srgb,var(--cx-sub)_55%,transparent)] px-3.5 py-3"
    >
      <h3 className="mb-2.5 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.06em] text-cx-faint">
        Simulator controls{" "}
        <small className="text-xs font-normal normal-case tracking-normal text-cx-muted">
          — what a real charger would not do by itself
        </small>
      </h3>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(250px,1fr))] gap-2.5">
        <Group title="Readings" error={errors.readings}>
          <Row>
            <Hint className="w-11">SoC</Hint>
            <input
              type="number"
              min={0}
              max={100}
              aria-label="SoC (%)"
              placeholder="not reported"
              value={socShown}
              onChange={(e) => setSocText(e.target.value)}
              className={cn(INPUT, "min-w-[7.5rem]")}
            />
            <Hint>%</Hint>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending === "readings" || !socValid}
              onClick={() =>
                void run("readings", async () => {
                  await setSocWithSync(
                    service,
                    cpId,
                    connectorId,
                    socValue,
                    evSettings,
                  );
                  setSocText(null);
                })
              }
            >
              Set
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              title="The next MeterValues carries no SoC sample"
              disabled={pending === "readings"}
              onClick={() =>
                void run("readings", async () => {
                  await service.setConnectorSoc(cpId, connectorId, null);
                  setSocText(null);
                })
              }
            >
              Clear
            </Button>
          </Row>
          <Row>
            <Hint className="w-11">Meter</Hint>
            <input
              type="number"
              min={0}
              step="0.01"
              aria-label="Meter (kWh)"
              value={meterShown}
              onChange={(e) => setMeterText(e.target.value)}
              className={INPUT}
            />
            <Hint>kWh</Hint>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending === "readings" || !meterValid}
              onClick={() =>
                void run("readings", async () => {
                  // The register is in Wh.
                  await service.setMeterValue(
                    cpId,
                    connectorId,
                    Math.round(meterKwh * 1000),
                  );
                  setMeterText(null);
                })
              }
            >
              Set
            </Button>
          </Row>
          <Row>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending === "readings"}
              onClick={() =>
                void run("readings", () =>
                  service.sendMeterValue(cpId, connectorId),
                )
              }
            >
              Send MeterValues now
            </Button>
          </Row>
        </Group>

        <Group title="Status and faults" error={errors.status}>
          <Row>
            <select
              aria-label="Status"
              value={statusPick}
              onChange={(e) => setStatusPick(e.target.value as OCPPStatus)}
              className={SELECT}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending === "status"}
              onClick={() => void sendStatus(statusPick)}
            >
              Send status
            </Button>
          </Row>
          <Row>
            <select
              aria-label="Fault error code"
              title="errorCode sent with Faulted"
              value={errorCode}
              onChange={(e) => setErrorCode(e.target.value)}
              className={SELECT}
            >
              {FAULT_ERROR_CODES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={pending === "status"}
              onClick={() => void sendStatus(OCPPStatus.Faulted)}
            >
              Send Faulted
            </Button>
          </Row>
          <Hint>
            Availability:{" "}
            <b className="font-medium text-cx-fg2">{availability}</b> (the CSMS
            sets it with ChangeAvailability)
          </Hint>
        </Group>

        <Group title="Connector" error={errors.connector}>
          <Row>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending === "connector"}
              onClick={() =>
                void run("connector", () => plugIn(service, cpId, connectorId))
              }
            >
              Plug in
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending === "connector"}
              onClick={() =>
                void run("connector", () => unplug(service, cpId, connectorId))
              }
            >
              Unplug
            </Button>
          </Row>
          <Row>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              aria-label={`Remove connector ${connectorId}`}
              onClick={() => void handleRemove()}
            >
              Remove connector
            </Button>
          </Row>
          <Hint>
            Removal is not saved; the connector comes back when the charge point
            is created again.
          </Hint>
        </Group>
      </div>
    </div>
  );
};

export default ConnectorControls;
