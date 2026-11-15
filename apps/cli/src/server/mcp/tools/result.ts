import type { ToolCallResult } from "mcp-lite";
import { RpcFailure } from "@ocpp-cp-simulator/contracts/index";
import { errorCodeFrom, rpcFailureMessage } from "../../socketServer";

export function successResult(data: unknown): ToolCallResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data ?? null, null, 2),
      },
    ],
  };
}

export function errorResult(err: unknown): ToolCallResult {
  if (err instanceof RpcFailure) {
    const code = errorCodeFrom(err);
    const message = rpcFailureMessage(err);
    const text = message ? `${code}: ${message}` : code;
    return {
      content: [{ type: "text", text }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: "internal" }],
    isError: true,
  };
}
