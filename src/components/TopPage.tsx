import React, { useEffect, useState } from "react";
import ChargePoint from "./ChargePoint.tsx";
import { Tabs, Button } from "flowbite-react";
import { ChargePoint as OCPPChargePoint } from "../cp/ChargePoint.ts";
import { useAtom } from "jotai";
import { configAtom } from "../store/store.ts";
import { BootNotification, DefaultBootNotification } from "../cp/OcppTypes.ts";
import { useNavigate } from "react-router-dom";
import ChargePointConfigModal, { ChargePointConfig, defaultChargePointConfig } from "./ChargePointConfigModal.tsx";
import { HiPlus, HiCog, HiTrash } from "react-icons/hi";
import { loadConnectorAutoMeterConfig } from "../utils/connectorStorage";

const TopPage: React.FC = () => {
  const [cps, setCps] = useState<OCPPChargePoint[]>([]);
  const [config, setConfig] = useAtom(configAtom);
  const [tagIDs, setTagIDs] = useState<string[]>([]);
  const [chargePointConfigs, setChargePointConfigs] = useState<ChargePointConfig[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!config || !config.Experimental) {
      // No config yet, just show empty state
      setCps([]);
      setTagIDs([]);
      setChargePointConfigs([]);
      return;
    }

    // Check if we need to create new ChargePoints or update existing ones
    setCps((prevCps) => {
      const newCpIds = config.Experimental.ChargePointIDs.map((cp) => cp.ChargePointID);
      const existingCpIds = prevCps.map((cp) => cp.id);

      // If the ChargePoint IDs haven't changed, keep existing instances
      const sameIds =
        newCpIds.length === existingCpIds.length &&
        newCpIds.every((id, index) => id === existingCpIds[index]);

      if (sameIds) {
        // Keep existing ChargePoint instances to preserve event listeners
        return prevCps;
      }

      // Create new ChargePoints only if IDs changed
      return config.Experimental.ChargePointIDs.map((cp) =>
        NewChargePoint(
          cp.ConnectorNumber,
          cp.ChargePointID,
          config.BootNotification ?? DefaultBootNotification,
          config.wsURL,
          config.basicAuthSettings,
          config.autoMeterValueSetting,
        ),
      );
    });

    setTagIDs(config.Experimental.TagIDs ?? []);

    // Extract configs for modal editing
    const configs: ChargePointConfig[] = config.Experimental.ChargePointIDs.map((cp) => ({
      cpId: cp.ChargePointID,
      connectorNumber: cp.ConnectorNumber,
      wsURL: config.wsURL,
      ocppVersion: config.ocppVersion,
      basicAuthEnabled: config.basicAuthSettings?.enabled || false,
      basicAuthUsername: config.basicAuthSettings?.username || "",
      basicAuthPassword: config.basicAuthSettings?.password || "",
      autoMeterValueEnabled: config.autoMeterValueSetting?.enabled || false,
      autoMeterValueInterval: config.autoMeterValueSetting?.interval || 30,
      autoMeterValue: config.autoMeterValueSetting?.value || 10,
      chargePointVendor: config.BootNotification?.chargePointVendor || "Vendor",
      chargePointModel: config.BootNotification?.chargePointModel || "Model",
      firmwareVersion: config.BootNotification?.firmwareVersion || "1.0",
      chargeBoxSerialNumber: config.BootNotification?.chargeBoxSerialNumber || "",
      chargePointSerialNumber: config.BootNotification?.chargePointSerialNumber || "",
      meterSerialNumber: config.BootNotification?.meterSerialNumber || "",
      meterType: config.BootNotification?.meterType || "",
      iccid: config.BootNotification?.iccid || "",
      imsi: config.BootNotification?.imsi || "",
      tagIds: config.Experimental.TagIDs ?? ["123456"],
    }));
    setChargePointConfigs(configs);
  }, [config]);

  const handleAddChargePoint = () => {
    setEditingIndex(null);
    setIsModalOpen(true);
  };

  const handleEditChargePoint = (index: number) => {
    setEditingIndex(index);
    setIsModalOpen(true);
  };

  const handleSaveChargePoint = (cpConfig: ChargePointConfig) => {
    const updatedConfigs = [...chargePointConfigs];

    if (editingIndex !== null) {
      // Edit existing
      updatedConfigs[editingIndex] = cpConfig;
    } else {
      // Add new
      updatedConfigs.push(cpConfig);
    }

    setChargePointConfigs(updatedConfigs);

    // Update tagIDs state from config
    setTagIDs(cpConfig.tagIds);

    // Update or create global config
    const newConfig = {
      ...(config || {}),
      wsURL: cpConfig.wsURL,
      connectorNumber: cpConfig.connectorNumber,
      ChargePointID: cpConfig.cpId,
      tagID: cpConfig.tagIds[0] || "123456",
      ocppVersion: cpConfig.ocppVersion,
      basicAuthSettings: {
        enabled: cpConfig.basicAuthEnabled,
        username: cpConfig.basicAuthUsername,
        password: cpConfig.basicAuthPassword,
      },
      autoMeterValueSetting: {
        enabled: cpConfig.autoMeterValueEnabled,
        interval: cpConfig.autoMeterValueInterval,
        value: cpConfig.autoMeterValue,
      },
      BootNotification: {
        chargePointVendor: cpConfig.chargePointVendor,
        chargePointModel: cpConfig.chargePointModel,
        firmwareVersion: cpConfig.firmwareVersion,
        chargeBoxSerialNumber: cpConfig.chargeBoxSerialNumber,
        chargePointSerialNumber: cpConfig.chargePointSerialNumber,
        meterSerialNumber: cpConfig.meterSerialNumber,
        meterType: cpConfig.meterType,
        iccid: cpConfig.iccid,
        imsi: cpConfig.imsi,
      },
      Experimental: {
        ChargePointIDs: updatedConfigs.map((cfg) => ({
          ChargePointID: cfg.cpId,
          ConnectorNumber: cfg.connectorNumber,
        })),
        TagIDs: cpConfig.tagIds,
      },
    };
    setConfig(newConfig);
  };

  const handleDeleteChargePoint = (index: number) => {
    const updatedConfigs = [...chargePointConfigs];
    updatedConfigs.splice(index, 1);
    setChargePointConfigs(updatedConfigs);

    if (updatedConfigs.length === 0) {
      // If no charge points left, clear config
      setConfig(null);
      setCps([]);
      return;
    }

    // Update global config
    const newConfig = {
      ...(config || {}),
      Experimental: {
        ChargePointIDs: updatedConfigs.map((cfg) => ({
          ChargePointID: cfg.cpId,
          ConnectorNumber: cfg.connectorNumber,
        })),
        TagIDs: tagIDs.length > 0 ? tagIDs : ["123456"],
      },
    };
    setConfig(newConfig);
  };

  return (
    <div className="px-8 pt-6 pb-8 mb-4">
      <ExperimentalView
        cps={cps}
        tagIDs={tagIDs}
        onAddChargePoint={handleAddChargePoint}
        onEditChargePoint={handleEditChargePoint}
        onDeleteChargePoint={handleDeleteChargePoint}
      />

      <ChargePointConfigModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSave={handleSaveChargePoint}
        initialConfig={editingIndex !== null ? chargePointConfigs[editingIndex] : defaultChargePointConfig}
        isNewChargePoint={editingIndex === null}
      />
    </div>
  );
};

