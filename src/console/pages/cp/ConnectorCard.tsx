import React, { useState } from "react";
import { ChevronDown, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConnectorView } from "@/data/hooks/useConnectorView";
import { useGlobalTagIds } from "@/data/hooks/useGlobalTagIds";
import { useDataContext } from "@/data/providers/DataProvider";
import { formatEnergyKwh, formatSoc } from "@/lib/connectorFormat";
import {
  ALL_CHARGE_POINT_ERROR_CODES,
  OCPPStatus,
} from "@/cp/domain/types/OcppTypes";

import StatusPill from "../../components/StatusPill";
import AutoMeterButton from "./AutoMeterButton";
import ChargingProfilesList from "./ChargingProfilesList";
import ConnectorMeterDialog from "./ConnectorMeterDialog";

export interface ConnectorCardProps {
  cpId: string;
  connectorId: number;
}

// Literal list (not `Object.values(OCPPStatus)`) so the dropdown order
// matches the enum's declaration order regardless of how TS happens to type
// the reverse-mapping-free `Object.values` result for a string enum.
const STATUS_OPTIONS: OCPPStatus[] = [
  OCPPStatus.Available,
  OCPPStatus.Preparing,
  OCPPStatus.Charging,
  OCPPStatus.SuspendedEVSE,
  OCPPStatus.SuspendedEV,
  OCPPStatus.Finishing,
  OCPPStatus.Reserved,
  OCPPStatus.Unavailable,
  OCPPStatus.Faulted,
];

// A fault has an error to report (§7.6), as in the classic side panel.
const FAULT_ERROR_CODES = ALL_CHARGE_POINT_ERROR_CODES.filter(
  (code) => code !== "NoError",
);

/**
 * Per-connector operational card for the CP detail page: status, active
 * transaction, meters, start/stop, and a manual status-notification
 * override, plus the meter / SoC, auto meter values, charging profiles and
 * removal controls ported from the classic UI's connector side panel.
 */
