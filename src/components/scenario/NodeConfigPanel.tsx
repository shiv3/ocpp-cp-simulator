import React, { useState, useEffect } from "react";
import { Node } from "@xyflow/react";
import { ScenarioNodeType } from "../../cp/application/scenario/ScenarioTypes";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface NodeConfigPanelProps {
  node: Node | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (nodeId: string, newData: Record<string, unknown>) => void;
}

const NodeConfigPanel: React.FC<NodeConfigPanelProps> = ({
  node,
  isOpen,
  onClose,
  onSave,
}) => {
  const [formData, setFormData] = useState<Record<string, unknown>>({});

  useEffect(() => {
    if (node) {
      setFormData({ ...node.data });
    }
  }, [node]);

  if (!node) return null;

  const handleSave = () => {
    onSave(node.id, formData);
    onClose();
  };

  const renderConfigForm = () => {
    switch (node.type) {
      case ScenarioNodeType.STATUS_CHANGE:
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="label">Label</Label>
              <Input
                id="label"
                type="text"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="status">Status</Label>
              <Select
                value={formData.status || OCPPStatus.Available}
                onValueChange={(value) =>
                  setFormData({ ...formData, status: value })
                }
              >
                <SelectTrigger id="status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.values(OCPPStatus).map((status) => (
                    <SelectItem key={status} value={status}>
                      {status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        );

      case ScenarioNodeType.TRANSACTION:
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="trans-label">Label</Label>
              <Input
                id="trans-label"
                type="text"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="trans-action">Action</Label>
              <Select
                value={formData.action || "start"}
                onValueChange={(value) =>
                  setFormData({ ...formData, action: value })
                }
              >
                <SelectTrigger id="trans-action">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="start">Start Transaction</SelectItem>
                  <SelectItem value="stop">Stop Transaction</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {formData.action === "start" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="tag-id">Tag ID</Label>
                  <Input
                    id="tag-id"
                    type="text"
                    value={formData.tagId || ""}
                    onChange={(e) =>
                      setFormData({ ...formData, tagId: e.target.value })
                    }
                    placeholder="RFID123456"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="battery-capacity">
                    Battery Capacity (kWh)
                  </Label>
                  <Input
                    id="battery-capacity"
                    type="number"
                    value={formData.batteryCapacityKwh || ""}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        batteryCapacityKwh: e.target.value
                          ? parseFloat(e.target.value)
                          : undefined,
                      })
                    }
                    placeholder="e.g., 40, 60, 100"
                    step="0.1"
                    min="0"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    EV battery capacity (optional). Used for calculating charge
                    percentage from energy values.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="initial-soc">Initial SoC (%)</Label>
                  <Input
                    id="initial-soc"
                    type="number"
                    value={formData.initialSoc || ""}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        initialSoc: e.target.value
                          ? parseFloat(e.target.value)
                          : undefined,
                      })
                    }
                    placeholder="e.g., 20, 50, 80"
                    step="0.1"
                    min="0"
                    max="100"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Initial State of Charge percentage (optional). If provided,
                    SoC will be tracked instead of just energy.
                  </p>
                </div>
              </>
            )}
          </div>
        );

      case ScenarioNodeType.METER_VALUE:
        return (
          <MeterValueEditor formData={formData} setFormData={setFormData} />
        );

      case ScenarioNodeType.DELAY:
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="delay-label">Label</Label>
              <Input
                id="delay-label"
                type="text"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="delay-seconds">Delay (seconds)</Label>
              <Input
                id="delay-seconds"
                type="number"
                value={formData.delaySeconds || 0}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    delaySeconds: parseInt(e.target.value) || 0,
                  })
                }
                min="0"
              />
            </div>
          </div>
        );

      case ScenarioNodeType.NOTIFICATION:
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="notif-label">Label</Label>
              <Input
                id="notif-label"
                type="text"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="message-type">Message Type</Label>
              <Input
                id="message-type"
                type="text"
                value={formData.messageType || ""}
                onChange={(e) =>
                  setFormData({ ...formData, messageType: e.target.value })
                }
                placeholder="e.g., Heartbeat, DataTransfer"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="payload">Payload (JSON)</Label>
              <Textarea
                id="payload"
                className="font-mono text-xs"
                rows={6}
                value={
                  typeof formData.payload === "string"
                    ? formData.payload
                    : JSON.stringify(formData.payload || {}, null, 2)
                }
                onChange={(e) => {
                  try {
                    const parsed = JSON.parse(e.target.value);
                    setFormData({ ...formData, payload: parsed });
                  } catch {
                    setFormData({ ...formData, payload: e.target.value });
                  }
                }}
                placeholder='{"key": "value"}'
              />
            </div>
          </div>
        );

      case ScenarioNodeType.CONNECTOR_PLUG:
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="plug-label">Label</Label>
              <Input
                id="plug-label"
                type="text"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="plug-action">Action</Label>
              <Select
                value={formData.action || "plugin"}
                onValueChange={(value) =>
                  setFormData({ ...formData, action: value })
                }
              >
                <SelectTrigger id="plug-action">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="plugin">Plugin (Connect)</SelectItem>
                  <SelectItem value="plugout">Plugout (Disconnect)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        );

      case ScenarioNodeType.REMOTE_START_TRIGGER:
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="remote-label">Label</Label>
              <Input
                id="remote-label"
                type="text"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="timeout">Timeout (seconds)</Label>
              <Input
                id="timeout"
                type="number"
                value={formData.timeout || 0}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    timeout: parseInt(e.target.value) || 0,
                  })
                }
                min="0"
              />
              <p className="text-xs text-muted-foreground mt-1">
                0 = No timeout (wait indefinitely for RemoteStartTransaction)
              </p>
            </div>
          </div>
        );

      case ScenarioNodeType.REMOTE_STOP_TRIGGER:
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="remote-stop-label">Label</Label>
              <Input
                id="remote-stop-label"
                type="text"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="remote-stop-timeout">Timeout (seconds)</Label>
              <Input
                id="remote-stop-timeout"
                type="number"
                value={formData.timeout || 0}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    timeout: parseInt(e.target.value) || 0,
                  })
                }
                min="0"
              />
              <p className="text-xs text-muted-foreground mt-1">
                0 = No timeout (wait indefinitely for RemoteStopTransaction)
              </p>
            </div>
          </div>
        );

      case ScenarioNodeType.RESERVE_NOW:
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="reserve-label">Label</Label>
              <Input
                id="reserve-label"
                type="text"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="idTag">ID Tag</Label>
              <Input
                id="idTag"
                type="text"
                value={formData.idTag || ""}
                onChange={(e) =>
                  setFormData({ ...formData, idTag: e.target.value })
                }
                placeholder="Enter ID tag"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="expiryMinutes">Expiry (minutes)</Label>
              <Input
                id="expiryMinutes"
                type="number"
                value={formData.expiryMinutes || 30}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    expiryMinutes: parseInt(e.target.value) || 30,
                  })
                }
                min="1"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="parentIdTag">Parent ID Tag (Optional)</Label>
              <Input
                id="parentIdTag"
                type="text"
                value={formData.parentIdTag || ""}
                onChange={(e) =>
                  setFormData({ ...formData, parentIdTag: e.target.value })
                }
                placeholder="Optional parent ID tag"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reservationId">Reservation ID (Optional)</Label>
              <Input
                id="reservationId"
                type="number"
                value={formData.reservationId || ""}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    reservationId: e.target.value
                      ? parseInt(e.target.value)
                      : undefined,
                  })
                }
                placeholder="Auto-generated if not provided"
              />
            </div>
          </div>
        );

      case ScenarioNodeType.CANCEL_RESERVATION:
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cancel-label">Label</Label>
              <Input
                id="cancel-label"
                type="text"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cancel-reservationId">Reservation ID</Label>
              <Input
                id="cancel-reservationId"
                type="number"
                value={formData.reservationId || ""}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    reservationId: parseInt(e.target.value) || 0,
                  })
                }
                placeholder="Enter reservation ID to cancel"
              />
            </div>
          </div>
        );

      case ScenarioNodeType.STATUS_TRIGGER:
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="status-trigger-label">Label</Label>
              <Input
                id="status-trigger-label"
                type="text"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="target-status">Target Status</Label>
              <Select
                value={formData.targetStatus || OCPPStatus.Available}
                onValueChange={(value) =>
                  setFormData({ ...formData, targetStatus: value })
                }
              >
                <SelectTrigger id="target-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.values(OCPPStatus).map((status) => (
                    <SelectItem key={status} value={status}>
                      {status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="status-timeout">Timeout (seconds)</Label>
              <Input
                id="status-timeout"
                type="number"
                value={formData.timeout || 0}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    timeout: parseInt(e.target.value) || 0,
                  })
                }
                min="0"
              />
              <p className="text-xs text-muted-foreground mt-1">
                0 = No timeout (wait indefinitely for status change)
              </p>
            </div>
          </div>
        );

      case ScenarioNodeType.RESERVATION_TRIGGER:
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="reservation-trigger-label">Label</Label>
              <Input
                id="reservation-trigger-label"
                type="text"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reservation-timeout">Timeout (seconds)</Label>
              <Input
                id="reservation-timeout"
                type="number"
                value={formData.timeout || 0}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    timeout: parseInt(e.target.value) || 0,
                  })
                }
                min="0"
              />
              <p className="text-xs text-muted-foreground mt-1">
                0 = No timeout (wait indefinitely for ReserveNow request)
              </p>
            </div>
          </div>
        );

      case ScenarioNodeType.START: {
        // Trigger config: "connect" fires once the CP is Available
        // (post-BootNotification); "status" gates on the bound connector
        // reaching a specific status.
        const triggerOn =
          formData.triggerOn === "status" ? "status" : "connect";
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="start-label">Label</Label>
              <Input
                id="start-label"
                type="text"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="start-trigger-on">Trigger</Label>
              <select
                id="start-trigger-on"
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                value={triggerOn}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    triggerOn: e.target.value as "connect" | "status",
                  })
                }
              >
                <option value="connect">
                  On Connect (BootNotification Accepted)
                </option>
                <option value="status">On Connector Status</option>
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                "On Connect" fires as soon as the CSMS accepts BootNotification.
                "On Connector Status" additionally waits for the bound connector
                to reach the target status below.
              </p>
            </div>
            {triggerOn === "status" && (
              <div className="space-y-2">
                <Label htmlFor="start-target-status">Target Status</Label>
                <select
                  id="start-target-status"
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                  value={formData.targetStatus || OCPPStatus.Available}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      targetStatus: e.target.value as OCPPStatus,
                    })
                  }
                >
                  {Object.values(OCPPStatus).map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        );
      }

      default:
        return (
          <div className="text-sm text-muted-foreground">
            This node type does not have configurable properties.
          </div>
        );
    }
  };

  const getNodeTypeName = (type: string) => {
    switch (type) {
      case ScenarioNodeType.STATUS_CHANGE:
        return "Status Change";
      case ScenarioNodeType.TRANSACTION:
        return "Transaction";
      case ScenarioNodeType.METER_VALUE:
        return "Meter Value";
      case ScenarioNodeType.DELAY:
        return "Delay";
      case ScenarioNodeType.NOTIFICATION:
        return "Notification";
      case ScenarioNodeType.CONNECTOR_PLUG:
        return "Connector Plug";
      case ScenarioNodeType.REMOTE_START_TRIGGER:
        return "Remote Start Trigger";
      case ScenarioNodeType.REMOTE_STOP_TRIGGER:
        return "Remote Stop Trigger";
      case ScenarioNodeType.STATUS_TRIGGER:
        return "Status Trigger";
      case ScenarioNodeType.RESERVE_NOW:
        return "Reserve Now";
      case ScenarioNodeType.CANCEL_RESERVATION:
        return "Cancel Reservation";
      case ScenarioNodeType.RESERVATION_TRIGGER:
        return "Reservation Trigger";
      case ScenarioNodeType.START:
        return "Start";
      default:
        return "Node";
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            Configure {getNodeTypeName(node?.type || "")}
          </DialogTitle>
        </DialogHeader>
        <div className="py-4">{renderConfigForm()}</div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/**
 * MeterValue node editor split into two surfaces:
 *
 *   - **Simple** (always visible): `Output (kW)` and `Max charge (kWh)`.
 *     These are the two knobs an operator typically wants when
 *     simulating an EV plugged into a charger — "how fast and how
 *     much?". The editor derives the existing `incrementAmount` (Wh per
 *     tick) and `maxValue` (Wh) on save, keeping the scheduler
 *     contract unchanged so older scenarios and the runtime
 *     `MeterValueScheduler` keep working.
 *
 *   - **Advanced** (collapsed by default unless the scenario has raw
 *     fields and no `outputKw`): the existing Initial value /
 *     interval / increment amount / max time / max value fields. Power
 *     users can still tune raw Wh-per-tick or non-default intervals;
 *     when those diverge from what `outputKw` would compute, advanced
 *     wins (the scheduler reads the raw fields).
 *
 * Default interval is 5 s (matches what scenarios already produce). A
 * different interval can be set in the advanced panel.
 */
function deriveIncrementAmountWh(
  outputKw: number,
  intervalSec: number,
): number {
  // Wh delivered in `intervalSec` at `outputKw` of constant output.
  //   kW × (intervalSec / 3600) × 1000  =  Wh
  // Rounded to 2 decimals so the chart doesn't drift on long runs from
  // a quietly truncating integer cast downstream.
  return Math.round(outputKw * intervalSec * (1000 / 3600) * 100) / 100;
}

const MeterValueEditor: React.FC<{
  formData: Record<string, unknown>;
  setFormData: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
}> = ({ formData, setFormData }) => {
  const outputKw =
    typeof formData.outputKw === "number" ? formData.outputKw : undefined;
  const maxChargeKwh =
    typeof formData.maxChargeKwh === "number"
      ? formData.maxChargeKwh
      : undefined;
  const intervalSec =
    typeof formData.incrementInterval === "number"
      ? formData.incrementInterval
      : 5;
  // Open the Advanced panel by default for legacy scenarios that have raw
  // increment fields but no outputKw (otherwise the operator opens the
  // editor and sees what looks like a fresh node with the raw values
  // hidden behind the toggle).
  const initialAdvancedOpen =
    outputKw === undefined &&
    typeof formData.incrementAmount === "number" &&
    formData.incrementAmount > 0;
  const [advancedOpen, setAdvancedOpen] =
    useState<boolean>(initialAdvancedOpen);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="meter-label">Label</Label>
        <Input
          id="meter-label"
          type="text"
          value={(formData.label as string) || ""}
          onChange={(e) =>
            setFormData((prev) => ({ ...prev, label: e.target.value }))
          }
        />
      </div>

      {/* --- Simple inputs --- */}
      <div className="space-y-2">
        <Label htmlFor="outputKw">Output (kW)</Label>
        <Input
          id="outputKw"
          type="number"
          step="0.1"
          min="0"
          value={outputKw ?? 5}
          onChange={(e) => {
            const next = parseFloat(e.target.value);
            const kw = Number.isFinite(next) && next >= 0 ? next : 0;
            setFormData((prev) => ({
              ...prev,
              outputKw: kw,
              // Enable auto-increment + send-message implicitly when the
              // simple inputs are touched; the operator can override
              // these checkboxes in the advanced panel below.
              autoIncrement: true,
              sendMessage: true,
              incrementInterval:
                typeof prev.incrementInterval === "number"
                  ? prev.incrementInterval
                  : 5,
              incrementAmount: deriveIncrementAmountWh(
                kw,
                typeof prev.incrementInterval === "number"
                  ? prev.incrementInterval
                  : 5,
              ),
            }));
          }}
        />
        <p className="text-xs text-muted-foreground">
          1 tick = {deriveIncrementAmountWh(outputKw ?? 5, intervalSec)} Wh at{" "}
          {intervalSec} s interval
        </p>
      </div>

      {formData.stopMode !== "evSettings" && (
        <div className="space-y-2">
          <Label htmlFor="maxChargeKwh">Max charge (kWh, 0 = unlimited)</Label>
          <Input
            id="maxChargeKwh"
            type="number"
            step="0.1"
            min="0"
            value={maxChargeKwh ?? 0}
            onChange={(e) => {
              const next = parseFloat(e.target.value);
              const kwh = Number.isFinite(next) && next >= 0 ? next : 0;
              setFormData((prev) => ({
                ...prev,
                maxChargeKwh: kwh,
                // Keep `maxValue` (Wh) in sync so older daemon builds
                // that only read `maxValue` stop at the same point.
                maxValue: Math.round(kwh * 1000),
              }));
            }}
          />
        </div>
      )}
      {formData.stopMode === "evSettings" && (
        <div className="rounded border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
          Auto-meter stops at the connector's target SoC (set in EV Settings).
          Switch the stop condition in the advanced panel below to use a fixed
          kWh cap instead.
        </div>
      )}

      {/* --- Advanced (collapsible) --- */}
      <div className="border-t pt-3">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          {advancedOpen ? "▼" : "▶"} Advanced settings
        </button>
        {advancedOpen && (
          <div className="mt-3 space-y-3">
            <div className="space-y-2">
              <Label htmlFor="meter-value">Initial value (Wh)</Label>
              <Input
                id="meter-value"
                type="number"
                value={(formData.value as number) || 0}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    value: parseInt(e.target.value) || 0,
                  }))
                }
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="sendMessage"
                checked={(formData.sendMessage as boolean) || false}
                onCheckedChange={(checked) =>
                  setFormData((prev) => ({ ...prev, sendMessage: checked }))
                }
              />
              <Label
                htmlFor="sendMessage"
                className="font-normal cursor-pointer"
              >
                Send MeterValue message
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="autoIncrement"
                checked={(formData.autoIncrement as boolean) || false}
                onCheckedChange={(checked) =>
                  setFormData((prev) => ({ ...prev, autoIncrement: checked }))
                }
              />
              <Label
                htmlFor="autoIncrement"
                className="font-normal cursor-pointer"
              >
                Auto increment (start AutoMeterValue manager)
              </Label>
            </div>
            <div className="space-y-2">
              <Label htmlFor="stopMode">Stop condition</Label>
              <Select
                value={(formData.stopMode as string) || "manual"}
                onValueChange={(value) =>
                  setFormData((prev) => ({
                    ...prev,
                    stopMode: value as "manual" | "evSettings",
                  }))
                }
              >
                <SelectTrigger id="stopMode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">
                    Manual (use Max value / Max time below)
                  </SelectItem>
                  <SelectItem value="evSettings">
                    EV Settings (stop at target SoC)
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                In <em>EV Settings</em> mode the auto-meter stops when delivered
                Wh reaches{" "}
                <code>
                  capacity_kWh × (targetSoc − initialSoc) ÷ 100 × 1000
                </code>
                . Configure the connector's EV settings (battery capacity,
                target SoC) from the connector side panel.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="incrementInterval">
                Increment interval (seconds)
              </Label>
              <Input
                id="incrementInterval"
                type="number"
                value={(formData.incrementInterval as number) ?? 5}
                onChange={(e) => {
                  const nextInterval = parseInt(e.target.value) || 5;
                  setFormData((prev) => ({
                    ...prev,
                    incrementInterval: nextInterval,
                    // Recompute Wh-per-tick when interval changes so the
                    // effective kW output the operator set in the simple
                    // panel stays constant.
                    ...(typeof prev.outputKw === "number"
                      ? {
                          incrementAmount: deriveIncrementAmountWh(
                            prev.outputKw,
                            nextInterval,
                          ),
                        }
                      : {}),
                  }));
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="incrementAmount">Increment amount (Wh)</Label>
              <Input
                id="incrementAmount"
                type="number"
                step="0.01"
                value={(formData.incrementAmount as number) ?? 0}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    incrementAmount: parseFloat(e.target.value) || 0,
                    // Detach from `outputKw` once the operator edits the
                    // raw Wh-per-tick directly — otherwise the next save
                    // would overwrite their value with the derived one.
                    outputKw: undefined,
                  }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="maxTime">Max time (seconds, 0 = unlimited)</Label>
              <Input
                id="maxTime"
                type="number"
                value={(formData.maxTime as number) || 0}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    maxTime: parseInt(e.target.value) || 0,
                  }))
                }
              />
              <p className="text-xs text-muted-foreground">
                AutoMeterValue stops after this many seconds (0 = unlimited).
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="maxValue">Max value (Wh, 0 = unlimited)</Label>
              <Input
                id="maxValue"
                type="number"
                value={(formData.maxValue as number) || 0}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    maxValue: parseInt(e.target.value) || 0,
                    // Detach from `maxChargeKwh` so the next round-trip
                    // doesn't silently overwrite the raw Wh threshold.
                    maxChargeKwh: undefined,
                  }))
                }
              />
              <p className="text-xs text-muted-foreground">
                AutoMeterValue stops when the meter reaches this value (0 =
                unlimited).
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default NodeConfigPanel;
