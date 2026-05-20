import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import {
  clearConfigHashAtom,
  configAtom,
  nextCopyName,
  nextSettingName,
  profilesStateAtom,
  saveActiveProfileConfigAtom,
  setActiveProfileIdAtom,
  type Config,
} from "../store/store.ts";
import { useAtom, useSetAtom } from "jotai/index";
import {
  Badge,
  Button,
  HelperText,
  Label,
  Select,
  TextInput,
} from "flowbite-react";
import { DefaultBootNotification } from "../cp/OcppTypes.ts";
import { useNavigate } from "react-router-dom";
import { buildFullOcppUrl, parseFullOcppUrl } from "../utils/ocppUrl.ts";

const Settings: React.FC = () => {
  const [wsURL, setWsURL] = useState<string>("");
  const [connectorNumber, setConnectorNumber] = useState<number>(2);
  const [cpID, setCpID] = useState<string>("");
  const [tagID, setTagID] = useState<string>("");
  const [ocppVersion, setOcppVersion] = useState<string>("OCPP-1.6J");

  const [authToken, setAuthToken] = useState<string>("");

  const [basicAuthEnabled, setBasicAuthEnabled] = useState<boolean>(false);
  const [basicAuthUsername, setBasicAuthUsername] = useState<string>("");
  const [basicAuthPassword, setBasicAuthPassword] = useState<string>("");

  const [autoMeterValueEnabled, setAutoMeterValueEnabled] =
    useState<boolean>(false);
  const [autoMeterValueInterval, setAutoMeterValueInterval] =
    useState<number>(0);
  const [autoMeterValue, setAutoMeterValue] = useState<number>(0);

  const [experimental, setExperimental] = useState<string | null>(null);
  const [bootNotification, setBootNotification] = useState<string | null>(
    JSON.stringify(DefaultBootNotification),
  );
  const [, setConfig] = useAtom(configAtom);
  const [profilesState, setProfilesState] = useAtom(profilesStateAtom);
  const saveActiveProfile = useSetAtom(saveActiveProfileConfigAtom);
  const setActiveProfileId = useSetAtom(setActiveProfileIdAtom);
  const clearConfigHash = useSetAtom(clearConfigHashAtom);
  const navigate = useNavigate();
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fullUrlDraft, setFullUrlDraft] = useState<string | null>(null);

  const composedFullUrl = useMemo(
    () =>
      buildFullOcppUrl(wsURL, cpID, authToken, {
        enabled: basicAuthEnabled,
        username: basicAuthUsername,
        password: basicAuthPassword,
      }),
    [
      wsURL,
      cpID,
      authToken,
      basicAuthEnabled,
      basicAuthUsername,
      basicAuthPassword,
    ],
  );

  const displayFullUrl = fullUrlDraft ?? composedFullUrl;

  useEffect(() => {
    setFullUrlDraft(null);
  }, [
    wsURL,
    cpID,
    authToken,
    basicAuthEnabled,
    basicAuthUsername,
    basicAuthPassword,
  ]);

  useEffect(() => {
    clearConfigHash();
  }, [clearConfigHash]);

  const applyParsedFullUrl = useCallback((raw: string): boolean => {
    const parsed = parseFullOcppUrl(raw);
    if (!parsed) {
      setSaveError(
        "Invalid WebSocket URL. Use a full ws:// or wss:// URL (with ?cpid= and ?key= if needed).",
      );
      setSaveMessage(null);
      return false;
    }
    setWsURL(parsed.wsURL);
    setCpID(parsed.chargePointId);
    setAuthToken(parsed.authToken);
    setBasicAuthEnabled(parsed.basicAuthEnabled);
    setBasicAuthUsername(parsed.basicAuthUsername);
    setBasicAuthPassword(parsed.basicAuthPassword);
    setFullUrlDraft(null);
    return true;
  }, []);

  const buildConfigFromForm = useCallback((): Config => {
    return {
      wsURL,
      connectorNumber,
      ChargePointID: cpID,
      tagID,
      ocppVersion,
      authToken,
      basicAuthSettings: {
        enabled: basicAuthEnabled,
        username: basicAuthUsername,
        password: basicAuthPassword,
      },
      autoMeterValueSetting: {
        enabled: autoMeterValueEnabled,
        interval: autoMeterValueInterval,
        value: autoMeterValue,
      },
      Experimental:
        experimental && experimental !== "" ? JSON.parse(experimental) : null,
      BootNotification:
        bootNotification && bootNotification !== ""
          ? JSON.parse(bootNotification)
          : null,
    };
  }, [
    wsURL,
    connectorNumber,
    cpID,
    tagID,
    ocppVersion,
    authToken,
    basicAuthEnabled,
    basicAuthUsername,
    basicAuthPassword,
    autoMeterValueEnabled,
    autoMeterValueInterval,
    autoMeterValue,
    experimental,
    bootNotification,
  ]);

  const applyConfigToForm = useCallback((cfg: Config) => {
    setWsURL(cfg.wsURL);
    setConnectorNumber(cfg.connectorNumber);
    setCpID(cfg.ChargePointID);
    setTagID(cfg.tagID);
    setOcppVersion(cfg.ocppVersion);
    setAuthToken(cfg.authToken);
    setBasicAuthEnabled(cfg.basicAuthSettings?.enabled ?? false);
    setBasicAuthUsername(cfg.basicAuthSettings?.username ?? "");
    setBasicAuthPassword(cfg.basicAuthSettings?.password ?? "");
    setAutoMeterValueEnabled(cfg.autoMeterValueSetting?.enabled ?? false);
    setAutoMeterValueInterval(cfg.autoMeterValueSetting?.interval ?? 0);
    setAutoMeterValue(cfg.autoMeterValueSetting?.value ?? 0);
    setExperimental(cfg.Experimental ? JSON.stringify(cfg.Experimental) : null);
    setBootNotification(
      cfg.BootNotification
        ? JSON.stringify(cfg.BootNotification)
        : JSON.stringify(DefaultBootNotification),
    );
  }, []);

  const lastLoadedProfileIdRef = useRef<string | null>(null);

  // Load form when switching profile (not after Save on the same profile).
  useEffect(() => {
    const id = profilesState.activeProfileId;
    if (lastLoadedProfileIdRef.current === id) return;
    lastLoadedProfileIdRef.current = id;
    const profile = profilesState.profiles.find((p) => p.id === id);
    if (profile) applyConfigToForm(profile.config);
  }, [
    profilesState.activeProfileId,
    profilesState.profiles,
    applyConfigToForm,
  ]);

  const saveCurrentProfile = useCallback((): boolean => {
    try {
      const next = buildConfigFromForm();
      saveActiveProfile(next);
      setSaveMessage("Settings saved.");
      setSaveError(null);
      return true;
    } catch {
      setSaveMessage(null);
      setSaveError(
        "Could not save: check JSON in Experimental or Boot Notification.",
      );
      return false;
    }
  }, [buildConfigFromForm, saveActiveProfile]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!saveCurrentProfile()) return;
  };

  const handleSaveAndOpenChargePoint = () => {
    if (!saveCurrentProfile()) return;
    setConfig(buildConfigFromForm());
    navigate("/");
  };

  const handleProfileSelect = (profileId: string) => {
    if (profileId === profilesState.activeProfileId) return;
    if (!saveCurrentProfile()) return;
    setActiveProfileId(profileId);
  };

  const handleAddProfile = () => {
    if (!saveCurrentProfile()) return;
    clearConfigHash();
    const newConfig = buildConfigFromForm();
    setProfilesState((s) => {
      const id = crypto.randomUUID();
      const name = nextSettingName(s.profiles);
      return {
        ...s,
        profiles: [...s.profiles, { id, name, config: newConfig }],
        activeProfileId: id,
      };
    });
  };

  const handleDuplicateProfile = () => {
    if (!saveCurrentProfile()) return;
    clearConfigHash();
    setProfilesState((s) => {
      const active = s.profiles.find((p) => p.id === s.activeProfileId);
      if (!active) return s;
      const id = crypto.randomUUID();
      const name = nextCopyName(s.profiles, active.name);
      const copy: Config = JSON.parse(JSON.stringify(active.config)) as Config;
      return {
        ...s,
        profiles: [...s.profiles, { id, name, config: copy }],
        activeProfileId: id,
      };
    });
  };

  const handleDeleteProfile = () => {
    if (profilesState.profiles.length <= 1) return;
    if (!window.confirm("Delete this settings profile?")) return;
    clearConfigHash();
    const deleteId = profilesState.activeProfileId;
    setProfilesState((s) => {
      const rest = s.profiles.filter((p) => p.id !== deleteId);
      return { ...s, profiles: rest, activeProfileId: rest[0]!.id };
    });
  };

  const activeProfile = profilesState.profiles.find(
    (p) => p.id === profilesState.activeProfileId,
  );

  return (
    <div className="mx-auto mb-4 max-w-4xl rounded-lg bg-white px-5 py-6 shadow-md sm:px-8 sm:py-8">
      <header className="mb-8 border-b border-gray-100 pb-6">
        <h2 className="text-2xl font-bold tracking-tight text-gray-900">
          Settings
        </h2>
        <p className="mt-1 text-sm text-gray-500">
          Manage connection presets and simulator options.
        </p>
      </header>

      <section
        className="mb-8 rounded-xl border border-slate-200/90 bg-gradient-to-b from-slate-50 to-white p-5 shadow-sm sm:p-6"
        aria-labelledby="profiles-heading"
      >
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3
              id="profiles-heading"
              className="text-lg font-semibold text-gray-900"
            >
              Profiles
            </h3>
            <HelperText className="mt-1 text-sm">
              Separate presets for different backends. Switch below or from the
              header; changing profile clears a URL hash override.
            </HelperText>
          </div>
          <Badge color="info" size="sm" className="shrink-0">
            {profilesState.profiles.length} profile
            {profilesState.profiles.length === 1 ? "" : "s"}
          </Badge>
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div className="min-w-0">
            <Label htmlFor="profileSelect" value="Active profile" />
            <Select
              id="profileSelect"
              className="mt-2"
              sizing="md"
              value={profilesState.activeProfileId}
              onChange={(e) => handleProfileSelect(e.target.value)}
            >
              {profilesState.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="min-w-0">
            <Label htmlFor="profileName" value="Display name" />
            <TextInput
              id="profileName"
              className="mt-2"
              type="text"
              placeholder="Local lab, Production QA, …"
              value={activeProfile?.name ?? ""}
              onChange={(e) => {
                const name = e.target.value;
                setProfilesState((s) => ({
                  ...s,
                  profiles: s.profiles.map((p) =>
                    p.id === s.activeProfileId ? { ...p, name } : p,
                  ),
                }));
              }}
              sizing="md"
            />
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-slate-200/80 pt-5">
          <Button
            type="button"
            color="light"
            size="sm"
            onClick={handleAddProfile}
          >
            New profile
          </Button>
          <Button
            type="button"
            color="light"
            size="sm"
            onClick={handleDuplicateProfile}
          >
            Duplicate
          </Button>
          <Button
            type="button"
            color="failure"
            outline
            size="sm"
            onClick={handleDeleteProfile}
            disabled={profilesState.profiles.length <= 1}
          >
            Delete
          </Button>
        </div>
      </section>

      <form onSubmit={handleSubmit}>
        <div className="sticky top-0 z-20 -mx-5 mb-6 flex flex-wrap items-center gap-3 border-b border-gray-200 bg-white/95 px-5 py-3 shadow-sm backdrop-blur sm:-mx-8 sm:px-8">
          <button
            type="submit"
            className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-bold text-white shadow hover:bg-blue-700 focus:outline-none focus:ring-4 focus:ring-blue-300"
          >
            Save
          </button>
          <button
            type="button"
            className="rounded-lg border border-blue-600 bg-white px-4 py-2.5 text-sm font-semibold text-blue-700 hover:bg-blue-50 focus:outline-none focus:ring-4 focus:ring-blue-200"
            onClick={handleSaveAndOpenChargePoint}
          >
            Save & open ChargePoint
          </button>
          {saveMessage && (
            <span className="text-sm font-medium text-green-700" role="status">
              {saveMessage}
            </span>
          )}
          {saveError && (
            <span className="text-sm font-medium text-red-700" role="alert">
              {saveError}
            </span>
          )}
        </div>

        <h3 className="mb-4 text-base font-semibold text-gray-900">
          Connection
        </h3>
        <div className="mb-6 rounded-lg border border-blue-100 bg-blue-50/50 p-4">
          <label
            className="block text-gray-800 text-sm font-bold mb-2"
            htmlFor="fullOcppUrl"
          >
            Full WebSocket URL
          </label>
          <input
            className="shadow appearance-none border border-blue-200 rounded w-full py-2 px-3 text-gray-800 font-mono text-sm leading-tight focus:outline-none focus:ring-2 focus:ring-blue-400"
            id="fullOcppUrl"
            type="url"
            value={displayFullUrl}
            onChange={(e) => setFullUrlDraft(e.target.value)}
            onBlur={() => {
              if (fullUrlDraft !== null) applyParsedFullUrl(fullUrlDraft);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (fullUrlDraft !== null) applyParsedFullUrl(fullUrlDraft);
              }
            }}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text").trim();
              if (!text) return;
              e.preventDefault();
              setFullUrlDraft(text);
              applyParsedFullUrl(text);
            }}
            placeholder="wss://host:8080/?cpid=my-cp&key=my-api-key"
            spellCheck={false}
          />
          <p className="text-gray-600 text-xs mt-2">
            Built from the fields below (same URL used when connecting). Paste a
            full URL here to fill OCPP server, charge point ID, auth token, and
            basic auth — then press Enter or click away.
          </p>
        </div>
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
            style={{ maxWidth: "20ch" }}
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
            style={{ maxWidth: "20ch" }}
          />
        </div>
        <div className="mb-4">
          <label
            className="block text-gray-700 text-sm font-bold mb-2"
            htmlFor="AuthToken"
          >
            Auth Token
          </label>
          <input
            className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
            id="AuthToken"
            type="text"
            value={authToken}
            onChange={(e) => setAuthToken(e.target.value)}
            placeholder="authToken"
            style={{ maxWidth: "20ch" }}
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
            style={{ maxWidth: "20ch" }}
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
            style={{ maxWidth: "20ch" }}
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
              setBasicAuthEnabled(e.target.checked);
              if (!e.target.checked) {
                setBasicAuthUsername("");
                setBasicAuthPassword("");
              }
            }}
          />
          <label
            className="text-gray-700 text-sm font-bold ml-2"
            htmlFor="BasicAuth"
          >
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
                style={{ maxWidth: "20ch" }}
                required
              />
              <input
                className="shadow appearance-none border rounded w-1/3 py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
                id="BasicAuthPassword"
                type="text"
                value={basicAuthPassword}
                onChange={(e) => setBasicAuthPassword(e.target.value)}
                placeholder="password"
                style={{ maxWidth: "20ch" }}
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
              setAutoMeterValueEnabled(e.target.checked);
              if (!e.target.checked) {
                setAutoMeterValueInterval(0);
                setAutoMeterValue(0);
              }
            }}
          />
          <label
            className="text-gray-700 text-sm font-bold ml-2"
            htmlFor="AutoMeterValue"
          >
            Auto Meter Value
          </label>
          {autoMeterValueEnabled && (
            <div className="flex items-center">
              <input
                className="shadow appearance-none border rounded w-1/3 py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
                id="AutoMeterValueInterval"
                type="number"
                value={autoMeterValueInterval}
                onChange={(e) =>
                  setAutoMeterValueInterval(parseInt(e.target.value))
                }
                placeholder="30"
                style={{ maxWidth: "20ch" }}
                required
              />
              <span className="text-gray-700 text-sm font-bold ml-2">
                seconds
              </span>

              <input
                className="shadow appearance-none border rounded w-1/3 py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
                id="AutoMeterValue"
                type="number"
                value={autoMeterValue}
                onChange={(e) => setAutoMeterValue(parseInt(e.target.value))}
                placeholder="10"
                style={{ maxWidth: "20ch" }}
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
            placeholder='{
            "ChargePointIDs": [
            {
            "ChargePointID": "CP001",
            "ConnectorNumber": 1
            }
            ],
            "TagIDs": [
            "123456"
            ]
            }'
            style={{ height: "100px" }}
            value={experimental || ""}
            onChange={(e) => setExperimental(e.target.value)}
          ></textarea>
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
            placeholder='{
            "chargeBoxSerialNumber": "123456",
            "chargePointModel": "Model 3",
            "chargePointSerialNumber": "123456",
            "chargePointVendor": "Vendor",
            "firmwareVersion": "1.0.0",
            "iccid": "123456",
            "imsi": "123456",
            "meterSerialNumber": "123456",
            "meterType": "Model 3"
            }'
            style={{ height: "100px" }}
            value={bootNotification || ""}
            onChange={(e) => setBootNotification(e.target.value)}
          ></textarea>
        </div>

        <div className="sticky bottom-0 z-20 -mx-5 mt-8 flex flex-wrap items-center gap-3 border-t border-gray-200 bg-white/95 px-5 py-4 shadow-[0_-4px_12px_rgba(0,0,0,0.06)] backdrop-blur sm:-mx-8 sm:px-8">
          <button
            type="submit"
            className="rounded-lg bg-blue-600 px-6 py-3 text-base font-bold text-white shadow hover:bg-blue-700 focus:outline-none focus:ring-4 focus:ring-blue-300"
          >
            Save
          </button>
          <button
            type="button"
            className="rounded-lg border border-gray-300 bg-white px-5 py-3 text-sm font-semibold text-gray-800 hover:bg-gray-50"
            onClick={handleSaveAndOpenChargePoint}
          >
            Save & open ChargePoint
          </button>
          <p className="w-full text-xs text-gray-500 sm:w-auto">
            Saves the active profile to this browser. Use Save before switching
            profiles or leaving the page.
          </p>
        </div>
      </form>
    </div>
  );
};

export default Settings;
