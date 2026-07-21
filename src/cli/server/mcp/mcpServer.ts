import { McpServer, StreamableHttpTransport } from "mcp-lite";
import { z } from "zod";
import { registerTools } from "./tools";
import type { RuntimeSocketIoDeps } from "../socketServer";

export function createMcpHandler(
  deps: RuntimeSocketIoDeps,
): (req: Request) => Promise<Response> {
  const mcp = new McpServer({
    name: "ocpp-cp-simulator",
    version: "0.0.0",
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
