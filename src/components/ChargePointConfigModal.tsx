import React, { useState, useEffect } from "react";
import { Modal, Label, TextInput, Select, Checkbox, Button } from "flowbite-react";
import { HiSave, HiX } from "react-icons/hi";

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
    initialConfig || defaultChargePointConfig
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

  const updateConfig = (key: keyof ChargePointConfig, value: any) => {
    setConfig({ ...config, [key]: value });
  };

  return (
    <Modal show={isOpen} onClose={onClose} size="4xl">
      <Modal.Header>
        {isNewChargePoint ? "Add New Charge Point" : `Configure ${config.cpId}`}
      </Modal.Header>
      <Modal.Body>
        <div className="space-y-6">
          {/* Basic Settings */}
          <div className="card p-4">
            <h3 className="card-header mb-4">Basic Settings</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="cpId" value="Charge Point ID" className="mb-2 logger-label" />
                <TextInput
                  id="cpId"
                  type="text"
                  value={config.cpId}
                  onChange={(e) => updateConfig("cpId", e.target.value)}
                  required
                  className="logger-input"
                />
              </div>
              <div>
                <Label htmlFor="connectorNumber" value="Number of Connectors" className="mb-2 logger-label" />
                <TextInput
                  id="connectorNumber"
                  type="number"
                  min="1"
                  max="10"
                  value={config.connectorNumber}
                  onChange={(e) => updateConfig("connectorNumber", parseInt(e.target.value))}
                  required
                  className="logger-input"
                />
              </div>
              <div className="col-span-2">
                <Label htmlFor="wsURL" value="WebSocket URL" className="mb-2 logger-label" />
                <TextInput
                  id="wsURL"
                  type="url"
                  value={config.wsURL}
                  onChange={(e) => updateConfig("wsURL", e.target.value)}
                  required
                  className="logger-input"
                />
              </div>
              <div>
                <Label htmlFor="ocppVersion" value="OCPP Version" className="mb-2 logger-label" />
                <Select
                  id="ocppVersion"
                  value={config.ocppVersion}
                  onChange={(e) => updateConfig("ocppVersion", e.target.value)}
                  required
                  className="logger-input"
                >
                  <option value="OCPP-1.6J">OCPP 1.6J</option>
                </Select>
              </div>
              <div className="col-span-2">
                <Label htmlFor="tagIds" value="RFID Tag IDs (comma-separated)" className="mb-2 logger-label" />
                <TextInput
                  id="tagIds"
                  type="text"
                  value={config.tagIds.join(", ")}
                  onChange={(e) => {
                    const tags = e.target.value.split(",").map(s => s.trim()).filter(s => s.length > 0);
                    updateConfig("tagIds", tags.length > 0 ? tags : ["123456"]);
                  }}
                  placeholder="e.g., 123456, ABCDEF, TAG001"
                  className="logger-input"
                />
                <p className="text-xs text-muted mt-1">
                  Enter one or more RFID tag IDs separated by commas. These tags can be used for starting transactions.
                </p>
              </div>
            </div>
          </div>

          {/* Boot Notification */}
          <div className="card p-4">
            <h3 className="card-header mb-4">Boot Notification</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="chargePointVendor" value="Vendor" className="mb-2 logger-label" />
                <TextInput
                  id="chargePointVendor"
                  type="text"
                  value={config.chargePointVendor}
                  onChange={(e) => updateConfig("chargePointVendor", e.target.value)}
                  className="logger-input"
                />
              </div>
              <div>
                <Label htmlFor="chargePointModel" value="Model" className="mb-2 logger-label" />
                <TextInput
                  id="chargePointModel"
                  type="text"
                  value={config.chargePointModel}
                  onChange={(e) => updateConfig("chargePointModel", e.target.value)}
                  className="logger-input"
                />
              </div>
              <div>
                <Label htmlFor="firmwareVersion" value="Firmware Version" className="mb-2 logger-label" />
                <TextInput
                  id="firmwareVersion"
                  type="text"
                  value={config.firmwareVersion}
                  onChange={(e) => updateConfig("firmwareVersion", e.target.value)}
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
                  onChange={(e) => updateConfig("basicAuthEnabled", e.target.checked)}
                />
                <Label htmlFor="basicAuthEnabled" value="Enable Basic Authentication" className="logger-label" />
              </div>
              {config.basicAuthEnabled && (
                <div className="ml-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="basicAuthUsername" value="Username" className="mb-2 logger-label" />
                    <TextInput
                      id="basicAuthUsername"
                      type="text"
                      value={config.basicAuthUsername}
                      onChange={(e) => updateConfig("basicAuthUsername", e.target.value)}
                      className="logger-input"
                    />
                  </div>
                  <div>
                    <Label htmlFor="basicAuthPassword" value="Password" className="mb-2 logger-label" />
                    <TextInput
                      id="basicAuthPassword"
                      type="password"
                      value={config.basicAuthPassword}
                      onChange={(e) => updateConfig("basicAuthPassword", e.target.value)}
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
                  onChange={(e) => updateConfig("autoMeterValueEnabled", e.target.checked)}
                />
                <Label htmlFor="autoMeterValueEnabled" value="Enable Auto Meter Value" className="logger-label" />
              </div>
              {config.autoMeterValueEnabled && (
                <div className="ml-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="autoMeterValueInterval" value="Interval (seconds)" className="mb-2 logger-label" />
                    <TextInput
                      id="autoMeterValueInterval"
                      type="number"
                      min="1"
                      value={config.autoMeterValueInterval}
                      onChange={(e) => updateConfig("autoMeterValueInterval", parseInt(e.target.value))}
                      className="logger-input"
                    />
                  </div>
                  <div>
                    <Label htmlFor="autoMeterValue" value="Increment Value (kWh)" className="mb-2 logger-label" />
                    <TextInput
                      id="autoMeterValue"
                      type="number"
                      min="1"
                      value={config.autoMeterValue}
                      onChange={(e) => updateConfig("autoMeterValue", parseInt(e.target.value))}
                      className="logger-input"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <div className="flex justify-end gap-2 w-full">
          <Button onClick={onClose} className="btn-secondary">
            <HiX className="mr-2 h-5 w-5" />
            Cancel
          </Button>
          <Button onClick={handleSave} className="btn-primary">
            <HiSave className="mr-2 h-5 w-5" />
            Save
          </Button>
        </div>
      </Modal.Footer>
    </Modal>
  );
};

export default ChargePointConfigModal;
