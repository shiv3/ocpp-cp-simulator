// The DeviceDataCtrlr size limits of GetVariables / SetVariables (#606).
import type { ConfigurationStore } from "../../../domain/charge-point/ConfigurationStore";
import {
  DEVICE_DATA_CTRLR_KEYS,
  VARIABLES_REQUEST_MAX_BYTES,
  VARIABLES_REQUEST_MAX_ITEMS,
} from "../../../domain/device-model/deviceDataCtrlrKeys";
import {
  REASON,
  statusInfo,
  type VariableStatusInfo,
} from "./variableStatusInfo";

type Message = "GetVariables" | "SetVariables";

const KEYS = {
  GetVariables: {
    items: DEVICE_DATA_CTRLR_KEYS.itemsPerGetVariables,
    bytes: DEVICE_DATA_CTRLR_KEYS.bytesPerGetVariables,
  },
  SetVariables: {
    items: DEVICE_DATA_CTRLR_KEYS.itemsPerSetVariables,
    bytes: DEVICE_DATA_CTRLR_KEYS.bytesPerSetVariables,
  },
} as const;

function limit(
  store: ConfigurationStore,
  key: string,
  fallback: number,
): number {
  const value = store.get(key)?.value;
  return typeof value === "number" ? value : fallback;
}

/**
 * Why a request is over the station's limits, or `undefined`. More elements
 * than `ItemsPerMessage[<message>]` is `TooManyElements` (B05.FR.11,
 * B06.FR.05); a request longer than `BytesPerMessage[<message>]` is
 * `TooLargeElement`. The size is that of the request payload as JSON in
 * UTF-8; the OCPP-J frame around it adds a few bytes.
 *
 * The caller answers every element with `Rejected` and this reason, so the
 * response keeps one result per request element (B05.FR.01, B06.FR.01). The
 * spec allows a CALLERROR for GetVariables (B06.FR.16, FR.17) but does not
 * require one.
 */
export function variablesRequestLimitViolation(
  message: Message,
  request: unknown,
  elements: number,
  store: ConfigurationStore,
): VariableStatusInfo | undefined {
  const keys = KEYS[message];
  const maxItems = limit(store, keys.items, VARIABLES_REQUEST_MAX_ITEMS);
  if (elements > maxItems) {
    return statusInfo(
      REASON.tooManyElements,
      `${elements} elements; at most ${maxItems} per ${message} request`,
    );
  }
  const maxBytes = limit(store, keys.bytes, VARIABLES_REQUEST_MAX_BYTES);
  const bytes = new TextEncoder().encode(JSON.stringify(request)).length;
  if (bytes > maxBytes) {
    return statusInfo(
      REASON.tooLargeElement,
      `${bytes} bytes; at most ${maxBytes} per ${message} request`,
    );
  }
  return undefined;
}
