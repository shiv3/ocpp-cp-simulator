import { z } from "zod";
import type { McpServer } from "mcp-lite";
import {
  blueprintSchema,
  fleetCreateParamsSchema,
  fleetTemplateSchema,
} from "@ocpp-cp-simulator/contracts/index";
import { runRpc } from "../../socketServer";
import type { RuntimeSocketIoDeps } from "../../socketServer";
import { successResult, errorResult } from "./result";

export function registerFleetTools(
  mcp: McpServer,
  deps: RuntimeSocketIoDeps,
): void {
  mcp.tool("blueprint_list", {
    description:
      "List the stored charge point blueprints: named, reusable hardware descriptions that cp_create_many can instantiate by id.",
    inputSchema: z.object({}),
    handler: async () => {
      try {
        return successResult(
          await runRpc(deps, { method: "blueprint.list", params: {} }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("blueprint_save", {
    description:
      "Create or replace a charge point blueprint. A blueprint is the hardware half (what a charge point is); a scenario is the behaviour half (what it does). Instantiate one with cp_create_many { blueprintId, count, idPattern }.",
    inputSchema: z.object({ blueprint: blueprintSchema }),
    handler: async (args) => {
      try {
        return successResult(
          await runRpc(deps, { method: "blueprint.save", params: args }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("fleet_template_list", {
    description:
      "List the fleet templates: reusable descriptions of a whole heterogeneous fleet (blueprint + scenario template + overrides per charge point, grouped by site) that fleet_create instantiates. Includes templates loaded from --fleet-template files.",
    inputSchema: z.object({}),
    handler: async (args) => {
      try {
        return successResult(
          await runRpc(deps, { method: "fleet.template.list", params: args }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("fleet_template_get", {
    description: "Get one fleet template by id.",
    inputSchema: z.object({ id: z.string().min(1) }),
    handler: async (args) => {
      try {
        return successResult(
          await runRpc(deps, { method: "fleet.template.get", params: args }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("fleet_template_save", {
    description:
      "Create or replace a fleet template. It references blueprints and scenario templates by id and adds per-charge-point overrides; it does not copy their definitions. Unknown references are reported by fleet_create, not here. A template from a --fleet-template file cannot be replaced.",
    inputSchema: z.object({ template: fleetTemplateSchema }),
    handler: async (args) => {
      try {
        return successResult(
          await runRpc(deps, { method: "fleet.template.save", params: args }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("fleet_template_delete", {
    description:
      "Delete a stored fleet template. Fleets already created from it are not affected.",
    inputSchema: z.object({ id: z.string().min(1) }),
    handler: async (args) => {
      try {
        return successResult(
          await runRpc(deps, { method: "fleet.template.delete", params: args }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("fleet_create", {
    description:
      "Create every charge point of a fleet template. Charge points are independent of the template afterwards. The template is resolved completely before anything is created (unknown blueprint, scenario template or a repeated id fails the call with nothing created); after that, partial failure is a normal result: created and failed (with the reason) are returned in template order.",
    inputSchema: fleetCreateParamsSchema,
    handler: async (args) => {
      try {
        return successResult(
          await runRpc(deps, { method: "fleet.create", params: args }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
