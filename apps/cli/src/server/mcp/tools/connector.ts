import { z } from "zod";
import type { McpServer } from "mcp-lite";
import { METHODS } from "@ocpp-cp-simulator/contracts/index";
import { runRpc } from "../../socketServer";
import type { RuntimeSocketIoDeps } from "../../socketServer";
import { METER_READING_CONTEXTS } from "@ocpp-cp-simulator/core/cp/domain/connector/Transaction";
import { successResult, errorResult } from "./result";

export function registerConnectorTools(
  mcp: McpServer,
  deps: RuntimeSocketIoDeps,
): void {
  mcp.tool("set_connector_status", {
    description: "Update the status of a connector",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
      // Taken from the method so the tool advertises what it enforces (#383).
      connector:
        METHODS.update_connector_status.params.shape.connector.describe(
          "Connector identifier (0 for all)",
        ),
      status: METHODS.update_connector_status.params.shape.status.describe(
        "Connector status (e.g. Available, Charging, Faulted)",
      ),
      errorCode: z
        .string()
        .optional()
        .describe("Optional error code if status is Faulted"),
      info: z.string().optional().describe("Optional free-form status info"),
      vendorErrorCode: z
        .string()
        .optional()
        .describe("Optional vendor-specific error code"),
      vendorId: z
        .string()
        .optional()
        .describe("Optional vendor id for vendorErrorCode"),
      timestamp:
        METHODS.update_connector_status.params.shape.timestamp.describe(
          "Optional ISO 8601 timestamp for the status change",
        ),
      suppressChargingStateTransactionEvent: z
        .boolean()
        .optional()
        .describe(
          "OCPP 2.x only: suppress the TransactionEvent a charging-state change would otherwise send",
        ),
      allowInvalidTransition: z
        .boolean()
        .optional()
        .describe(
          "Send the StatusNotification even when the charge point's capabilityProfile sets statusTransitions enforce and this change is not in the OCPP 1.6 section 4.9 transition table",
        ),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          cpId: args.cpId,
          method: "update_connector_status",
          params: {
            connector: args.connector,
            status: args.status,
            errorCode: args.errorCode,
            info: args.info,
            vendorErrorCode: args.vendorErrorCode,
            vendorId: args.vendorId,
            timestamp: args.timestamp,
            suppressChargingStateTransactionEvent:
              args.suppressChargingStateTransactionEvent,
            allowInvalidTransition: args.allowInvalidTransition,
          },
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("ev_disconnected", {
    description:
      "Unplug the cable on the EV side of a connector. With a running transaction, StopTransactionOnEVSideDisconnect stops it (EVDisconnected) or suspends it (SuspendedEV); without one a Preparing, Finishing or suspended connector goes Available (a Reserved, Faulted or Unavailable one keeps its status)",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
      connector: METHODS.ev_disconnected.params.shape.connector.describe(
        "Connector identifier",
      ),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          cpId: args.cpId,
          method: "ev_disconnected",
          params: { connector: args.connector },
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("set_meter_value", {
    description: "Set the meter value for a connector",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
      connector: z.number().int().min(1).describe("Connector identifier"),
      value: z.number().int().min(0).describe("Meter value in Wh"),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          cpId: args.cpId,
          method: "set_meter_value",
          params: {
            connector: args.connector,
            value: args.value,
          },
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("send_meter_value", {
    description: "Send the current meter value for a connector",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
      connector: z.number().int().min(1).describe("Connector identifier"),
      context: z
        .enum(METER_READING_CONTEXTS)
        .optional()
        .describe(
          "sampledValue.context the readings carry (#335); default Sample.Periodic",
        ),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          cpId: args.cpId,
          method: "send_meter_value",
          params: {
            connector: args.connector,
            context: args.context,
          },
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
