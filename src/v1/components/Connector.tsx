import React, { useState, useEffect } from "react";
import { ChargePoint } from "../cp/ChargePoint.ts";
import * as ocpp from "../cp/OcppTypes";
import { OCPPAvailability } from "../cp/OcppTypes";

interface ConnectorProps {
  id: number;
  cp: ChargePoint | null;
  idTag: string;
}

const Connector: React.FC<ConnectorProps> = ({
  id: connector_id,
  cp,
  idTag,
}) => {
  const [cpTransactionID, setCpTransactionID] = useState<number | null>(0);
  const [connectorStatus, setConnectorStatus] = useState<ocpp.OCPPStatus>(
    ocpp.OCPPStatus.Unavailable,
  );
  const [availability, setAvailability] =
    useState<OCPPAvailability>("Operative");
  const [meterValue, setMeterValue] = useState<number>(0);
  const [tagId, setIdTag] = useState<string>(idTag);

  useEffect(() => {
    if (cp) {
      cp.setConnectorStatusChangeCallback(connector_id, setConnectorStatus);
      cp.setConnectorTransactionIDChangeCallback(
        connector_id,
        setCpTransactionID,
      );
      cp.setConnectorMeterValueChangeCallback(connector_id, setMeterValue);
      cp.setAvailabilityChangeCallback(connector_id, setAvailability);
    }
  }, [connector_id, cp]);

  // Implement connector logic here...
  const handleStatusNotification = () => {
    if (cp) {
      cp.updateConnectorStatus(connector_id, connectorStatus);
    }
  };

  const handleStartTransaction = () => {
    if (cp) {
      cp.startTransaction(tagId, connector_id);
    }
  };

  const handleStopTransaction = () => {
    if (cp) {
      cp.stopTransaction(connector_id);
    }
  };

  const handleIncreaseMeterValue = () => {
    if (cp) {
      setMeterValue(meterValue + 10);
      cp.setMeterValue(connector_id, meterValue);
    }
  };

  const handleSendMeterValue = () => {
    if (cp) {
      setMeterValue(meterValue);
      cp.sendMeterValue(connector_id);
    }
  };

  return (
    <div className="bg-gray-200 p-4 rounded mb-4 border border-gray-400">
      <label className="text-lg font-semibold">Connector {connector_id}</label>
      <div className="d-flex">
        <div className="form-group bg-gray-100 rounded p-4">
          <div className="mb-6">
            <label className="text-gray-700 text-sm font-bold mb-2">
              Connector Status:{" "}
            </label>
            <ConnectorStatus status={connectorStatus} />
          </div>
          {connectorStatus === ocpp.OCPPStatus.Charging && (
            <div className="mb-6">
              <label className="text-gray-700 text-sm font-bold mb-2">
                Transaction ID:{" "}
              </label>
              <span>{cpTransactionID}</span>
            </div>
          )}
          <select
            id={`STATUS_CON${connector_id}`}
            className="bg-white border border-gray-400 rounded px-4 py-2"
            value={connectorStatus}
            onChange={(e) =>
              setConnectorStatus(e.target.value as ocpp.OCPPStatus)
            }
            style={{ maxWidth: "16ch", marginRight: "1ch" }}
          >
            {Object.keys(ocpp.OCPPStatus).map((status) =>
              status === ocpp.OCPPStatus.Charging ? null : (
                <option key={status} value={status}>
                  {status}
                </option>
              ),
            )}
            {/* Add other status options... */}
          </select>
          <button
            onClick={handleStatusNotification}
            className="bg-purple-500 hover:bg-purple-700 text-white font-bold py-2 px-4 rounded mb-2 w-full
            disabled:opacity-50
            "
            disabled={connectorStatus === ocpp.OCPPStatus.Unavailable}
          >
            Status Notification
          </button>
          <div className="d-flex border-b border-gray-400">
            <div className="form-group">
              <label
                className="text-gray-700 text-sm font-bold mb-2"
                htmlFor={`AVAILABILITY_CON${connector_id}`}
              >
                Connector Availability:
              </label>
              <ConnectorAvailability availability={availability} />
              {/*<select
                <select
                  id={`AVAILABILITY_CON${connector_id}`}
                  className="bg-white border border-gray-400 rounded px-4 py-2"
                  value={availability}
                  onChange={(e) => setAvailability(e.target.value)}
                  style={{maxWidth: "16ch", marginRight: "1ch"}}
                >
                  <option value={ocpp.AVAILABITY_OPERATIVE}>Operative</option>
                  <option value={ocpp.AVAILABITY_INOPERATIVE}>Inoperative</option>
                </select>
                  */}
            </div>
          </div>
        </div>
        <div className="form-group bg-gray-100 rounded p-4">
          <div className="mb-1">
            <label className="text-gray-700 text-sm font-bold mb-2">
              RFID Tag
            </label>
            <input
              className="shadow appearance-none border rounded w-full py-1 px-1 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
              type="text"
              value={tagId}
              onChange={(e) => setIdTag(e.target.value)}
              placeholder="DEADBEEF"
              style={{ maxWidth: "20ch" }}
            />
          </div>
        </div>
        <button
          onClick={handleStartTransaction}
          className="bg-yellow-500 hover:bg-yellow-700 text-white font-bold py-2 px-4 rounded mb-2 w-full
          disabled:opacity-50"
          disabled={connectorStatus !== ocpp.OCPPStatus.Available}
        >
          Start Transaction
        </button>
        <div>
          <div className="flex mb-2">
            <input
              type="number"
              value={meterValue}
              onChange={(e) => setMeterValue(Number(e.target.value))}
              className="shadow appearance-none border rounded w-1/2 py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
            />
            <button
              onClick={handleIncreaseMeterValue}
              className="bg-gray-500 hover:bg-gray-700 text-white font-bold py-2 px-4 rounded ml-2
            disabled:opacity-50"
            >
              +
            </button>
          </div>
          <button
            onClick={handleSendMeterValue}
            className="bg-indigo-500 hover:bg-indigo-700 text-white font-bold py-2 px-4 rounded w-full
          disabled:opacity-50"
            disabled={connectorStatus !== ocpp.OCPPStatus.Charging}
          >
            Send Meter Value
          </button>
        </div>
        {/*<div className="form-group bg-gray-100 rounded p-4">*/}
        {/*  <div className="flex mb-2">*/}
        {/*    transactionId:*/}
        {/*    <input type="number" value={tmpTransacitonId}*/}
        {/*           onChange={(e) => setTmpTransactionId(Number(e.target.value))}/>*/}
        {/*  </div>*/}
        {/*  <button*/}
        {/*    className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded mb-2 w-full"*/}
        {/*    onClick={handleTempTransactionId}>Set Temp Transaction ID</button>*/}
        {/*</div>*/}
        <button
          onClick={handleStopTransaction}
          className="bg-orange-500 hover:bg-orange-700 text-white font-bold py-2 px-4 rounded mb-2 w-full
          disabled:opacity-50"
          disabled={connectorStatus !== ocpp.OCPPStatus.Charging}
        >
          Stop Transaction
        </button>
      </div>
    </div>
  );
};

const ConnectorStatus: React.FC<{ status: string }> = ({ status }) => {
  const statusColor = (s: string) => {
    switch (s) {
      case ocpp.OCPPStatus.Unavailable:
        return "text-red-500";
      case ocpp.OCPPStatus.Available:
        return "text-yellow-500";
      case ocpp.OCPPStatus.Preparing:
        return "text-blue-500";
      case ocpp.OCPPStatus.Charging:
        return "text-purple-500";
      case ocpp.OCPPStatus.Faulted:
        return "text-red-500";
      default:
        return "text-black";
    }
  };

  return <span className={statusColor(status)}>{status}</span>;
};

const ConnectorAvailability: React.FC<{ availability: OCPPAvailability }> = ({
  availability,
}) => {
  const availabilityColor = (a: OCPPAvailability) => {
    switch (a) {
      case "Operative":
        return "text-green-500";
      case "Inoperative":
        return "text-red-500";
      default:
        return "text-black";
    }
  };

  return (
    <span className={availabilityColor(availability)}>{availability}</span>
  );
};

export default Connector;
