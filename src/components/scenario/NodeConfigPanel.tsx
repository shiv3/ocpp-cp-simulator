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
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="meter-label">Label</Label>
              <Input
                id="meter-label"
                type="text"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="meter-value">Initial Value (Wh)</Label>
              <Input
                id="meter-value"
                type="number"
                value={formData.value || 0}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    value: parseInt(e.target.value) || 0,
                  })
                }
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="sendMessage"
                checked={formData.sendMessage || false}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, sendMessage: checked })
                }
              />
              <Label
                htmlFor="sendMessage"
                className="font-normal cursor-pointer"
              >
                Send MeterValue Message
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="autoIncrement"
                checked={formData.autoIncrement || false}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, autoIncrement: checked })
                }
              />
              <Label
                htmlFor="autoIncrement"
                className="font-normal cursor-pointer"
              >
                Auto Increment (Start AutoMeterValue Manager)
              </Label>
            </div>
            {formData.autoIncrement && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="incrementInterval">
                    Increment Interval (seconds)
                  </Label>
                  <Input
                    id="incrementInterval"
                    type="number"
                    value={formData.incrementInterval || 10}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        incrementInterval: parseInt(e.target.value) || 10,
                      })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="incrementAmount">Increment Amount (Wh)</Label>
                  <Input
                    id="incrementAmount"
                    type="number"
                    value={formData.incrementAmount || 1000}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        incrementAmount: parseInt(e.target.value) || 1000,
                      })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="maxTime">
                    Max Time (seconds, 0 = unlimited)
                  </Label>
                  <Input
                    id="maxTime"
                    type="number"
                    value={formData.maxTime || 0}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        maxTime: parseInt(e.target.value) || 0,
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    AutoMeterValue will stop after this many seconds (0 =
                    unlimited)
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="maxValue">
                    Max Value (Wh, 0 = unlimited)
                  </Label>
                  <Input
                    id="maxValue"
                    type="number"
                    value={formData.maxValue || 0}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        maxValue: parseInt(e.target.value) || 0,
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    AutoMeterValue will stop when meter reaches this value (0 =
                    unlimited)
                  </p>
                </div>
              </>
            )}
          </div>
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
      case ScenarioNodeType.STATUS_TRIGGER:
        return "Status Trigger";
      case ScenarioNodeType.RESERVE_NOW:
        return "Reserve Now";
      case ScenarioNodeType.CANCEL_RESERVATION:
        return "Cancel Reservation";
      case ScenarioNodeType.RESERVATION_TRIGGER:
        return "Reservation Trigger";
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

export default NodeConfigPanel;