const ConnectorCard: React.FC<ConnectorCardProps> = ({ cpId, connectorId }) => {
  const { chargePointService } = useDataContext();
  const { tagIds } = useGlobalTagIds();
  const view = useConnectorView(cpId, connectorId);
  const [tagIdInput, setTagIdInput] = useState<string>("");
  const [isPending, setIsPending] = useState(false);
  const [isMeterOpen, setIsMeterOpen] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [faultErrorCode, setFaultErrorCode] = useState("InternalError");

  const isCharging = view.transactionId != null;
  const effectiveTagId = tagIds.includes(tagIdInput)
    ? tagIdInput
    : (tagIds[0] ?? "");

  const handleStart = async () => {
    if (!effectiveTagId) return;
    setIsPending(true);
    try {
      await chargePointService.startTransaction(
        cpId,
        connectorId,
        effectiveTagId,
      );
    } catch (err) {
      console.error(
        `Failed to start transaction on ${cpId}/${connectorId}`,
        err,
      );
    } finally {
      setIsPending(false);
    }
  };

  const handleStop = async () => {
    setIsPending(true);
    try {
      await chargePointService.stopTransaction(cpId, connectorId);
    } catch (err) {
      console.error(
        `Failed to stop transaction on ${cpId}/${connectorId}`,
        err,
      );
    } finally {
      setIsPending(false);
    }
  };

  const handleSetStatus = async (status: OCPPStatus) => {
    if (isPending) return;
    setIsPending(true);
    try {
      if (status === OCPPStatus.Faulted) {
        await chargePointService.sendStatusNotification(
          cpId,
          connectorId,
          status,
          { errorCode: faultErrorCode },
        );
      } else {
        await chargePointService.sendStatusNotification(
          cpId,
          connectorId,
          status,
        );
      }
    } catch (err) {
      console.error(
        `Failed to set status ${status} on ${cpId}/${connectorId}`,
        err,
      );
    } finally {
      setIsPending(false);
    }
  };

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
    setRemoveError(null);
    try {
      await chargePointService.removeConnector(cpId, connectorId);
    } catch (err) {
      console.error(`Failed to remove ${cpId}/${connectorId}`, err);
      setRemoveError(
        `Connector not removed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  return (
    <div
      data-connector-id={connectorId}
      className="flex flex-col rounded-[10px] border border-cx-border bg-cx-card shadow-[0_1px_2px_rgba(20,20,30,0.05)] dark:shadow-none p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-cx-fg">
          Connector {connectorId}
        </span>
        <div className="flex items-center gap-1">
          <StatusPill status={view.status} />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-cx-muted hover:text-cx-rose"
            aria-label={`Remove connector ${connectorId}`}
            title="Remove connector"
            onClick={() => void handleRemove()}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {removeError && (
        <p role="alert" className="mt-1 text-xs text-cx-rose">
          {removeError}
        </p>
      )}

      <div
        className="mt-1 flex items-center gap-1.5 text-xs text-cx-muted"
        title="Set by the CSMS with ChangeAvailability"
      >
        <span
          aria-hidden
          className={`h-1.5 w-1.5 rounded-full ${
            view.availability === "Operative" ? "bg-cx-emerald" : "bg-cx-rose"
          }`}
        />
        <span data-testid="availability">{view.availability}</span>
      </div>

      {view.transactionId != null && (
        <div className="mt-1 text-xs text-cx-muted">
          Tx #{view.transactionId}
          {view.transactionTagId ? ` · ${view.transactionTagId}` : ""}
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-md bg-cx-sub px-2 py-1.5">
          <div className="text-cx-muted">Energy</div>
          <div className="font-mono tabular-nums text-cx-fg">
            {formatEnergyKwh(view.meterValue)}
          </div>
        </div>
        <div className="rounded-md bg-cx-sub px-2 py-1.5">
          <div className="text-cx-muted">SoC</div>
          <div className="font-mono tabular-nums text-cx-fg">
            {view.soc != null ? formatSoc(view.soc) : "—"}
          </div>
        </div>
      </div>

      <div className="mt-2">
        <ChargingProfilesList
          profiles={view.chargingProfiles}
          current={view.chargingProfile}
        />
      </div>

      <div className="mt-3 space-y-2">
        {isCharging ? (
          <button
            type="button"
            onClick={() => void handleStop()}
            disabled={isPending}
            className="w-full rounded-[7px] border border-cx-border-strong px-3 py-1.5 text-[12.5px] font-medium text-cx-amber hover:bg-cx-sub disabled:cursor-not-allowed disabled:opacity-50"
          >
            Stop transaction
          </button>
        ) : (
          <>
            <select
              value={effectiveTagId}
              onChange={(e) => setTagIdInput(e.target.value)}
              disabled={tagIds.length === 0}
              className="w-full rounded-[7px] border border-cx-border bg-cx-card px-2.5 py-1.5 text-[13px] text-cx-fg hover:border-cx-border-strong disabled:opacity-60"
              title="RFID tag to authorize the transaction with"
            >
              {tagIds.length === 0 ? (
                <option value="">No TagIDs configured</option>
              ) : (
                tagIds.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))
              )}
            </select>
            <button
              type="button"
              onClick={() => void handleStart()}
              disabled={isPending || !effectiveTagId}
              className="w-full rounded-[7px] border border-cx-border-strong px-3 py-1.5 text-[12.5px] font-medium text-cx-emerald hover:bg-cx-sub disabled:cursor-not-allowed disabled:opacity-50"
            >
              Start transaction
            </button>
          </>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-between text-xs"
            >
              Set status
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {STATUS_OPTIONS.map((status) => (
              <DropdownMenuItem
                key={status}
                disabled={isPending}
                onClick={() => void handleSetStatus(status)}
              >
                {status}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <label className="flex items-center gap-2 text-xs text-cx-fg2">
          <span className="shrink-0">Faulted with</span>
          <select
            aria-label="Fault error code"
            value={faultErrorCode}
            onChange={(e) => setFaultErrorCode(e.target.value)}
            title="errorCode sent with Set status → Faulted"
            className="min-w-0 flex-1 rounded-md border border-cx-border-strong py-1 pl-2 pr-8 text-xs text-cx-fg"
          >
            {FAULT_ERROR_CODES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full text-xs"
          onClick={() => setIsMeterOpen(true)}
        >
          Meter & SoC
        </Button>
        <AutoMeterButton
          cpId={cpId}
          connectorId={connectorId}
          liveConfig={view.autoMeterValueConfig}
        />
      </div>

      <ConnectorMeterDialog
        cpId={cpId}
        connectorId={connectorId}
        open={isMeterOpen}
        onOpenChange={setIsMeterOpen}
        meterValue={view.meterValue}
        soc={view.soc}
        evSettings={view.evSettings}
      />
    </div>
  );
};

export default ConnectorCard;
