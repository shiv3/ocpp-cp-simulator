import { McpServer, StreamableHttpTransport } from "mcp-lite";
import { z } from "zod";
import { registerTools } from "./tools";
import type { RuntimeSocketIoDeps } from "../socketServer";
import { appVersion } from "../../appVersion";

export function createMcpHandler(
  deps: RuntimeSocketIoDeps,
): (req: Request) => Promise<Response> {
  const mcp = new McpServer({
    name: "ocpp-cp-simulator",
    // Reported as serverInfo.version on initialize. Was a hard-coded "0.0.0",
    // so an MCP client could not tell which build it was driving.
    version: appVersion(),
    schemaAdapter: (schema) => z.toJSONSchema(schema as z.ZodType),
    logger: {
      error: console.error,
      warn: console.warn,
      info: () => {},
      debug: () => {},
    },
  });

  registerTools(mcp, deps);

  const transport = new StreamableHttpTransport();
  return transport.bind(mcp);
}
