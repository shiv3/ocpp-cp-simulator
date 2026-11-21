import { transportConfigSchema } from "@ocpp-cp-simulator/contracts/transportConfig";
import { assertWsClientOptions } from "@ocpp-cp-simulator/core/cp/shared/WsClientOptions";
import type { TransportConfig } from "@ocpp-cp-simulator/core/cp/infrastructure/transport/TransportConfig";
import { isSoapVersion } from "@ocpp-cp-simulator/core/cp/domain/types/OcppVersion";

export function parseTransportFlags(
  reconnect: Record<string, number | string>,
  ws: Record<string, unknown>,
  ocppVersion: string | undefined,
): TransportConfig {
  const parsed = transportConfigSchema.safeParse({
    ...(Object.keys(reconnect).length > 0 ? { reconnect } : {}),
    ...(Object.keys(ws).length > 0 ? { ws } : {}),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    process.stderr.write(
      `Error: invalid transport flags: ${issue.path.join(".")}: ${issue.message}\n`,
    );
    process.exit(1);
  }
  if (parsed.data.ws) {
    if (isSoapVersion(ocppVersion)) {
      process.stderr.write(
        "Error: --ws-* flags apply to the OCPP-J WebSocket; the SOAP versions have none\n",
      );
      process.exit(1);
    }
    // An option this runtime would ignore stops the start, with its name.
    try {
      assertWsClientOptions(parsed.data.ws);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  }
  return parsed.data;
}
