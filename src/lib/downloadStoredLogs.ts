import type { ChargePointService } from "../data/interfaces/ChargePointService";

/**
 * Downloads every persisted log row of `cpIds` (in that order) as one JSON
 * Lines file, `ocpp-logs-<label>-<timestamp>.jsonl`: one entry per line,
 * which plays well with `jq -c`, grep and log analyzers. Rejects when the
 * runtime does not expose persisted logs or a read fails, before anything is
 * downloaded.
 */
export async function downloadStoredLogs(
  service: Pick<ChargePointService, "listStoredLogs">,
  cpIds: readonly string[],
  label: string,
): Promise<void> {
  const { listStoredLogs } = service;
  if (!listStoredLogs) {
    throw new Error("this runtime does not expose persisted logs");
  }
  const perCp = await Promise.all(
    cpIds.map((cpId) => listStoredLogs.call(service, cpId)),
  );
  const body = perCp
    .flat()
    .map((row) => JSON.stringify(row) + "\n")
    .join("");
  const blob = new Blob([body], { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const a = document.createElement("a");
  a.href = url;
  a.download = `ocpp-logs-${label}-${stamp}.jsonl`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next tick: Safari aborts a download whose URL is revoked
  // before it starts.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
