import { useDataContext } from "../providers/DataProvider";
import type { RemoteChargePointService } from "../remote/RemoteChargePointService";

/**
 * Narrowed accessor for the remote service. Returns null in local mode.
 */
export function useRemoteChargePointService(): RemoteChargePointService | null {
  const { mode, chargePointService } = useDataContext();
  if (mode !== "remote") return null;
  return chargePointService as unknown as RemoteChargePointService;
}
