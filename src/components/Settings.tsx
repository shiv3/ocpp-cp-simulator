import React, {useState, useEffect} from "react";
import {configAtom} from "../store/store.ts";
import {useAtom} from "jotai/index";
import {DefaultBootNotification} from "../cp/OcppTypes.ts";
import {useNavigate} from "react-router-dom";

const Settings: React.FC = () => {
  const [wsURL, setWsURL] = useState<string>("");
  const [connectorNumber, setConnectorNumber] = useState<number>(2);
  const [cpID, setCpID] = useState<string>("");
  const [tagID, setTagID] = useState<string>("");
  const [ocppVersion, setOcppVersion] = useState<string>("OCPP-1.6J");

  const [basicAuthEnabled, setBasicAuthEnabled] = useState<boolean>(false);
  const [basicAuthUsername, setBasicAuthUsername] = useState<string>("");
  const [basicAuthPassword, setBasicAuthPassword] = useState<string>("");

  const [autoMeterValueEnabled, setAutoMeterValueEnabled] = useState<boolean>(false);
  const [autoMeterValueInterval, setAutoMeterValueInterval] = useState<number>(0);
  const [autoMeterValue, setAutoMeterValue] = useState<number>(0);

  const [experimental, setExperimental] = useState<string | null>(null);
  const [bootNotification, setBootNotification] = useState<string | null>(JSON.stringify(DefaultBootNotification));
  const [config, setConfig] = useAtom(configAtom);
  const navigate = useNavigate();

  useEffect(() => {
    if (config) {
      setWsURL(config.wsURL);
      setConnectorNumber(config.connectorNumber);
      setCpID(config.ChargePointID);
      setTagID(config.tagID);
      setOcppVersion(config.ocppVersion);

      setBasicAuthEnabled(config.basicAuthSettings?.enabled);
      setBasicAuthUsername(config.basicAuthSettings?.username);
      setBasicAuthPassword(config.basicAuthSettings?.password);

      setAutoMeterValueEnabled(config.autoMeterValueSetting?.enabled);
      setAutoMeterValueInterval(config.autoMeterValueSetting?.interval);
      setAutoMeterValue(config.autoMeterValueSetting?.value);

      setExperimental(config.Experimental ? JSON.stringify(config.Experimental) : null);
      setBootNotification(config.BootNotification ? JSON.stringify(config.BootNotification) : null);
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
      basicAuthSettings: {
        enabled: basicAuthEnabled,
        username: basicAuthUsername,
        password: basicAuthPassword,
      },
      autoMeterValueSetting: {
        enabled: autoMeterValueEnabled,
        interval: autoMeterValueInterval,
        value: autoMeterValue
      },
      Experimental: experimental && experimental !== "" ? JSON.parse(experimental) : null,
      BootNotification: bootNotification && bootNotification !== "" ? JSON.parse(bootNotification) : null,
    } as Config);
    navigate("/");
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
          <input
            className="shadow border rounded w-fit py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
            id="BasicAuth"
            type="checkbox"
            checked={basicAuthEnabled}
            onChange={(e) => {
              setBasicAuthEnabled(e.target.checked)
              if(!e.target.checked) {
                setBasicAuthUsername("")
                setBasicAuthPassword("")
              }
            }}
          />
          <label className="text-gray-700 text-sm font-bold ml-2" htmlFor="BasicAuth">
            BasicAuth Settings
          </label>
          {basicAuthEnabled && (
            <div className="flex items-center">
              <input
                className="shadow appearance-none border rounded w-1/3 py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
                id="BasicAuthUsername"
                type="text"
                value={basicAuthUsername}
                onChange={(e) => setBasicAuthUsername(e.target.value)}
                placeholder="username"
                style={{maxWidth: "20ch"}}
                required
              />
              <input
                className="shadow appearance-none border rounded w-1/3 py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
                id="BasicAuthPassword"
                type="text"
                value={basicAuthPassword}
                onChange={(e) => setBasicAuthPassword(e.target.value)}
                placeholder="password"
                style={{maxWidth: "20ch"}}
                required
              />
            </div>
          )}
        </div>

        <div className="mb-4">
          <input
            className="shadow border rounded w-fit py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
            id="AutoMeterValue"
            type="checkbox"
            checked={autoMeterValueEnabled}
            onChange={(e) => {
              setAutoMeterValueEnabled(e.target.checked)
              if(!e.target.checked) {
                setAutoMeterValueInterval(0)
                setAutoMeterValue(0)
              }
            }}
          />
          <label className="text-gray-700 text-sm font-bold ml-2" htmlFor="AutoMeterValue">
            Auto Meter Value
          </label>
          {autoMeterValueEnabled && (
            <div className="flex items-center">
              <input
                className="shadow appearance-none border rounded w-1/3 py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
                id="AutoMeterValueInterval"
                type="number"
                value={autoMeterValueInterval}
                onChange={(e) => setAutoMeterValueInterval(parseInt(e.target.value))}
                placeholder="30"
                style={{maxWidth: "20ch"}}
                required
              />
              <span className="text-gray-700 text-sm font-bold ml-2">seconds</span>

              <input
                className="shadow appearance-none border rounded w-1/3 py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
                id="AutoMeterValue"
                type="number"
                value={autoMeterValue}
                onChange={(e) => setAutoMeterValue(parseInt(e.target.value))}
                placeholder="10"
                style={{maxWidth: "20ch"}}
                required
              />
              <span className="text-gray-700 text-sm font-bold ml-2">kWh</span>
            </div>
          )}
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
            placeholder="{
            &quot;ChargePointIDs&quot;: [
            {
            &quot;ChargePointID&quot;: &quot;CP001&quot;,
            &quot;ConnectorNumber&quot;: 1
            }
            ],
            &quot;TagIDs&quot;: [
            &quot;123456&quot;
            ]
            }"
            style={{height: "100px"}}
            value={experimental || ""}
            onChange={(e) => setExperimental(e.target.value)
            }></textarea>
        </div>
        <div className="mb-4">
          <label
            className="block text-gray-700 text-sm font-bold mb-2"
            htmlFor="BootNotification"
          >
            Boot Notification
          </label>
          <textarea
            className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
            id="BootNotification"
            placeholder="{
            &quot;ChargeBoxSerialNumber&quot;: &quot;123456&quot;,
            &quot;ChargePointModel&quot;: &quot;Model 3&quot;,
            &quot;ChargePointSerialNumber&quot;: &quot;123456&quot;,
            &quot;ChargePointVendor&quot;: &quot;Vendor&quot;,
            &quot;FirmwareVersion&quot;: &quot;1.0.0&quot;,
            &quot;Iccid&quot;: &quot;123456&quot;,
            &quot;Imsi&quot;: &quot;123456&quot;,
            &quot;MeterSerialNumber&quot;: &quot;123456&quot;,
            &quot;MeterType&quot;: &quot;Model 3&quot;
            }"
            style={{height: "100px"}}
            value={bootNotification || ""}
            onChange={(e) => setBootNotification(e.target.value)
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
