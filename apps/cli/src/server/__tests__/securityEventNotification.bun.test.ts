import { afterEach, describe, expect, it } from "bun:test";

import { CLIChargePointService } from "../../service";
import { handleJsonCommand } from "../../jsonMode";
import { testCpInit } from "../../__tests__/testCpInit";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createMcpHandler } from "../mcp/mcpServer";
import { createRuntimeDeps, errorCodeFrom, runRpc } from "../socketServer";

/**
 * #537: `security_event_notification` on a station that is not connected, on
 * the real path from each surface to the message handler. A 2.x CALL is
 * dropped, and every surface says so; 1.6 keeps answering success.
 */
function daemon(cpId: string, ocppVersion: string) {
  const bus = new EventBus();
  const registry = new CPRegistry(bus, null);
  registry.create(testCpInit({ cpId, ocppVersion }));
  return {
    registry,
    deps: createRuntimeDeps({ registry, bus, database: null }),
  };
}

const REQUEST = {
  method: "security_event_notification",
  params: { type: "SettingSystemTime" },
};

describe("security_event_notification on a station that is not connected", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  describe.each(["OCPP-2.0.1", "OCPP-2.1"])("%s", (version) => {
    it("answers disconnected on the control plane", async () => {
      const { registry, deps } = daemon("CP-SEC-RPC", version);
      cleanups.push(() => registry.shutdownAll());

      const error = await runRpc(deps, {
        cpId: "CP-SEC-RPC",
        ...REQUEST,
      }).catch((err: unknown) => err);

      expect(errorCodeFrom(error)).toBe("disconnected");
      expect((error as Error).message).toContain("not_connected");
    });

    it("answers disconnected on the MCP tool", async () => {
      const { registry, deps } = daemon("CP-SEC-MCP", version);
      cleanups.push(() => registry.shutdownAll());

      const response = await createMcpHandler(deps)(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "security_event_notification",
              arguments: { cpId: "CP-SEC-MCP", type: "SettingSystemTime" },
            },
          }),
        }),
      );

      // The transport answers as an event stream.
      const text = await response.text();
      const data = text.split("\n").find((line) => line.startsWith("data: "));
      const body = JSON.parse(data!.slice("data: ".length)) as {
        result: { isError: boolean; content: { text: string }[] };
      };
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0]?.text).toStartWith("disconnected: ");
    });

    it("fails in JSON Lines mode", async () => {
      const service = new CLIChargePointService(
        testCpInit({ cpId: "CP-SEC-JSON", ocppVersion: version }),
        null,
      );
      cleanups.push(() => service.cleanup());

      await expect(
        handleJsonCommand(service, {
          command: "security_event_notification",
          params: { type: "SettingSystemTime" },
        }),
      ).rejects.toThrow("not_connected");
    });
  });

  it("still answers success on 1.6, which queues it or suppresses it", async () => {
    const { registry, deps } = daemon("CP-SEC-16", "OCPP-1.6J");
    cleanups.push(() => registry.shutdownAll());

    await runRpc(deps, { cpId: "CP-SEC-16", ...REQUEST });
  });
});
