import { z } from "zod";
import type { McpServer } from "mcp-lite";
import { METHODS } from "@ocpp-cp-simulator/contracts/index";
import { runRpc } from "../../socketServer";
import type { RuntimeSocketIoDeps } from "../../socketServer";
import { LogType } from "@ocpp-cp-simulator/core/cp/shared/Logger";
import { successResult, errorResult } from "./result";

export const TAIL_LOGS_DEFAULT_LINES = 50;
export const TAIL_LOGS_MAX_LINES = 1000;

const LOG_LEVEL_RANK: Record<string, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

/** The last `lines` entries that pass the filters, oldest first. */
export function tailLogEntries(
  entries: unknown,
  opts: { lines?: number; level?: string; type?: string; contains?: string },
): unknown[] {
  const all = Array.isArray(entries) ? entries : [];
  const minRank = opts.level ? LOG_LEVEL_RANK[opts.level] : undefined;
  const needle = opts.contains?.toLowerCase();
  const kept = all.filter((e) => {
    const entry = (e ?? {}) as Record<string, unknown>;
    if (minRank !== undefined) {
      // Stored entries carry the LogLevel number; accept the name as well.
      const rank =
        typeof entry.level === "number"
          ? entry.level
          : LOG_LEVEL_RANK[String(entry.level).toUpperCase()];
      if (rank === undefined || rank < minRank) return false;
    }
    if (opts.type !== undefined && entry.type !== opts.type) return false;
    if (needle !== undefined) {
      if (
        !String(entry.message ?? "")
          .toLowerCase()
          .includes(needle)
      ) {
        return false;
      }
    }
    return true;
  });
  return kept.slice(-(opts.lines ?? TAIL_LOGS_DEFAULT_LINES));
}

export function registerLogTools(
  mcp: McpServer,
  deps: RuntimeSocketIoDeps,
): void {
  mcp.tool("get_logs", {
    description:
      "Retrieve logs for a charge point. Returns the MOST RECENT entries: " +
      "`limit` takes the newest N, and `offset` pages backwards from the " +
      "newest, so {limit:100} is the last 100 and {limit:100, offset:100} the " +
      "100 before those. Entries come back oldest-first unless order is 'desc'.",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Number of most-recent log entries to return"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Skip this many of the newest entries before taking `limit`"),
      order: z
        .enum(["asc", "desc"])
        .optional()
        .describe(
          "Order of the returned window: 'asc' (oldest first, default) or 'desc' (newest first)",
        ),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          method: "logs.get",
          params: {
            cpId: args.cpId,
            limit: args.limit,
            offset: args.offset,
            order: args.order,
          },
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("tail_logs", {
    description:
      "Read the end of a charge point's log: the last `lines` entries " +
      "(default 50, at most 1000), oldest first, so the final element is the " +
      "newest. Optional filters are applied before the tail is taken: " +
      "`level` keeps entries at that level or more severe, `type` keeps " +
      "entries of one log type (e.g. OCPP, WebSocket), `contains` keeps " +
      "entries whose message contains the text (case-insensitive). Use " +
      "get_logs to page further back.",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
      lines: z
        .number()
        .int()
        .min(1)
        .max(TAIL_LOGS_MAX_LINES)
        .optional()
        .describe(
          `Number of entries to return (default ${TAIL_LOGS_DEFAULT_LINES})`,
        ),
      level: z
        .enum(["DEBUG", "INFO", "WARN", "ERROR"])
        .optional()
        .describe("Keep entries at this level or more severe"),
      type: z
        .enum(Object.values(LogType) as [LogType, ...LogType[]])
        .optional()
        .describe("Keep entries of this log type"),
      contains: z
        .string()
        .min(1)
        .optional()
        .describe("Keep entries whose message contains this text"),
    }),
    handler: async (args) => {
      try {
        const entries = await runRpc(deps, {
          method: "logs.get",
          params: { cpId: args.cpId },
        });
        return successResult(tailLogEntries(entries, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  const timeline = METHODS["timeline.get"].params.shape;
  mcp.tool("get_timeline", {
    description:
      "Retrieve a charge point's operational timeline (#448): normalized, " +
      "ordered events — connection loss and reconnect, injected network " +
      "faults and the recovery they caused, CP/connector status changes, " +
      "transactions and their rejected or discarded 2.x TransactionEvents, " +
      "authorization rejections, scenario runs and " +
      "smart-charging profiles applied, cleared or expired. Entries " +
      "are ordered by `seq`; entries of one fault share an `incidentId` and " +
      "`recovery_completed` reports `durationMs`. Windowed like get_logs: " +
      "`limit` takes the newest N, `offset` pages backwards.",
    // The method's own fields, so the tool advertises what it enforces.
    inputSchema: z.object({
      cpId: timeline.cpId.describe("Charge point identifier"),
      connectorId: timeline.connectorId.describe(
        "Only entries about this connector",
      ),
      runId: timeline.runId.describe(
        "Only entries attributed to this scenario run",
      ),
      incidentId: timeline.incidentId.describe(
        "Only entries of this network-fault incident",
      ),
      kinds: timeline.kinds.describe("Only these entry kinds"),
      limit: timeline.limit.describe(
        "Number of most-recent matching entries to return",
      ),
      offset: timeline.offset.describe(
        "Skip this many of the newest entries before taking `limit`",
      ),
      order: timeline.order.describe(
        "'asc' (oldest first, default) or 'desc' (newest first)",
      ),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          method: "timeline.get",
          params: args,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  const sessions = METHODS["sessions.list"].params.shape;
  mcp.tool("list_charging_sessions", {
    description:
      "List charging sessions (#447): one charge point's with cpId, or every " +
      "charge point's when cpId is omitted (#489; labels narrows the fleet " +
      "to a selector, startedFrom/startedTo bound the start time). One normalized record " +
      "per transaction, the same shape for OCPP 1.6 and 2.x — connector, " +
      "transaction id, idTag, start/end, duration, meter start/stop, energy " +
      "(Wh), stop reason and an outcome (active, completed, interrupted, " +
      "failed). Unknown values are null, never guessed. Newest first; no " +
      "billing or tariff data.",
    inputSchema: z.object({
      cpId: sessions.cpId.describe(
        "Charge point identifier; omit to list across the fleet",
      ),
      labels: sessions.labels.describe(
        "Fleet-wide only (not with cpId): the charge points carrying every one of these label pairs (exact match); {} or omitted = all",
      ),
      startedFrom: sessions.startedFrom.describe(
        "Only sessions that started at or after this instant (ISO 8601 with a zone)",
      ),
      startedTo: sessions.startedTo.describe(
        "Only sessions that started before this instant (ISO 8601 with a zone)",
      ),
      connectorId: sessions.connectorId.describe(
        "Only sessions on this connector",
      ),
      outcomes: sessions.outcomes.describe("Only sessions with these outcomes"),
      limit: sessions.limit.describe(
        "How many of the newest matching sessions to return (default 50)",
      ),
      offset: sessions.offset.describe(
        "Skip this many of the newest matching sessions (pages back in time)",
      ),
      order: sessions.order.describe(
        "Order of the returned page by start time: 'desc' (newest first, default) or 'asc'; it does not change which sessions are selected",
      ),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          method: "sessions.list",
          params: args,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
