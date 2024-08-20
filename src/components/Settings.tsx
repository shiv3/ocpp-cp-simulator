import React, {useState, useEffect} from "react";
import {configAtom} from "../store/store.ts";
import {useAtom} from "jotai/index";

const Settings: React.FC = () => {
  const [wsURL, setWsURL] = useState<string>("");
  const [connectorNumber, setConnectorNumber] = useState<number>(2);
  const [cpID, setCpID] = useState<string>("");
  const [tagID, setTagID] = useState<string>("");
  const [ocppVersion, setOcppVersion] = useState<string>("OCPP-1.6J");
  const [experimental, setExperimental] = useState<string | null>(null);
  const [config, setConfig] = useAtom(configAtom);


  useEffect(() => {
    if (config) {
      setWsURL(config.wsURL);
      setConnectorNumber(config.connectorNumber);
      setCpID(config.ChargePointID);
      setTagID(config.tagID);
      setOcppVersion(config.ocppVersion);
      setExperimental(config.Experimental ? JSON.stringify(config.Experimental) : null);
    }
  }, [config]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setConfig({
      wsURL,
      connectorNumber,
      ChargePointID: cpID,
      tagID,
      ocppVersion,
      Experimental: experimental !== "" ? experimental && JSON.parse(experimental) : null,
    });
    // navigate(`/${location.hash}`)
  };

  return (
    <div className="bg-white shadow-md rounded px-8 pt-6 pb-8 mb-4">
      <h2 className="text-2xl font-bold mb-6">Settings</h2>
      <form onSubmit={handleSubmit}>
        <div className="mb-4">
          <label
            className="block text-gray-700 text-sm font-bold mb-2"
            htmlFor="WSURL"
          >
            OCPP Server
          </label>
          <input
            className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
            id="WSURL"
            type="text"
            value={wsURL}
            onChange={(e) => setWsURL(e.target.value)}
            placeholder="ws://localhost:8080/steve/websocket/CentralSystemService/"
          />
          <p className="text-gray-600 text-xs italic mt-1">
            The base URL of the OCPP Server (without the ChargePoint ID)
          </p>
        </div>
        <div className="mb-4">
          <label
            className="block text-gray-700 text-sm font-bold mb-2"
            htmlFor="CONNECTORS"
          >
            Number of Connectors
          </label>
          <input
            className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
            id="CONNECTORS"
            type="number"
            value={connectorNumber}
            onChange={(e) => setConnectorNumber(parseInt(e.target.value))}
            placeholder="2"
            style={{maxWidth: "20ch"}}
          />
        </div>

        <div className="mb-4">
          <label
            className="block text-gray-700 text-sm font-bold mb-2"
            htmlFor="CPID"
          >
            ChargePoint ID
          </label>
          <input
            className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
            id="CPID"
            type="text"
            value={cpID}
            onChange={(e) => setCpID(e.target.value)}
            placeholder="CP001"
            style={{maxWidth: "20ch"}}
          />
        </div>

        <div className="mb-4">
          <label
            className="block text-gray-700 text-sm font-bold mb-2"
            htmlFor="TagID"
          >
            RFID Tag ID
          </label>
          <input
            className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
            id="TagID"
            type="text"
            value={tagID}
            onChange={(e) => setTagID(e.target.value)}
            placeholder="XXX"
            style={{maxWidth: "20ch"}}
          />
        </div>

        <div className="mb-4">
          <label
            className="block text-gray-700 text-sm font-bold mb-2"
            htmlFor="OCPP"
          >
            OCPP Version
          </label>
          <select
            className="shadow border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
            id="OCPP"
            value={ocppVersion}
            onChange={(e) => setOcppVersion(e.target.value)}
            style={{maxWidth: "20ch"}}
          >
            <option value="OCPP-1.6J">OCPP-1.6J</option>
          </select>
        </div>
        <div className="mb-4">
          <label
            className="block text-gray-700 text-sm font-bold mb-2"
            htmlFor="Experimental"
          >
            Experimental
          </label>
          <textarea
            className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
            id="Experimental"
            placeholder="Experimental features"
            style={{height: "100px"}}
            value={experimental || ""}
            onChange={(e) => setExperimental(e.target.value)
            }></textarea>
        </div>
        <div className="flex items-center justify-between">
          <button
            className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline"
            type="submit"
          >
            Save
          </button>
        </div>
      </form>
    </div>
  );
};

export default Settings;