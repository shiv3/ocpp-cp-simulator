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
import { cn } from "@/lib/utils";
import {
  ALL_CHARGE_POINT_ERROR_CODES,
  OCPPStatus,
} from "@/cp/domain/types/OcppTypes";

import { FILTER_SELECT_CLASS } from "../../components/filterStyles";
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

/** One key figure of the card: a small uppercase label over a 16px value. */
const KeyFigure: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div>
    <dt className="text-[11px] uppercase tracking-[0.06em] text-cx-faint">
      {label}
    </dt>
    <dd className="mt-0.5 text-base font-medium tabular-nums text-cx-fg">
      {children}
    </dd>
  </div>
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
      className="rounded-[10px] border border-cx-border bg-cx-card p-4 shadow-[0_1px_2px_rgba(20,20,30,0.05)] dark:shadow-none"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-cx-fg">
            Connector {connectorId}
          </span>
          <StatusPill status={view.status} />
        </div>
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
      {removeError && (
        <p role="alert" className="mt-1 text-xs text-cx-rose">
          {removeError}
        </p>
      )}

      {/* The key figures, like the mock's `.kv`: a small label over a value. */}
      <dl className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-x-4 gap-y-3">
        <KeyFigure label="Meter">{formatEnergyKwh(view.meterValue)}</KeyFigure>
        <KeyFigure label="SoC">
          {view.soc != null ? formatSoc(view.soc) : "—"}
        </KeyFigure>
        <KeyFigure label="Transaction">
          {view.transactionId != null ? (
            <>
              #{view.transactionId}
              {view.transactionTagId && (
                <span className="ml-1.5 text-xs font-normal text-cx-muted">
                  {view.transactionTagId}
                </span>
              )}
            </>
          ) : (
            "—"
          )}
        </KeyFigure>
        <KeyFigure label="Availability">
          <span
            className="inline-flex items-center gap-1.5"
            title="Set by the CSMS with ChangeAvailability"
          >
            <span
              aria-hidden
              className={`h-[7px] w-[7px] rounded-full ${
                view.availability === "Operative"
                  ? "bg-cx-emerald"
                  : "bg-cx-rose"
              }`}
            />
            <span data-testid="availability">{view.availability}</span>
          </span>
        </KeyFigure>
      </dl>

      <div className="mt-3">
        <ChargingProfilesList
          profiles={view.chargingProfiles}
          current={view.chargingProfile}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-cx-border pt-3">
        {isCharging ? (
          <Button
            type="button"
            variant="warning"
            size="sm"
            onClick={() => void handleStop()}
            disabled={isPending}
          >
            Stop transaction
          </Button>
        ) : (
          <>
            <select
              value={effectiveTagId}
              onChange={(e) => setTagIdInput(e.target.value)}
              disabled={tagIds.length === 0}
              className={cn(FILTER_SELECT_CLASS, "disabled:opacity-60")}
              title="RFID tag to authorize the transaction with"
              aria-label="TagID of the transaction"
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
            <Button
              type="button"
              variant="success"
              size="sm"
              onClick={() => void handleStart()}
              disabled={isPending || !effectiveTagId}
            >
              Start transaction
            </Button>
          </>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
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
            className={cn(FILTER_SELECT_CLASS, "min-w-0")}
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
