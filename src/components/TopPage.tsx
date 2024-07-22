import {useLocation} from "react-router-dom";
import React, {useEffect, useState} from "react";
import ChargePoint from "./ChargePoint.tsx";
import {Tabs} from "flowbite-react";
import {ChargePoint as OCPPChargePoint} from "../cp/ChargePoint.ts";
// import {HiStatusOnline, HiStatusOffline} from "react-icons/hi";


interface ExperimentalChargePoint {
  ChargePointID: string;
  ConnectorNumber: number;
}

interface Experimental {
  ChargePointIDs: ExperimentalChargePoint[];
  // TagIDs: string[];
}

const TopPage: React.FC = () => {
  const [cps, setCps] = useState<OCPPChargePoint[]>([]);
  const [connectorNumber, setConnectorNumber] = useState<number>(2);
  const [tagID, setTagID] = useState<string>("");


  const search = useLocation().search;
  const query = new URLSearchParams(search);

  useEffect(() => {
    const cn = parseInt(query.get("connectors") || localStorage.getItem("CONNECTORS") || "2");
    const wsurl = query.get("wsurl") || localStorage.getItem("WSURL") || "";
    const cpID = query.get("cpid") || localStorage.getItem("CPID") || "CP-001";
    const tagID = query.get("tag") || localStorage.getItem("TAG") || "DEADBEEF";
    const ex = query.get("experimental") || localStorage.getItem("EXPERIMENTAL") || null;
    const experimental = ex ? JSON.parse(atob(ex)) as Experimental : null;

    console.log(`Connector Number: ${cn} WSURL: ${wsurl} CPID: ${cpID} TagID: ${tagID}`);
    localStorage.setItem("WSURL", wsurl);
    localStorage.setItem("CONNECTORS", cn.toString());
    localStorage.setItem("CPID", cpID);
    localStorage.setItem("TAG", tagID);

    if (experimental === null) {
      setConnectorNumber(parseInt(localStorage.getItem("CONNECTORS") || "2"));
      setTagID(localStorage.getItem("TAG") || "");
      setCps([NewChargePoint(connectorNumber, cpID, wsurl)]);
    } else {
      const cps = experimental?.ChargePointIDs.map((cp) =>
        NewChargePoint(cp.ConnectorNumber, cp.ChargePointID, wsurl)
      )
      setCps(cps ?? []);
    }
  }, []);


  return (
    <div className="bg-white shadow-md rounded px-8 pt-6 pb-8 mb-4">
      {
        cps.length === 1 ? (
          <>
            <ChargePoint cp={cps[0]} TagID={tagID}/>
          </>
        ) : (
          <>
            <ExperimentalView cps={cps} tagID={tagID}/>
          </>
        )
      }
    </div>
  );
}

interface ExperimentalProps {
  cps: OCPPChargePoint[];
  tagID: string;
}

const ExperimentalView: React.FC<ExperimentalProps> = ({cps, tagID}) => {
  const handleAllConnect = () => {
    console.log("Connecting all charge points");
    cps.forEach((cp) => {
      cp.connect();
    });
  }

  const handleAllDisconnect = () => {
    console.log("Disconnecting all charge points");
    cps.forEach((cp) => {
      cp.disconnect();
    });
  }

  const handleAllHeartbeat = () => {
    console.log("Sending heartbeat to all charge points");
    cps.forEach((cp) => {
      cp.sendHeartbeat();
    });
  };

  const [isAllHeartbeatEnabled, setIsAllHeartbeatEnabled] = useState<boolean>(false);
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

  return (
    <>
      <div>
        <label className="block text-gray-700 text-sm font-bold mb-2">experimental feature is on</label>
        <button
          onClick={handleAllConnect}
          className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded mb-2
                disabled:bg-blue-300
                "
          // disabled={cps.some((cp) => cp.status === "Available")}
        >
          Connect All
        </button>
        <button
          onClick={handleAllDisconnect}
          className="bg-red-500 hover:bg-red-700 text-white font-bold py-2 px-4 rounded mb-2
                disabled:bg-red-300
                "
          // disabled={cps.every((cp) => cp.status === "Available")}
        >
          Disconnect All
        </button>
        <button
          onClick={handleAllHeartbeat}
          className="bg-purple-500 hover:bg-purple-700 text-white font-bold py-2 px-4 rounded mb-2
            disabled:bg-purple-300"
        >
          Heartbeat All
        </button>
        <button
          className={`bg-${
            isAllHeartbeatEnabled ? "red" : "green"
          }-500 hover:bg-${
            isAllHeartbeatEnabled ? "red" : "green"
          }-700 text-white font-bold py-2 px-4 rounded mb-2`}
          onClick={() => handleAllHeartbeatInterval(!isAllHeartbeatEnabled)}
        >
          {isAllHeartbeatEnabled ? "Disable" : "Enable"} Heartbeat All
        </button>
      </div>
      <Tabs>
        {
          cps.map((cp, key) => {
            return (
              <Tabs.Item
                className="bg-gray-100 rounded p-4"
                // icon={cp.status === "Available" ? HiStatusOnline : HiStatusOffline}
                key={key} title={cp.id}>
                <ChargePoint cp={cp} TagID={tagID}/>
              </Tabs.Item>
            );
          })
        }
      </Tabs>
    </>
  )
}


const NewChargePoint = (ConnectorNumber: number, ChargePointID: string, WSURL: string,) => {
  console.log(`Creating new ChargePoint with ID: ${ChargePointID} Connector Number: ${ConnectorNumber} WSURL: ${WSURL}`);
  return new OCPPChargePoint(ChargePointID, ConnectorNumber, WSURL);
}

export default TopPage;
