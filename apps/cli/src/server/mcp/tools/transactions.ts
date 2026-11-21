import { z } from "zod";
import type { McpServer } from "mcp-lite";
import { METHODS } from "@ocpp-cp-simulator/contracts/index";
import {
  ID_TOKEN_TYPE_VALUES,
  STOP_REASONS,
  TRANSACTION_CHARGING_STATES,
  TRANSACTION_EVENT_TRIGGER_REASONS,
} from "@ocpp-cp-simulator/core/cp/domain/connector/Transaction";
import { runRpc } from "../../socketServer";
import type { RuntimeSocketIoDeps } from "../../socketServer";
import { successResult, errorResult } from "./result";

export function registerTransactionTools(
  mcp: McpServer,
  deps: RuntimeSocketIoDeps,
): void {
  mcp.tool("start_transaction", {
    description:
      "Start a transaction on a connector. tagId is optional (#299): when omitted, the charge point draws one from its idTagPool, falling back to a default idTag if it has none.",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
      connector: z.number().int().min(1).describe("Connector identifier"),
      tagId: z
        .string()
        .optional()
        .describe(
          "RFID tag or user ID for authorization. Omit to draw from the charge point's idTagPool",
        ),
      triggerReason: z
        .enum(TRANSACTION_EVENT_TRIGGER_REASONS)
        .optional()
        .describe(
          "OCPP 2.x TransactionEvent(Started) triggerReason (#335); default Authorized. Ignored on OCPP 1.6",
        ),
      chargingState: z
        .enum(TRANSACTION_CHARGING_STATES)
        .optional()
        .describe(
          "OCPP 2.x TransactionEvent(Started) chargingState (#335); default Charging. Ignored on OCPP 1.6",
        ),
      idTokenType: z
        .enum(ID_TOKEN_TYPE_VALUES)
        .optional()
        .describe(
          "OCPP 2.x IdToken.type of the transaction's Authorize and TransactionEvents (#599); default ISO14443. Ignored on OCPP 1.6",
        ),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          cpId: args.cpId,
          method: "start_transaction",
          params: {
            connector: args.connector,
            tagId: args.tagId,
            triggerReason: args.triggerReason,
            chargingState: args.chargingState,
            idTokenType: args.idTokenType,
          },
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("stop_transaction", {
    description:
      "Stop a transaction on a connector. reason (#335) accepts both the OCPP 1.6 StopTransaction.req and the 2.0.1 stoppedReason vocabularies.",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
      connector: z.number().int().min(1).describe("Connector identifier"),
      reason: z
        .enum(STOP_REASONS)
        .optional()
        .describe(
          "StopTransaction.req reason (1.6) / TransactionEvent(Ended) stoppedReason (2.x); default Local",
        ),
      triggerReason: z
        .enum(TRANSACTION_EVENT_TRIGGER_REASONS)
        .optional()
        .describe(
          "OCPP 2.x TransactionEvent(Ended) triggerReason; default StopAuthorized. Ignored on OCPP 1.6",
        ),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          cpId: args.cpId,
          method: "stop_transaction",
          params: {
            connector: args.connector,
            reason: args.reason,
            triggerReason: args.triggerReason,
          },
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("authorize", {
    description:
      "Authorize a tag or user. tagId is optional (#299): when omitted, the charge point draws one from its idTagPool, falling back to a default idTag if it has none.",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
      tagId: z
        .string()
        .optional()
        .describe(
          "RFID tag or user ID to authorize. Omit to draw from the charge point's idTagPool",
        ),
      idTokenType: z
        .enum(ID_TOKEN_TYPE_VALUES)
        .optional()
        .describe(
          "OCPP 2.x IdToken.type of the Authorize.req (#599); default ISO14443. Ignored on OCPP 1.6",
        ),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          cpId: args.cpId,
          method: "authorize",
          params: {
            tagId: args.tagId,
            idTokenType: args.idTokenType,
          },
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("send_ocpp_call", {
    description:
      "Expert OCPP call (#389): send any station-initiated OCPP CALL (e.g. Heartbeat, StatusNotification, MeterValues, DataTransfer) of the charge point's OCPP-J version with the payload as given, and return the CSMS's CALLRESULT or CALLERROR with the frame as sent. The payload must pass the OCPP schema unless skipValidation is set; the answer changes the charge point's state only with applyResponse. SOAP charge points are refused.",
    // The method's own schema, so the tool advertises what it enforces.
    inputSchema: METHODS.send_ocpp_call.params.extend({
      cpId: z.string().describe("Charge point identifier"),
    }),
    handler: async ({ cpId, ...params }) => {
      try {
        const result = await runRpc(deps, {
          cpId,
          method: "send_ocpp_call",
          params,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("send_raw_frame", {
    description:
      'Expert raw frame (#393): write one text frame to the charge point\'s WebSocket exactly as given, valid OCPP-J or not (wrong message type id, missing or extra element, non-string id, invalid JSON, any text), to see how the CSMS reacts. Returns the reply correlated best effort (a CALLRESULT/CALLERROR with the frame\'s id, or a CALLERROR with id "" or "-1") within waitMs, or reply null, and the close cause if the CSMS closed the socket. Bypasses the OCPP 1.6 one-CALL-in-flight queue. SOAP charge points are refused.',
    inputSchema: METHODS.send_raw_frame.params.extend({
      cpId: z.string().describe("Charge point identifier"),
    }),
    handler: async ({ cpId, ...params }) => {
      try {
        const result = await runRpc(deps, {
          cpId,
          method: "send_raw_frame",
          params,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("set_response_override", {
    description:
      "Control what the charge point answers a CSMS CALL with (#1090), instead of its engine's answer. Arms an override for `action`; the next `times` CALLs of it (default 1), or every one with persistent, get it. mode: status (CALLRESULT { status }), callError (errorCode/errorDescription/errorDetails), callResult (`payload` written as given, schema-valid or not), raw (`frame` written as given), callResultError (an OCPP 2.1 CALLRESULTERROR frame with the CALL's id), delay (the normal answer, delayMs late) or noAnswer (never answer). delayMs also holds back any other answer. The override answers before the station's own handlers and before inbound validation. Arming again replaces the one for the action; cleared by clear_response_overrides or a reset.",
    inputSchema: METHODS.set_response_override.params.extend({
      cpId: z.string().describe("Charge point identifier"),
    }),
    handler: async ({ cpId, ...params }) => {
      try {
        const result = await runRpc(deps, {
          cpId,
          method: "set_response_override",
          params,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("clear_response_overrides", {
    description:
      "Drop the response overrides armed with set_response_override (#1090): all of them, or only the one for `action`. Returns how many were dropped.",
    inputSchema: METHODS.clear_response_overrides.params.extend({
      cpId: z.string().describe("Charge point identifier"),
    }),
    handler: async ({ cpId, ...params }) => {
      try {
        const result = await runRpc(deps, {
          cpId,
          method: "clear_response_overrides",
          params,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("send_call_result_error", {
    description:
      "Send an OCPP 2.1 CALLRESULTERROR (RPC message type 5, #1090): the charge point's answer to a CALLRESULT it cannot accept, for the CALL with `messageId` (send_ocpp_call results carry it). errorCode defaults to FormatViolation. OCPP 2.1 charge points only; nothing is awaited.",
    inputSchema: METHODS.send_call_result_error.params.extend({
      cpId: z.string().describe("Charge point identifier"),
    }),
    handler: async ({ cpId, ...params }) => {
      try {
        const result = await runRpc(deps, {
          cpId,
          method: "send_call_result_error",
          params,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("security_event_notification", {
    description:
      "Send a SecurityEventNotification (#537): OCPP 1.6 Security Whitepaper, 2.0.1 and 2.1 A04. type is the security event (e.g. FirmwareUpdated, TamperDetectionActivated), techInfo optional free text. SOAP charge points only log it. Success means written, not answered; a 2.x CALL dropped before that answers disconnected, except that a critical event sent while offline is queued (A04.FR.02) and succeeds once queued.",
    // The method's own schema, so the tool advertises what it enforces.
    inputSchema: METHODS.security_event_notification.params.extend({
      cpId: z.string().describe("Charge point identifier"),
    }),
    handler: async ({ cpId, ...params }) => {
      try {
        const result = await runRpc(deps, {
          cpId,
          method: "security_event_notification",
          params,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("get_15118_ev_certificate", {
    description:
      "Relay an EV's ISO 15118 certificate request to the CSMS with Get15118EVCertificate (#537): OCPP 2.0.1 / 2.1 M01 (Install) and M02 (Update). You stand in for the EV: exiRequest is its EXI CertificateInstallationReq / CertificateUpdateReq, base64. Returns the CSMS answers in `responses`, a CALLERROR in `callError`. With maximumContractCertificateChains (2.1, ISO 15118-20) the station repeats the request while remainingContracts > 0. OCPP 1.6 and SOAP charge points refuse it.",
    // The method's own schema, so the tool advertises what it enforces.
    inputSchema: METHODS.get_15118_ev_certificate.params.extend({
      cpId: z.string().describe("Charge point identifier"),
    }),
    handler: async ({ cpId, ...params }) => {
      try {
        const result = await runRpc(deps, {
          cpId,
          method: "get_15118_ev_certificate",
          params,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  // #452: the Authorization Cache test seam, one tool per method.
  mcp.tool("auth_cache_get", {
    description:
      "Read a charge point's Authorization Cache: whether it is enabled (1.6 AuthorizationCacheEnabled / 2.x AuthCacheCtrlr.Enabled) and every entry (idToken, status, expiresAt, parentId, insertedAt, updatedAt).",
    inputSchema: METHODS.get_auth_cache.params.extend({
      cpId: z.string().describe("Charge point identifier"),
    }),
    handler: async ({ cpId }) => {
      try {
        const result = await runRpc(deps, {
          cpId,
          method: "get_auth_cache",
          params: {},
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("auth_cache_seed", {
    description:
      "Write entries into a charge point's Authorization Cache as if the CSMS had answered them, whether or not the cache is enabled; nothing is sent to the CSMS. One entry per idToken; an invalid entry refuses the whole seed.",
    inputSchema: METHODS.seed_auth_cache.params.extend({
      cpId: z.string().describe("Charge point identifier"),
    }),
    handler: async ({ cpId, ...params }) => {
      try {
        const result = await runRpc(deps, {
          cpId,
          method: "seed_auth_cache",
          params,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("auth_cache_clear", {
    description:
      "Empty a charge point's Authorization Cache, whether or not it is enabled; nothing is sent to the CSMS (the CSMS's ClearCache follows the OCPP rules instead).",
    inputSchema: METHODS.clear_auth_cache.params.extend({
      cpId: z.string().describe("Charge point identifier"),
    }),
    handler: async ({ cpId }) => {
      try {
        const result = await runRpc(deps, {
          cpId,
          method: "clear_auth_cache",
          params: {},
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
