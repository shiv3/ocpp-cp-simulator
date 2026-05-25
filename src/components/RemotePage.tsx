import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useDataContext } from "../data/providers/DataProvider";
import { useRemoteChargePointService } from "../data/hooks/useRemoteChargePointService";
import type {
  ChargePointEvent,
  ChargePointSnapshot,
} from "../data/interfaces/ChargePointService";
import { OCPPStatus } from "../cp/domain/types/OcppTypes";

const STATUS_OPTIONS: OCPPStatus[] = [
  OCPPStatus.Available,
  OCPPStatus.Preparing,
  OCPPStatus.Charging,
  OCPPStatus.SuspendedEVSE,
  OCPPStatus.SuspendedEV,
  OCPPStatus.Finishing,
  OCPPStatus.Reserved,
  OCPPStatus.Unavailable,
  OCPPStatus.Faulted,
];

const MAX_EVENT_LOG = 200;

interface EventLogEntry {
  ts: string;
  text: string;
}

const RemotePage: React.FC = () => {
  const { mode, serverUrl, setMode, setServerUrl } = useDataContext();
  const service = useRemoteChargePointService();

  const [draftUrl, setDraftUrl] = useState(serverUrl);
  useEffect(() => setDraftUrl(serverUrl), [serverUrl]);

  const [cps, setCps] = useState<ChargePointSnapshot[]>([]);
  const [selectedCpId, setSelectedCpId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [healthInfo, setHealthInfo] = useState<{
    ok: boolean;
    cps: number;
  } | null>(null);

  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const eventsRef = useRef<EventLogEntry[]>([]);
  eventsRef.current = events;

  // Per-connector form state
  const [tagIdInput, setTagIdInput] = useState("TAG001");
  const [meterValueInput, setMeterValueInput] = useState(0);
  const [statusSelect, setStatusSelect] = useState<OCPPStatus>(
    OCPPStatus.Available,
  );

  // New CP form state
  const [newCpId, setNewCpId] = useState("");
  const [newCpWsUrl, setNewCpWsUrl] = useState("ws://localhost:9000/ocpp");
  const [newCpConnectors, setNewCpConnectors] = useState(1);
  const [newCpAutoConnect, setNewCpAutoConnect] = useState(true);

  const handleError = useCallback((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    setErrorMessage(msg);
    // surface to console too for easier debugging
    console.error("[RemotePage]", err);
  }, []);

  const refreshList = useCallback(async () => {
    if (!service) return;
    try {
      const [health, list] = await Promise.all([
        service.ping(),
        service.listChargePoints(),
      ]);
      setHealthInfo(health);
      setCps(list);
      setErrorMessage(null);
      // Auto-select first CP if none selected or selection disappeared
      setSelectedCpId((prev) => {
        if (prev && list.some((c) => c.id === prev)) return prev;
        return list[0]?.id ?? null;
      });
    } catch (err) {
      handleError(err);
      setHealthInfo(null);
      setCps([]);
    }
  }, [service, handleError]);

  useEffect(() => {
    if (!service) return;
    void refreshList();
  }, [service, refreshList]);

  // Subscribe to events of the selected CP
  useEffect(() => {
    if (!service || !selectedCpId) return;
    setEvents([]);

    const unsub = service.subscribe(selectedCpId, (evt: ChargePointEvent) => {
      const ts = new Date().toISOString().slice(11, 23);
      const text = formatEvent(evt);
      setEvents((prev) => {
        const next = [{ ts, text }, ...prev];
        return next.slice(0, MAX_EVENT_LOG);
      });

      // Refresh status snapshot on connection or status changes for live update
      if (
        evt.type === "connected" ||
        evt.type === "disconnected" ||
        evt.type === "status" ||
        evt.type === "connector-status" ||
        evt.type === "connector-transaction" ||
        evt.type === "connector-meter"
      ) {
        void service
          .getChargePoint(selectedCpId)
          .then((s) => {
            if (!s) return;
            setCps((prev) => prev.map((c) => (c.id === s.id ? s : c)));
          })
          .catch(() => {});
      }
    });
    return () => unsub();
  }, [service, selectedCpId]);

  const selectedCp = useMemo(
    () => cps.find((c) => c.id === selectedCpId) ?? null,
    [cps, selectedCpId],
  );

  const onSwitchToRemote = () => setMode("remote");
  const onSwitchToLocal = () => setMode("local");
  const onApplyUrl = () => setServerUrl(draftUrl);

  const onCreateCp = async () => {
    if (!service || !newCpId.trim()) return;
    try {
      await service.createChargePoint({
        cpId: newCpId.trim(),
        wsUrl: newCpWsUrl.trim(),
        connectors: newCpConnectors,
        autoConnect: newCpAutoConnect,
      });
      setNewCpId("");
      await refreshList();
    } catch (err) {
      handleError(err);
    }
  };

  const onDeleteCp = async () => {
    if (!service || !selectedCpId) return;
    try {
      await service.deleteChargePoint(selectedCpId);
      setSelectedCpId(null);
      await refreshList();
    } catch (err) {
      handleError(err);
    }
  };

  const runOnSelected =
    (fn: (id: string) => Promise<unknown>): (() => Promise<void>) =>
    async () => {
      if (!service || !selectedCpId) return;
      try {
        await fn(selectedCpId);
      } catch (err) {
        handleError(err);
      }
    };

  return (
    <div className="container mx-auto px-4 py-4 space-y-4 text-gray-900 dark:text-gray-100">
      <header className="flex flex-wrap items-center gap-3 justify-between">
        <h1 className="text-2xl font-bold">Remote Server Control</h1>
        <div className="flex items-center gap-2">
          <span className="text-sm">Mode:</span>
          <button
            className={`px-3 py-1 rounded ${
              mode === "local"
                ? "bg-blue-600 text-white"
                : "bg-gray-200 dark:bg-gray-700"
            }`}
            onClick={onSwitchToLocal}
          >
            Local
          </button>
          <button
            className={`px-3 py-1 rounded ${
              mode === "remote"
                ? "bg-blue-600 text-white"
                : "bg-gray-200 dark:bg-gray-700"
            }`}
            onClick={onSwitchToRemote}
          >
            Remote
          </button>
        </div>
      </header>

      <section className="bg-white dark:bg-gray-800 rounded shadow p-4 space-y-3">
        <h2 className="text-lg font-semibold">Server</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col text-sm flex-1 min-w-[240px]">
            <span>Base URL</span>
            <input
              className="px-2 py-1 border rounded bg-white dark:bg-gray-900 dark:border-gray-700"
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.target.value)}
              placeholder="http://127.0.0.1:9700"
            />
          </label>
          <button
            className="px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            onClick={onApplyUrl}
          >
            Apply
          </button>
          <button
            className="px-3 py-2 bg-gray-200 dark:bg-gray-700 rounded"
            onClick={refreshList}
            disabled={!service}
          >
            Refresh
          </button>
        </div>
        {mode === "remote" ? (
          <div className="text-sm text-gray-600 dark:text-gray-400">
            {healthInfo
              ? `Server reachable. ${healthInfo.cps} charge point${
                  healthInfo.cps === 1 ? "" : "s"
                } registered.`
              : "Not connected yet."}
          </div>
        ) : (
          <div className="text-sm text-amber-700 dark:text-amber-300">
            Local mode is active. Switch to Remote to operate the server.
          </div>
        )}
        {errorMessage && (
          <div className="text-sm text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/30 rounded px-2 py-1">
            {errorMessage}
          </div>
        )}
      </section>

      {mode === "remote" && (
        <>
          <section className="bg-white dark:bg-gray-800 rounded shadow p-4 space-y-3">
            <h2 className="text-lg font-semibold">Charge Points</h2>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col text-sm">
                <span>Select</span>
                <select
                  className="px-2 py-1 border rounded bg-white dark:bg-gray-900 dark:border-gray-700"
                  value={selectedCpId ?? ""}
                  onChange={(e) => setSelectedCpId(e.target.value || null)}
                >
                  <option value="">(none)</option>
                  {cps.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.id} — {c.status}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="px-3 py-2 bg-red-600 text-white rounded disabled:opacity-50"
                onClick={onDeleteCp}
                disabled={!selectedCpId}
              >
                Delete
              </button>
            </div>

            <div className="border-t border-gray-200 dark:border-gray-700 pt-3 space-y-2">
              <h3 className="font-semibold">Add Charge Point</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="flex flex-col text-sm">
                  <span>cpId</span>
                  <input
                    className="px-2 py-1 border rounded bg-white dark:bg-gray-900 dark:border-gray-700"
                    value={newCpId}
                    onChange={(e) => setNewCpId(e.target.value)}
                    placeholder="CP001"
                  />
                </label>
                <label className="flex flex-col text-sm">
                  <span>wsUrl</span>
                  <input
                    className="px-2 py-1 border rounded bg-white dark:bg-gray-900 dark:border-gray-700"
                    value={newCpWsUrl}
                    onChange={(e) => setNewCpWsUrl(e.target.value)}
                  />
                </label>
                <label className="flex flex-col text-sm">
                  <span>Connectors</span>
                  <input
                    type="number"
                    min={1}
                    className="px-2 py-1 border rounded bg-white dark:bg-gray-900 dark:border-gray-700"
                    value={newCpConnectors}
                    onChange={(e) =>
                      setNewCpConnectors(Math.max(1, Number(e.target.value)))
                    }
                  />
                </label>
                <label className="flex items-center gap-2 text-sm mt-4">
                  <input
                    type="checkbox"
                    checked={newCpAutoConnect}
                    onChange={(e) => setNewCpAutoConnect(e.target.checked)}
                  />
                  <span>Auto-connect on create</span>
                </label>
              </div>
              <button
                className="px-3 py-2 bg-blue-600 text-white rounded disabled:opacity-50"
                onClick={onCreateCp}
                disabled={!service || !newCpId.trim()}
              >
                Create
              </button>
            </div>
          </section>

          {selectedCp && service && (
            <section className="bg-white dark:bg-gray-800 rounded shadow p-4 space-y-4">
              <h2 className="text-lg font-semibold">
                CP: {selectedCp.id}{" "}
                <span className="text-sm font-normal text-gray-600 dark:text-gray-400">
                  ({selectedCp.status})
                </span>
              </h2>
              {selectedCp.error && (
                <div className="text-sm text-red-700 dark:text-red-400">
                  Error: {selectedCp.error}
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <button
                  className="px-3 py-2 bg-emerald-600 text-white rounded"
                  onClick={runOnSelected((id) => service.connect(id))}
                >
                  Connect
                </button>
                <button
                  className="px-3 py-2 bg-gray-600 text-white rounded"
                  onClick={runOnSelected((id) => service.disconnect(id))}
                >
                  Disconnect
                </button>
                <button
                  className="px-3 py-2 bg-gray-200 dark:bg-gray-700 rounded"
                  onClick={runOnSelected((id) => service.sendHeartbeat(id))}
                >
                  Heartbeat
                </button>
                <button
                  className="px-3 py-2 bg-gray-200 dark:bg-gray-700 rounded"
                  onClick={runOnSelected((id) => service.reset(id))}
                >
                  Reset
                </button>
              </div>

              <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col text-sm">
                  <span>Tag ID</span>
                  <input
                    className="px-2 py-1 border rounded bg-white dark:bg-gray-900 dark:border-gray-700"
                    value={tagIdInput}
                    onChange={(e) => setTagIdInput(e.target.value)}
                  />
                </label>
                <button
                  className="px-3 py-2 bg-blue-600 text-white rounded"
                  onClick={runOnSelected((id) =>
                    service.authorize(id, tagIdInput),
                  )}
                >
                  Authorize
                </button>
              </div>

              <div className="space-y-3">
                <h3 className="font-semibold">Connectors</h3>
                {selectedCp.connectors.length === 0 && (
                  <div className="text-sm text-gray-500">No connectors.</div>
                )}
                {selectedCp.connectors.map((c) => (
                  <div
                    key={c.id}
                    className="border border-gray-200 dark:border-gray-700 rounded p-3 space-y-2"
                  >
                    <div className="flex flex-wrap gap-4 text-sm">
                      <span>
                        <strong>#{c.id}</strong>
                      </span>
                      <span>Status: {c.status}</span>
                      <span>Availability: {c.availability}</span>
                      <span>Meter: {c.meterValue} Wh</span>
                      {c.transactionId != null && (
                        <span>TX: {c.transactionId}</span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                      <button
                        className="px-3 py-2 bg-emerald-600 text-white rounded"
                        onClick={runOnSelected((id) =>
                          service.startTransaction(id, c.id, tagIdInput),
                        )}
                      >
                        Start Tx
                      </button>
                      <button
                        className="px-3 py-2 bg-amber-600 text-white rounded"
                        onClick={runOnSelected((id) =>
                          service.stopTransaction(id, c.id),
                        )}
                      >
                        Stop Tx
                      </button>
                      <label className="flex items-center gap-2 text-sm">
                        <span>Set status</span>
                        <select
                          className="px-2 py-1 border rounded bg-white dark:bg-gray-900 dark:border-gray-700"
                          value={statusSelect}
                          onChange={(e) =>
                            setStatusSelect(e.target.value as OCPPStatus)
                          }
                        >
                          {STATUS_OPTIONS.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                        <button
                          className="px-3 py-2 bg-gray-600 text-white rounded"
                          onClick={runOnSelected((id) =>
                            service.sendStatusNotification(
                              id,
                              c.id,
                              statusSelect,
                            ),
                          )}
                        >
                          Apply
                        </button>
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <span>Meter (Wh)</span>
                        <input
                          type="number"
                          className="px-2 py-1 border rounded bg-white dark:bg-gray-900 dark:border-gray-700 w-28"
                          value={meterValueInput}
                          onChange={(e) =>
                            setMeterValueInput(Number(e.target.value))
                          }
                        />
                        <button
                          className="px-3 py-2 bg-gray-600 text-white rounded"
                          onClick={runOnSelected((id) =>
                            service.setMeterValue(id, c.id, meterValueInput),
                          )}
                        >
                          Set
                        </button>
                        <button
                          className="px-3 py-2 bg-gray-600 text-white rounded"
                          onClick={runOnSelected((id) =>
                            service.sendMeterValue(id, c.id),
                          )}
                        >
                          Send
                        </button>
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="bg-white dark:bg-gray-800 rounded shadow p-4 space-y-2">
            <h2 className="text-lg font-semibold">Events</h2>
            {events.length === 0 ? (
              <div className="text-sm text-gray-500">No events yet.</div>
            ) : (
              <pre className="text-xs max-h-72 overflow-auto bg-gray-50 dark:bg-gray-900 rounded p-2">
                {events.map((e, i) => (
                  <div key={i}>
                    [{e.ts}] {e.text}
                  </div>
                ))}
              </pre>
            )}
          </section>
        </>
      )}
    </div>
  );
};

function formatEvent(evt: ChargePointEvent): string {
  switch (evt.type) {
    case "connected":
      return "connected";
    case "disconnected":
      return `disconnected (code=${evt.code} reason=${evt.reason})`;
    case "status":
      return `status: ${evt.status}`;
    case "error":
      return `error: ${evt.error}`;
    case "connector-status":
      return `connector ${evt.connectorId}: ${evt.previousStatus} -> ${evt.status}`;
    case "connector-transaction":
      return evt.transactionId == null
        ? `connector ${evt.connectorId} transaction stopped`
        : `connector ${evt.connectorId} transaction started: ${evt.transactionId}`;
    case "connector-meter":
      return `connector ${evt.connectorId} meter: ${evt.meterValue} Wh`;
    case "log":
      return `[log] ${evt.entry.type}: ${evt.entry.message}`;
    default:
      return JSON.stringify(evt);
  }
}

export default RemotePage;
