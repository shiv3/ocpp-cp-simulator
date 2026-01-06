import React, { useState, useEffect } from "react";
import { Save, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";

export interface ChargePointConfig {
  cpId: string;
  connectorNumber: number;
  wsURL: string;
  ocppVersion: string;
  basicAuthEnabled: boolean;
  basicAuthUsername: string;
  basicAuthPassword: string;
  autoMeterValueEnabled: boolean;
  autoMeterValueInterval: number;
  autoMeterValue: number;
  chargePointVendor: string;
  chargePointModel: string;
  firmwareVersion: string;
  chargeBoxSerialNumber: string;
  chargePointSerialNumber: string;
  meterSerialNumber: string;
  meterType: string;
  iccid: string;
  imsi: string;
  tagIds: string[];
}

interface ChargePointConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (config: ChargePointConfig) => void;
  initialConfig?: ChargePointConfig;
  isNewChargePoint?: boolean;
}

export const defaultChargePointConfig: ChargePointConfig = {
  cpId: "CP001",
  connectorNumber: 1,
  wsURL: "ws://localhost:8080/steve/websocket/CentralSystemService/",
  ocppVersion: "OCPP-1.6J",
  basicAuthEnabled: false,
  basicAuthUsername: "",
  basicAuthPassword: "",
  autoMeterValueEnabled: false,
  autoMeterValueInterval: 30,
  autoMeterValue: 10,
  chargePointVendor: "Vendor",
  chargePointModel: "Model",
  firmwareVersion: "1.0",
  chargeBoxSerialNumber: "123456",
  chargePointSerialNumber: "123456",
  meterSerialNumber: "123456",
  meterType: "",
  iccid: "",
  imsi: "",
  tagIds: ["123456"],
};

