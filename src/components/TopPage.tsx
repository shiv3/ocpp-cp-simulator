import React, {useEffect, useState} from "react";
import ChargePoint from "./ChargePoint.tsx";
import {Tabs} from "flowbite-react";
import {ChargePoint as OCPPChargePoint} from "../cp/ChargePoint.ts";
// import {HiStatusOnline, HiStatusOffline} from "react-icons/hi";
import {useAtom} from 'jotai'
import {configAtom} from "../store/store.ts";


const TopPage: React.FC = () => {
  const [cps, setCps] = useState<OCPPChargePoint[]>([]);
  const [connectorNumber, setConnectorNumber] = useState<number>(2);
  const [config] = useAtom(configAtom);

  useEffect(() => {
    console.log(`Connector Number: ${config?.connectorNumber} WSURL: ${config?.wsURL} CPID: ${config?.ChargePointID} TagID: ${config?.tagID}`);

    if (config?.Experimental === null) {
      setConnectorNumber(config?.connectorNumber || 2);
      setCps([NewChargePoint(connectorNumber, config.ChargePointID, config.wsURL)]);
    } else {
      const cps = config?.Experimental?.ChargePointIDs.map((cp) =>
        NewChargePoint(cp.ConnectorNumber, cp.ChargePointID, config.wsURL)
      )
      setCps(cps ?? []);
    }
  }, []);


  return (
    <div className="bg-white shadow-md rounded px-8 pt-6 pb-8 mb-4">
      {
        cps.length === 1 ? (
          <>
            <ChargePoint cp={cps[0]} TagID={config?.tagID ?? ""}/>
          </>
        ) : (
          <>
            <ExperimentalView cps={cps} tagID={config?.tagID ?? ""}/>
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