interface ExperimentalProps {
  cps: OCPPChargePoint[];
  tagIDs: string[];
  onAddChargePoint: () => void;
  onEditChargePoint: (index: number) => void;
  onDeleteChargePoint: (index: number) => void;
}

interface transactionInfo {
  tagID: string;
  transactionID: number;
  cpID: string;
  connectorID: number;
}

const ExperimentalView: React.FC<ExperimentalProps> = ({ cps, tagIDs, onAddChargePoint, onEditChargePoint, onDeleteChargePoint }) => {
  const handleAllConnect = () => {
    console.log("Connecting all charge points");
    const chunk = 100;
    cps
      .flatMap((_, i, a) => (i % chunk ? [] : [a.slice(i, i + chunk)]))
      .forEach((cps) => {
        Promise.all(cps.map((cp) => cp.connect()));
      });
  };

  const handleAllDisconnect = () => {
    console.log("Disconnecting all charge points");
    cps.forEach((cp) => {
      cp.disconnect();
    });
  };

  const handleAllHeartbeat = () => {
    console.log("Sending heartbeat to all charge points");
    cps.forEach((cp) => {
      cp.sendHeartbeat();
    });
  };

  const [isAllHeartbeatEnabled, setIsAllHeartbeatEnabled] =
    useState<boolean>(false);

  const handleAllHeartbeatInterval = (isEnalbe: boolean) => {
    setIsAllHeartbeatEnabled(isEnalbe);
    if (isEnalbe) {
      cps.forEach((cp) => {
        cp.startHeartbeat(10);
      });
    } else {
      cps.forEach((cp) => {
        cp.stopHeartbeat();
      });
    }
  };

  const transactions = [] as transactionInfo[];
  const handleAllStartTransaction = () => {
    for (let i = 0; i < Math.min(tagIDs.length, cps.length); i++) {
      cps[i].setConnectorTransactionIDChangeCallback(1, (transactionId) => {
        transactionId &&
          transactions.push({
            tagID: tagIDs[i],
            transactionID: transactionId,
            cpID: cps[i].id,
            connectorID: 1,
          } as transactionInfo);
      });
      cps[i].startTransaction(tagIDs[i], 1);
    }
  };

  const handleAllStopTransaction = () => {
    transactions.forEach((t) => {
      cps.find((cp) => cp.id === t.cpID)?.stopTransaction(t.connectorID);
      // transactions.splice(transactions.indexOf(t), 1);
    });
  };

  return (
    <>
      {cps.length >= 2 && (
        <>
          <div className="flex flex-wrap gap-2 mb-3">
            <button onClick={handleAllConnect} className="btn-primary">
              Connect All
            </button>
            <button onClick={handleAllDisconnect} className="btn-danger">
              Disconnect All
            </button>
            <button onClick={handleAllHeartbeat} className="btn-info">
              Heartbeat All
            </button>
            <button
              className={isAllHeartbeatEnabled ? "btn-danger" : "btn-success"}
              onClick={() => handleAllHeartbeatInterval(!isAllHeartbeatEnabled)}
            >
              {isAllHeartbeatEnabled ? "Disable" : "Enable"} Heartbeat All
            </button>
          </div>

          <div className="panel mb-3 p-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-primary text-sm font-bold">Transaction All</span>
                <span className="text-secondary text-xs ml-3">Tag IDs: {tagIDs.join(", ")}</span>
              </div>
              <div className="flex gap-2">
                <button onClick={handleAllStartTransaction} className="btn-success">
                  Start Transaction All
                </button>
                <button onClick={handleAllStopTransaction} className="btn-warning">
                  Stop Transaction All
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      <Tabs aria-label="Charge Points">
        {cps.map((cp, key) => {
          return (
            <Tabs.Item
              key={key}
              title={
                <div className="flex items-center gap-2">
                  <span>{cp.id}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onEditChargePoint(key);
                    }}
                    className="p-1 rounded"
                    title="Edit Charge Point"
                  >
                    <HiCog className="h-4 w-4" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Are you sure you want to delete ${cp.id}?`)) {
                        onDeleteChargePoint(key);
                      }
                    }}
                    className="p-1 hover:bg-red-200 dark:hover:bg-red-600 rounded text-red-600 dark:text-red-400"
                    title="Delete Charge Point"
                  >
                    <HiTrash className="h-4 w-4" />
                  </button>
                </div>
              }
            >
              <ChargePoint cp={cp} TagID={tagIDs[0]} />
            </Tabs.Item>
          );
        })}
        <Tabs.Item
          title={
            <div
              onClick={onAddChargePoint}
              className="p-1 hover:bg-gray-200 dark:hover:bg-gray-600 rounded flex items-center cursor-pointer"
              title="Add Charge Point"
            >
              <HiPlus className="h-5 w-5" />
            </div>
          }
        >
          {/* Empty content - this tab is just for the + button */}
          <div className="p-4 text-center text-secondary">
            Click the + button to add a new charge point
          </div>
        </Tabs.Item>
      </Tabs>
    </>
  );
};

const NewChargePoint = (
  ConnectorNumber: number,
  ChargePointID: string,
  BootNotification: BootNotification,
  WSURL: string,
  basicAuthSettings: { username: string; password: string } | null,
  autoMeterValueSetting: { interval: number; value: number } | null,
) => {
  console.log(
    `Creating new ChargePoint with ID: ${ChargePointID} Connector Number: ${ConnectorNumber} WSURL: ${WSURL}`,
  );
  const chargePoint = new OCPPChargePoint(
    ChargePointID,
    BootNotification,
    ConnectorNumber,
    WSURL,
    basicAuthSettings,
    autoMeterValueSetting,
  );

  // Load auto MeterValue config from localStorage for each connector
  for (let i = 1; i <= ConnectorNumber; i++) {
    const savedConfig = loadConnectorAutoMeterConfig(ChargePointID, i);
    if (savedConfig) {
      const connector = chargePoint.getConnector(i);
      if (connector) {
        connector.autoMeterValueConfig = savedConfig;
      }
    }
  }

  return chargePoint;
};

export default TopPage;