const ChargePointConfigModal: React.FC<ChargePointConfigModalProps> = ({
  isOpen,
  onClose,
  onSave,
  initialConfig,
  isNewChargePoint = false,
}) => {
  const [config, setConfig] = useState<ChargePointConfig>(
    initialConfig || defaultChargePointConfig,
  );

  useEffect(() => {
    if (initialConfig) {
      setConfig(initialConfig);
    }
  }, [initialConfig]);

  const handleSave = () => {
    onSave(config);
    onClose();
  };

  const updateConfig = (
    key: keyof ChargePointConfig,
    value: ChargePointConfig[keyof ChargePointConfig],
  ) => {
    setConfig({ ...config, [key]: value });
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isNewChargePoint
              ? "Add New Charge Point"
              : `Configure ${config.cpId}`}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-6 py-4">
          {/* Basic Settings */}
          <div className="card p-4">
            <h3 className="card-header mb-4">Basic Settings</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="cpId" className="mb-2 logger-label">
                  Charge Point ID
                </Label>
                <Input
                  id="cpId"
                  type="text"
                  value={config.cpId}
                  onChange={(e) => updateConfig("cpId", e.target.value)}
                  required
                  className="logger-input"
                />
              </div>
              <div>
                <Label htmlFor="connectorNumber" className="mb-2 logger-label">
                  Number of Connectors
                </Label>
                <Input
                  id="connectorNumber"
                  type="number"
                  min="1"
                  max="10"
                  value={config.connectorNumber}
                  onChange={(e) =>
                    updateConfig("connectorNumber", parseInt(e.target.value))
                  }
                  required
                  className="logger-input"
                />
              </div>
              <div className="col-span-2">
                <Label htmlFor="wsURL" className="mb-2 logger-label">
                  WebSocket URL
                </Label>
                <Input
                  id="wsURL"
                  type="url"
                  value={config.wsURL}
                  onChange={(e) => updateConfig("wsURL", e.target.value)}
                  required
                  className="logger-input"
                />
              </div>
              <div>
                <Label htmlFor="ocppVersion" className="mb-2">
                  OCPP Version
                </Label>
                <Select
                  value={config.ocppVersion}
                  onValueChange={(value) => updateConfig("ocppVersion", value)}
                >
                  <SelectTrigger id="ocppVersion">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="OCPP-1.6J">OCPP 1.6J</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2">
                <Label htmlFor="tagIds" className="mb-2 logger-label">
                  RFID Tag IDs (comma-separated)
                </Label>
                <Input
                  id="tagIds"
                  type="text"
                  value={config.tagIds.join(", ")}
                  onChange={(e) => {
                    const tags = e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter((s) => s.length > 0);
                    updateConfig("tagIds", tags.length > 0 ? tags : ["123456"]);
                  }}
                  placeholder="e.g., 123456, ABCDEF, TAG001"
                  className="logger-input"
                />
                <p className="text-xs text-muted mt-1">
                  Enter one or more RFID tag IDs separated by commas. These tags
                  can be used for starting transactions.
                </p>
              </div>
            </div>
          </div>

          {/* Boot Notification */}
          <div className="card p-4">
            <h3 className="card-header mb-4">Boot Notification</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label
                  htmlFor="chargePointVendor"
                  className="mb-2 logger-label"
                >
                  Vendor
                </Label>
                <Input
                  id="chargePointVendor"
                  type="text"
                  value={config.chargePointVendor}
                  onChange={(e) =>
                    updateConfig("chargePointVendor", e.target.value)
                  }
                  className="logger-input"
                />
              </div>
              <div>
                <Label htmlFor="chargePointModel" className="mb-2 logger-label">
                  Model
                </Label>
                <Input
                  id="chargePointModel"
                  type="text"
                  value={config.chargePointModel}
                  onChange={(e) =>
                    updateConfig("chargePointModel", e.target.value)
                  }
                  className="logger-input"
                />
              </div>
              <div>
                <Label htmlFor="firmwareVersion" className="mb-2 logger-label">
                  Firmware Version
                </Label>
                <Input
                  id="firmwareVersion"
                  type="text"
                  value={config.firmwareVersion}
                  onChange={(e) =>
                    updateConfig("firmwareVersion", e.target.value)
                  }
                  className="logger-input"
                />
              </div>
            </div>
          </div>

          {/* Optional Settings */}
          <div className="card p-4">
            <h3 className="card-header mb-4">Optional Settings</h3>

            {/* Basic Auth */}
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-3">
                <Checkbox
                  id="basicAuthEnabled"
                  checked={config.basicAuthEnabled}
                  onCheckedChange={(checked) =>
                    updateConfig("basicAuthEnabled", checked as boolean)
                  }
                />
                <Label htmlFor="basicAuthEnabled" className="logger-label">
                  Enable Basic Authentication
                </Label>
              </div>
              {config.basicAuthEnabled && (
                <div className="ml-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label
                      htmlFor="basicAuthUsername"
                      className="mb-2 logger-label"
                    >
                      Username
                    </Label>
                    <Input
                      id="basicAuthUsername"
                      type="text"
                      value={config.basicAuthUsername}
                      onChange={(e) =>
                        updateConfig("basicAuthUsername", e.target.value)
                      }
                      className="logger-input"
                    />
                  </div>
                  <div>
                    <Label
                      htmlFor="basicAuthPassword"
                      className="mb-2 logger-label"
                    >
                      Password
                    </Label>
                    <Input
                      id="basicAuthPassword"
                      type="password"
                      value={config.basicAuthPassword}
                      onChange={(e) =>
                        updateConfig("basicAuthPassword", e.target.value)
                      }
                      className="logger-input"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Auto Meter */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Checkbox
                  id="autoMeterValueEnabled"
                  checked={config.autoMeterValueEnabled}
                  onCheckedChange={(checked) =>
                    updateConfig("autoMeterValueEnabled", checked as boolean)
                  }
                />
                <Label htmlFor="autoMeterValueEnabled" className="logger-label">
                  Enable Auto Meter Value
                </Label>
              </div>
              {config.autoMeterValueEnabled && (
                <div className="ml-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label
                      htmlFor="autoMeterValueInterval"
                      className="mb-2 logger-label"
                    >
                      Interval (seconds)
                    </Label>
                    <Input
                      id="autoMeterValueInterval"
                      type="number"
                      min="1"
                      value={config.autoMeterValueInterval}
                      onChange={(e) =>
                        updateConfig(
                          "autoMeterValueInterval",
                          parseInt(e.target.value),
                        )
                      }
                      className="logger-input"
                    />
                  </div>
                  <div>
                    <Label
                      htmlFor="autoMeterValue"
                      className="mb-2 logger-label"
                    >
                      Increment Value (kWh)
                    </Label>
                    <Input
                      id="autoMeterValue"
                      type="number"
                      min="1"
                      value={config.autoMeterValue}
                      onChange={(e) =>
                        updateConfig("autoMeterValue", parseInt(e.target.value))
                      }
                      className="logger-input"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            <X className="mr-2 h-5 w-5" />
            Cancel
          </Button>
          <Button onClick={handleSave}>
            <Save className="mr-2 h-5 w-5" />
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ChargePointConfigModal;
