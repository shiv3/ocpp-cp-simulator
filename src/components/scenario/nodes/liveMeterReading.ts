import { createContext } from "react";

/**
 * The connector's live meter reading in Wh, shown on every Meter Value node
 * in place of its configured value; `null` until the connector reports one,
 * and always without a connector (a library scenario). Provided by
 * `ScenarioEditor`. It stays out of the nodes' data so that a reading is not
 * a graph edit: no undo entry, no unsaved change.
 */
export const LiveMeterReadingContext = createContext<number | null>(null);
