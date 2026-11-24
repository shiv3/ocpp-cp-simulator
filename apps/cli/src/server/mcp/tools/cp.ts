import { z } from "zod";
import type { McpServer } from "mcp-lite";
import {
  createManyToolSchema,
  cpBulkParamsSchema,
  cpScenarioRunParamsSchema,
  cpBehaviorsSetParamsSchema,
  cpLabelsSetParamsSchema,
  cpListParamsSchema,
  createParamsSchema,
  cpProbeParamsSchema,
  METHODS,
} from "@ocpp-cp-simulator/contracts/index";
import { runRpc } from "../../socketServer";
import type { RuntimeSocketIoDeps } from "../../socketServer";
import { successResult, errorResult } from "./result";

export function registerCpTools(
  mcp: McpServer,
  deps: RuntimeSocketIoDeps,
): void {
  // #446: the selector is `cp.list`'s own schema, so the tool cannot drift
  // from the method it wraps.
  mcp.tool("cp_list", {
    description:
      'List the registered charge points with their labels. Pass labels (e.g. {"site": "lab-1"}) to return only the charge points carrying every one of those key/value pairs.',
    inputSchema: cpListParamsSchema,
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          method: "cp.list",
          params: args,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  // #284: derived from `cp.create`'s own schema rather than restating a
  // subset of it. The hand-written copy declared eight of the eighteen
  // fields, and because unknown properties are stripped rather than refused,
  // the two failure modes were both silent-ish: a SOAP charge point could not
  // be created at all (its companions vanished and the create then failed
  // `invalid_params`), and `securityProfile` / `authorizationKey` were
  // dropped while the tool answered success -- the station came up
  // authenticating differently from what the agent asked for.
  //
  // `autoConnect` used to be re-added here because the handler honoured it
  // while no schema declared it; it now lives on `createParamsSchema`, so
  // there is nothing left for this tool to add.
  mcp.tool("cp_create", {
    description:
      "Create and register a new charge point. Accepts every parameter the cp.create RPC method does, including the SOAP fields (centralSystemUrl, soapPath, soapCallbackUrl) and the OCPP 1.6 security profile fields (securityProfile, authorizationKey, tls*). It stays disconnected until cp_connect is called (or pass autoConnect: true).",
    inputSchema: createParamsSchema,
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          method: "cp.create",
          params: args,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  // #1132: the schema is `cp.probe`'s, which is `cp.create`'s plus timeoutMs,
  // so an agent can probe with the body it is about to create.
  mcp.tool("cp_probe", {
    description:
      "Check whether a charge point with these settings would get into the CSMS, without creating it: opens one WebSocket handshake exactly as the station would (id appended to the URL, the OCPP subprotocol, Basic Auth / security profile, TLS), then closes it. No OCPP message is sent and nothing is stored. Takes the cp_create parameters (plus timeoutMs) and returns a verdict { ok, code, stage, url, message, hint?, httpStatus? }; code is e.g. ok, dns_failure, connection_refused, timeout, tls_untrusted_certificate, credentials_refused, path_not_found, csms_busy, not_websocket, subprotocol_not_agreed. A refused connection is a normal result (ok: false), not an error.",
    inputSchema: cpProbeParamsSchema,
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          method: "cp.probe",
          params: args,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  // Curated tools are registered by hand, so a method added to `METHODS`
  // alone would only be reachable through the generic `call_method` escape
  // hatch. Fleet creation is exactly the operation an agent should find by
  // name, so it gets a tool -- with its schema derived, per #284.
  mcp.tool("cp_create_many", {
    description:
      "Create and register many charge points at once, either from explicit parameters or from a stored blueprint (blueprintId). Every parameter except the id is shared by the batch; ids come from idPattern ({n}, or {n:03} to zero-pad), starting at startIndex (default 1). Returns the ids created and, separately, the ones that failed with the reason -- a partial batch is a normal result, not an error.",
    inputSchema: createManyToolSchema,
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          method: "cp.create_many",
          params: args,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  // #446: relabelling gets a tool, and `cp.update` deliberately does not —
  // `cp.update` rebuilds the charge point (its socket closes and a new
  // instance takes over), which is the wrong price for changing metadata.
  mcp.tool("cp_labels_set", {
    description:
      "Replace a charge point's labels (generic key/value metadata such as site, tenant or environment) with the given map; {} removes them all. Applied in place: the charge point stays connected and running transactions continue.",
    inputSchema: cpLabelsSetParamsSchema,
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          method: "cp.labels.set",
          params: args,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  // Which loaded behaviors a charge point runs. Ids only: the tool cannot
  // carry code, and the daemon only has the behaviors its operator loaded
  // with --behavior.
  mcp.tool("cp_behaviors_set", {
    description:
      "Choose which of the daemon's loaded behaviors (see behavior_list) a charge point runs, by id; [] runs none, null runs every loaded behavior. Applied in place: the charge point stays connected. Only ids and JSON params are accepted, never code; an unknown id is an error that names the loaded ids. behaviorParams sets the knobs of behaviors (built-in default.* ones included) by id, checked against the schema behavior_list reports; a value that does not fit is refused, never converted. The selection is replaced as a whole: leave behaviorParams out and every behavior runs with its defaults.",
    inputSchema: cpBehaviorsSetParamsSchema,
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          method: "cp.behaviors.set",
          params: args,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}

export function registerCpBulkTools(
  mcp: McpServer,
  deps: RuntimeSocketIoDeps,
): void {
  // #470: a group operation is what an agent driving a fleet reaches for, and
  // `call_method` alone would hide it; schema derived from `cp.bulk`'s.
  mcp.tool("cp_bulk", {
    description:
      "Run connect, disconnect or reset on every charge point carrying all the given label pairs (exact match; at least one pair, {} is refused). Returns the matched ids, the ones that succeeded and the ones that failed with the reason -- a partial result is normal, not an error. Each charge point is waited for at most 10 s; a connect still pending then is reported as failed and keeps trying.",
    inputSchema: cpBulkParamsSchema,
    handler: async (args) => {
      try {
        const result = await runRpc(deps, { method: "cp.bulk", params: args });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  // #486: `cp_bulk`'s selector with a scenario template; schema derived from
  // `cp.scenario.run`'s.
  mcp.tool("cp_scenario_run", {
    description:
      "Run a scenario template on one connector of every charge point carrying all the given label pairs (exact match; at least one pair, {} is refused). Returns the matched ids, the ones that started (with their scenarioId, to follow with scenario_status) and the ones that failed with the reason -- a partial result is normal, not an error. Each charge point is waited for at most 10 s.",
    inputSchema: cpScenarioRunParamsSchema,
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          method: "cp.scenario.run",
          params: args,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}

export function registerCpLifecycleTools(
  mcp: McpServer,
  deps: RuntimeSocketIoDeps,
): void {
  mcp.tool("cp_delete", {
    description:
      "Delete a charge point. With stopTransactions: true its running transactions are stopped and their answers waited for first",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier to delete"),
      stopTransactions: METHODS["cp.delete"].params.shape.stopTransactions,
      reason: METHODS["cp.delete"].params.shape.reason,
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          method: "cp.delete",
          params: args,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("cp_connect", {
    description: "Connect a charge point to the central system",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          cpId: args.cpId,
          method: "connect",
          params: {},
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("cp_disconnect", {
    description:
      "Disconnect a charge point from the central system. With stopTransactions: true its running transactions are stopped and their answers waited for first",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
      stopTransactions: METHODS.disconnect.params.shape.stopTransactions,
      reason: METHODS.disconnect.params.shape.reason,
    }),
    handler: async (args) => {
      try {
        const { cpId, ...params } = args;
        const result = await runRpc(deps, {
          cpId,
          method: "disconnect",
          params,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("cp_status", {
    description: "Get the status of a charge point",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          cpId: args.cpId,
          method: "status",
          params: {},
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
