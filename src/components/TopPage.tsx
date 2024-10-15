import React, {useEffect, useState} from "react";
import ChargePoint from "./ChargePoint.tsx";
import {Tabs} from "flowbite-react";
import {ChargePoint as OCPPChargePoint} from "../cp/ChargePoint.ts";
// import {HiStatusOnline, HiStatusOffline} from "react-icons/hi";
import {useAtom} from 'jotai'
import {configAtom} from "../store/store.ts";
import {BootNotification, DefaultBootNotification} from "../cp/OcppTypes.ts";
import {useNavigate} from "react-router-dom";

const TopPage: React.FC = () => {
  const [cps, setCps] = useState<OCPPChargePoint[]>([]);
  const [config] = useAtom(configAtom);
  const [tagIDs, setTagIDs] = useState<string[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    if (!config) {
      navigate('/settings');
      return;
    }
    console.log(`Connector Number: ${config.connectorNumber} WSURL: ${config.wsURL} CPID: ${config.ChargePointID} TagID: ${config.tagID}`);
    if (config.Experimental) {
      const cps = config.Experimental.ChargePointIDs.map((cp) =>
          NewChargePoint(cp.ConnectorNumber, cp.ChargePointID, config.BootNotification ?? DefaultBootNotification, config.wsURL, config.basicAuthSettings, config.autoMeterValueSetting)
      )
      setCps(cps ?? []);
      const tagIDs = config.Experimental.TagIDs;
      setTagIDs(tagIDs ?? []);
    } else {
      setCps([
        NewChargePoint(config.connectorNumber, config.ChargePointID, config.BootNotification ?? DefaultBootNotification, config.wsURL, config.basicAuthSettings, config.autoMeterValueSetting)
      ]);
    }
  }, [config, navigate]);

  return (
    <div className="bg-white shadow-md rounded px-8 pt-6 pb-8 mb-4">
      {
        config?.Experimental || cps.length !== 1 ? (
            <>
              <ExperimentalView cps={cps} tagIDs={tagIDs}/>
            </>
        ) : (
            <>
              <ChargePoint cp={cps[0]} TagID={config?.tagID ?? ""}/>
            </>
        )
      }
    </div>
  );
}

interface ExperimentalProps {
  cps: OCPPChargePoint[];
  tagIDs: string[];
}

interface transactionInfo {
  tagID: string;
  transactionID: number;
  cpID: string;
  connectorID: number;
}

const ExperimentalView: React.FC<ExperimentalProps> = ({cps, tagIDs}) => {
  const handleAllConnect = () => {
    console.log("Connecting all charge points");
    const chunk = 100;
    cps.flatMap((_, i, a) => i % chunk ? [] : [a.slice(i, i + chunk)]).forEach((cps) => {
      Promise.all(cps.map((cp) => cp.connect()))
    })
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

  const transactions = [] as transactionInfo[];
  const handleAllStartTransaction = () => {
    for (let i = 0; i < Math.min(tagIDs.length, cps.length); i++) {
      cps[i].setConnectorTransactionIDChangeCallback(1, (transactionId) => {
        transactionId && transactions.push({
          tagID: tagIDs[i],
          transactionID: transactionId,
          cpID: cps[i].id,
          connectorID: 1
        } as transactionInfo);
      })
      cps[i].startTransaction(tagIDs[i], 1);
    }
  }

  const handleAllStopTransaction = () => {
    transactions.forEach((t) => {
      cps.find((cp) => cp.id === t.cpID)?.stopTransaction(t.connectorID);
      // transactions.splice(transactions.indexOf(t), 1);
    })
  }

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
        <div className="bg-gray-100 rounded p-4">
          <label className="block text-gray-700 text-sm font-bold mb-2">Transaction all</label>
          <label className="block text-gray-700 text-sm font-bold mb-2">
            <div>Tag IDs: {tagIDs.join(", ")}</div>
            {/*<div>Transaction IDs: {transactions.map((t) => t.transactionID).join(", ")}</div>*/}
          </label>
          <button
            onClick={handleAllStartTransaction}
            className="bg-green-500 hover:bg-green-700 text-white font-bold py-2 px-4 rounded mb-2
                disabled:bg-green-300
                "
          >
            Start Transaction All
          </button>
          <button
            onClick={handleAllStopTransaction}
            className="bg-orange-500 hover:bg-orange-700 text-white font-bold py-2 px-4 rounded mb-2
                disabled:bg-orange-300
                "
          >
            Stop Transaction All
          </button>
        </div>
      </div>
      <Tabs>
        {
          cps.map((cp, key) => {
            return (
              <Tabs.Item
                className="bg-gray-100 rounded p-4"
                // icon={cp.status === "Available" ? HiStatusOnline : HiStatusOffline}
                key={key} title={cp.id}>
                <ChargePoint cp={cp} TagID={tagIDs[0]}/>
              </Tabs.Item>
            );
          })
        }
      </Tabs>
    </>
  )
}


const NewChargePoint = (ConnectorNumber: number, ChargePointID: string, BootNotification: BootNotification, WSURL: string,
                        basicAuthSettings: { username: string; password: string } | null,
                        autoMeterValueSetting: { interval: number; value: number } | null) => {
  console.log(`Creating new ChargePoint with ID: ${ChargePointID} Connector Number: ${ConnectorNumber} WSURL: ${WSURL}`);
  return new OCPPChargePoint(ChargePointID, BootNotification, ConnectorNumber, WSURL,basicAuthSettings, autoMeterValueSetting);
}

export default TopPage;
