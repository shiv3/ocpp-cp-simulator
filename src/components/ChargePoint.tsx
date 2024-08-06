import React, {useState, useEffect} from "react";
import {ChargePoint as OCPPChargePoint} from "../cp/ChargePoint";
import Connector from "./Connector.tsx";
import Logger from "./Logger.tsx";
import * as ocpp from "../cp/OcppTypes";

interface ChargePointProps {
  cp : OCPPChargePoint;
  TagID: string;
}

const ChargePoint: React.FC<ChargePointProps> = (props) => {
  const [cp, setCp] = useState<OCPPChargePoint | null>(null);
  const [cpStatus, setCpStatus] = useState<string>(ocpp.OCPPStatus.Unavailable);
  const [cpError, setCpError] = useState<string>("");
  const [logs , setLogs] = useState<string[]>([]);

  useEffect(() => {
    console.log("ChargePointProps", props);
    props.cp.statusChangeCallback = statusChangeCb;
    props.cp.loggingCallback = logMsg;
    props.cp.errorCallback = setCpError;
    setCp(props.cp);
  }, [props]);

  const statusChangeCb = (s: string) => {
    setCpStatus(s);
  };

  const logMsg = (msg: string) => {
    console.log(msg);
    setLogs((prevLogs) => [...prevLogs, msg]);
  };

  return (
    <div className="bg-white shadow-md rounded px-2 pt-2 pb-1 h-screen">
      <SettingsView {...props}/>
      <div className="flex flex-col md:flex-row">
        <ChargePointControls cp={cp} cpStatus={cpStatus} cpError={cpError}/>
        <div className="flex-1">
          <AuthView cp={cp} cpStatus={cpStatus} tagID={props.TagID}/>
          <div className="flex flex-col md:flex-row mt-4">
            {cp?.connectors &&
              Array.from(Array(cp.connectors.size).keys()).map((i) => (
                <Connector key={i + 1} id={i + 1} cp={cp} idTag={props.TagID}/>
              ))}
          </div>
        </div>
      </div>
      <Logger logs={logs}/>
    </div>
  );
};

const CPStatus: React.FC<{ status: string }> = ({status}) => {
  const statusColor = (s: string) => {
    switch (s) {
      case ocpp.OCPPStatus.Unavailable:
        return "text-black";
      case ocpp.OCPPStatus.Available:
        return "text-green-500";
      case ocpp.OCPPStatus.Charging:
        return "text-blue-500";
      default:
        return "text-red-500";
    }
  };
  return (
    <div className="bg-gray-100 rounded p-4 mr-4 border border-gray-400">
      <label className="block text-lg font-semibold">CP Status</label>
      <p className="text-2xl font-bold text-center">
        <span className={statusColor(status)}>{status}</span>
      </p>
    </div>
  );
};

interface AuthViewProps {
  cp: OCPPChargePoint | null;
  cpStatus: string;
  tagID: string;
}

const AuthView: React.FC<AuthViewProps> = (props) => {
  const [tagID, setTagID] = useState<string>(props.tagID);

  const handleAuthorize = () => {
    if (props.cp) {
      props.cp.authorize(tagID);
    }
  };

  return (
    <div className="bg-gray-100 rounded p-4">
      <div className="mb-6">
        <label
          className="block text-gray-700 text-sm font-bold mb-2"
          htmlFor="TAG"
        >
          {" "}
          RFID Tag
        </label>
        <input
          className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
          id="TAG"
          type="text"
          value={tagID}
          onChange={(e) => setTagID(e.target.value)}
          placeholder="DEADBEEF"
          style={{maxWidth: "20ch"}}
        />
        <p className="text-gray-600 text-xs italic mt-1">
          The ID of the simulated RFID tag
        </p>
      </div>
      <button
        onClick={handleAuthorize}
        className="bg-green-500 hover:bg-green-700 text-white font-bold py-2 px-4 rounded
              disabled:bg-green-300
              "
        disabled={props.cpStatus !== ocpp.OCPPStatus.Available}
      >
        Authorize
      </button>
    </div>
  );
};

interface ChargePointControlsProps {
  cp: OCPPChargePoint | null;
  cpStatus: string;
  cpError: string;
}

const ChargePointControls: React.FC<ChargePointControlsProps> = ({
                                                                   cp,
                                                                   cpStatus,
                                                                   cpError,
                                                                 }) => {
  const [isHeartbeatEnabled, setIsHeartbeatEnabled] = useState<boolean>(false);

  const handleConnect = () => {
    if (cp) {
      cp.connect();
    }
  };

  const handleDisconnect = () => {
    if (cp) {
      cp.disconnect();
    }
  };
  const handleHeartbeat = () => {
    if (cp) {
      cp.sendHeartbeat();
    }
  };

  const handleHeartbeatInterval = (isEnalbe: boolean) => {
    setIsHeartbeatEnabled(isEnalbe);
    if (cp) {
      if (isEnalbe) {
        cp.startHeartbeat(10);
      } else {
        cp.stopHeartbeat();
      }
    }
  };
  return (
    <div className="bg-gray-100 rounded p-4 mr-4">
      <div className="bg-gray-100 rounded p-4 mr-4">
        <CPStatus status={cpStatus}/>
      </div>
      <div>
        {cpError !== "" && (
          <div className="bg-red-500 text-white p-2 rounded mb-2">
            Error: {cpError}
          </div>
        )}
      </div>
      <button
        onClick={handleConnect}
        className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded mb-2 w-full
            disabled:bg-blue-300
            "
        disabled={cpStatus !== ocpp.OCPPStatus.Unavailable}
      >
        Connect
      </button>
      <button
        onClick={handleDisconnect}
        className="bg-red-500 hover:bg-red-700 text-white font-bold py-2 px-4 rounded mb-2 w-full
            disabled:bg-red-300
            "
        disabled={cpStatus === ocpp.OCPPStatus.Unavailable}
      >
        Disconnect
      </button>
      <div className="bg-gray-100 rounded p-4">
        <button
          onClick={handleHeartbeat}
          className="bg-purple-500 hover:bg-purple-700 text-white font-bold py-2 px-4 rounded mb-2 w-full
            disabled:bg-purple-300
            "
          disabled={cpStatus === ocpp.OCPPStatus.Unavailable}
        >
          Heartbeat
        </button>
        <div className="flex items-center">
          <button
            className={`bg-${
              isHeartbeatEnabled ? "red" : "green"
            }-500 hover:bg-${
              isHeartbeatEnabled ? "red" : "green"
            }-700 text-white font-bold py-2 px-4 rounded mb-2 w-full`}
            onClick={() => handleHeartbeatInterval(!isHeartbeatEnabled)}
          >
            {isHeartbeatEnabled ? "Disable" : "Enable"} Heartbeat
          </button>
        </div>
      </div>
    </div>
  );
};

const SettingsView: React.FC<ChargePointProps> = (props) => {
  return (
    <div className="mb-1 bg-gray-100 rounded p-2">
      <p className="text-lg font-semibold">settings</p>
      <li>CPID: {props.cp.id}</li>
      <li>CONNECTORS: {props.cp.connectorNumber}</li>
      <li>WSURL: {props.cp.wsUrl}</li>
    </div>
  );
};

export default ChargePoint;
